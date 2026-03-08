import Event from "SpectaclesInteractionKit.lspkg/Utils/Event"
import { setTimeout, clearTimeout } from "SpectaclesInteractionKit.lspkg/Utils/FunctionTimingUtils"
import { RemoteLogger, rlog } from "../Utils/RemoteLogger"

/**
 * HybridVoiceController — Hybrid voice bridge: native ASR input + server TTS output.
 *
 * State machine:
 *   IDLE → LISTENING → PROCESSING → RESPONDING → IDLE
 *   RESPONDING → IDLE (barge-in via external ASR trigger)
 *
 * Input: receives transcribed text from ChatASRController (on-device ASR)
 * Output: sends query.text to voice proxy, receives TTS audio + text deltas
 *
 * Audio playback uses AudioOutputProvider with AudioComponent.play(-1) pattern.
 */

export enum HybridVoiceState {
  IDLE = "idle",
  LISTENING = "listening",
  PROCESSING = "processing",
  RESPONDING = "responding",
}

@component
export class HybridVoiceController extends BaseScriptComponent {
  // ================================
  // Inspector Inputs
  // ================================

  @input("Asset.AudioTrackAsset")
  @hint("AudioTrackAsset with AudioOutputProvider for TTS playback")
  @allowUndefined
  outputTrack: AudioTrackAsset

  @input("Component.AudioComponent")
  @hint("AudioComponent for playback — must call play(-1) before enqueuing")
  @allowUndefined
  audioComponent: AudioComponent

  @input
  @hint("Voice proxy server WebSocket URL (e.g., ws://172.16.8.164:8765)")
  voiceProxyUrl: string = "ws://172.16.2.117:8765"

  // ================================
  // Events
  // ================================

  /** State changed. */
  public readonly onStateChanged = new Event<HybridVoiceState>()

  /** User's speech transcribed (echoed from proxy). */
  public readonly onTranscript = new Event<{ text: string; isFinal: boolean }>()

  /** Agent's response text (streaming). */
  public readonly onResponseDelta = new Event<{ delta: string; accumulated: string; done: boolean }>()

  /** Connection state changed. */
  public readonly onConnectionChanged = new Event<{ connected: boolean }>()

  /** Error occurred. */
  public readonly onError = new Event<string>()

  // ================================
  // State
  // ================================

  private state: HybridVoiceState = HybridVoiceState.IDLE
  private socket: WebSocket | null = null
  private internetModule: InternetModule | null = null
  private audioOutput: AudioOutputProvider | null = null
  private initialized: boolean = false
  private connected: boolean = false
  private reconnectAttempts: number = 0
  private reconnectTimerId: any = null
  private readonly maxReconnectAttempts: number = 10
  private playbackReady: boolean = false

  // Jitter buffer
  private audioQueue: Uint8Array[] = []
  private jitterBufferSize: number = 3
  private playbackStarted: boolean = false

  // ================================
  // Lifecycle
  // ================================

  onAwake(): void {
    rlog("[HybridVoice] Awake")
  }

  /**
   * Initialize the hybrid voice controller.
   */
  initialize(): void {
    if (this.initialized) return

    try {
      this.internetModule = require("LensStudio:InternetModule") as InternetModule
      rlog("[HybridVoice] InternetModule acquired")
    } catch (e) {
      rlog("[HybridVoice] ERROR: InternetModule not available: " + e)
      return
    }

    // Setup audio output
    if (this.outputTrack) {
      this.audioOutput = this.outputTrack.control as AudioOutputProvider
      if (this.audioOutput) {
        this.audioOutput.sampleRate = 16000
        rlog("[HybridVoice] AudioOutput initialized: sampleRate=16000")
      } else {
        rlog("[HybridVoice] ERROR: Could not get AudioOutputProvider from outputTrack")
      }
    } else {
      rlog("[HybridVoice] ERROR: outputTrack not set")
    }

    // Setup AudioComponent — assign track but do NOT call play(-1) yet.
    // Snap's DynamicAudioOutput calls play(-1) in initialize(), then checks
    // isPlaying() before each enqueue. We defer play(-1) to enqueueAudio()
    // to avoid buffer underrun issues when there's a gap before first TTS.
    if (this.audioComponent && this.outputTrack) {
      this.audioComponent.audioTrack = this.outputTrack
      this.playbackReady = true
      rlog("[HybridVoice] AudioComponent ready (play(-1) deferred to first enqueue)")
    } else {
      rlog("[HybridVoice] ERROR: audioComponent or outputTrack not set")
    }

    this.initialized = true
    rlog("[HybridVoice] === INIT SUMMARY ===")
    rlog("[HybridVoice]   outputTrack: " + (this.outputTrack ? "SET" : "MISSING"))
    rlog("[HybridVoice]   audioComponent: " + (this.audioComponent ? "SET" : "MISSING"))
    rlog("[HybridVoice]   audioOutput: " + (this.audioOutput ? "SET" : "MISSING"))
    rlog("[HybridVoice]   playbackReady: " + this.playbackReady)
    rlog("[HybridVoice] ===================")
  }

  // ================================
  // Public API
  // ================================

  /**
   * Start the hybrid voice session.
   * Connects to the voice proxy with text input mode.
   */
  start(): void {
    if (!this.initialized) {
      rlog("[HybridVoice] Not initialized — call initialize() first")
      return
    }
    this.connectToProxy()
  }

  /**
   * Stop the hybrid voice session.
   */
  stop(): void {
    this.flushPlayback()
    this.clearReconnectTimer()

    if (this.socket) {
      try {
        this.socket.close()
      } catch (e) {
        rlog("[HybridVoice] Error closing socket: " + e)
      }
      this.socket = null
    }

    this.connected = false
    this.transitionTo(HybridVoiceState.IDLE)
    this.onConnectionChanged.invoke({ connected: false })
    rlog("[HybridVoice] Session stopped")
  }

  /**
   * Send a text query to the voice proxy (called by ChatASRController with final transcript).
   */
  sendQuery(text: string, attachment?: { data: string; mimeType: string }): void {
    if (!this.connected) {
      rlog("[HybridVoice] Cannot send query — not connected")
      this.onError.invoke("Not connected to voice proxy")
      return
    }

    // Barge-in: cancel current response/processing first
    if (this.state === HybridVoiceState.RESPONDING || this.state === HybridVoiceState.PROCESSING) {
      this.executeBargeIn()
    }

    const msg: any = { type: "query.text", text: text }
    if (attachment) {
      msg.attachment = attachment
    }
    this.sendControl(msg)
    this.transitionTo(HybridVoiceState.PROCESSING)
    rlog("[HybridVoice] Query sent: '" + text.substring(0, 80) + "'")
  }

  /**
   * Trigger barge-in (called externally when ASR detects new speech during response).
   */
  bargeIn(): void {
    if (this.state === HybridVoiceState.RESPONDING || this.state === HybridVoiceState.PROCESSING) {
      this.executeBargeIn()
    }
  }

  /**
   * Check if currently processing or responding (for barge-in detection).
   */
  isBusy(): boolean {
    return this.state === HybridVoiceState.RESPONDING || this.state === HybridVoiceState.PROCESSING
  }

  isConnected(): boolean {
    return this.connected
  }

  getState(): HybridVoiceState {
    return this.state
  }

  // ================================
  // WebSocket Connection
  // ================================

  private connectToProxy(): void {
    if (!this.internetModule) return

    rlog("[HybridVoice] Connecting to " + this.voiceProxyUrl)
    this.socket = this.internetModule.createWebSocket(this.voiceProxyUrl)

    this.socket.onopen = () => {
      this.onProxyOpen()
    }

    this.socket.onmessage = (event: WebSocketMessageEvent) => {
      if (typeof event.data === "string") {
        this.onProxyTextMessage(event.data)
      } else {
        // Binary data — handle all possible types (ArrayBuffer, Blob, Uint8Array)
        this.handleBinaryMessage(event.data)
      }
    }

    this.socket.onclose = (event: WebSocketCloseEvent) => {
      RemoteLogger.instance.flushSync()
      RemoteLogger.instance.setSocket(null)
      rlog("[HybridVoice] Socket closed: code=" + event.code)
      this.connected = false
      this.onConnectionChanged.invoke({ connected: false })

      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.scheduleReconnect()
      }
    }

    this.socket.onerror = () => {
      rlog("[HybridVoice] Socket error")
      this.onError.invoke("Voice proxy connection error")
    }
  }

  private onProxyOpen(): void {
    rlog("[HybridVoice] Connected to voice proxy")
    this.connected = true
    this.reconnectAttempts = 0
    this.onConnectionChanged.invoke({ connected: true })

    // Attach logger to this socket — flushes all buffered logs to server
    RemoteLogger.instance.setSocket(this.socket)

    // Send session.start with text input mode (no mic audio needed)
    this.sendControl({
      type: "session.start",
      config: {
        inputMode: "text",
      }
    })

    this.transitionTo(HybridVoiceState.IDLE)
    rlog("[HybridVoice] Session started (text input mode)")
  }

  // ================================
  // Binary Data Extraction
  // ================================

  /**
   * Handle binary WebSocket message — extract Uint8Array without async Blob API.
   * Blob.bytes() is unreliable in Lens Studio runtime. Instead:
   *   1. Try ArrayBuffer (if binaryType="arraybuffer")
   *   2. Try direct Uint8Array
   *   3. Fallback to Blob with FileReader-style sync extraction
   */
  private handleBinaryMessage(data: any): void {
    let bytes: Uint8Array | null = null

    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data)
    } else if (data instanceof Uint8Array) {
      bytes = data
    } else if (data && typeof data.byteLength === "number") {
      // ArrayBuffer-like object
      bytes = new Uint8Array(data)
    } else if (data instanceof Blob) {
      // Blob fallback — use async path but log a warning
      rlog("[HybridVoice] WARN: Binary data is Blob (async path) — may cause issues")
      const blob = data as Blob
      blob.bytes().then((b: any) => {
        this.onProxyBinaryMessage(new Uint8Array(b))
      }).catch((e: any) => {
        rlog("[HybridVoice] Blob.bytes() FAILED: " + e)
      })
      return
    } else {
      rlog("[HybridVoice] Unknown binary type: " + typeof data + " constructor=" + (data?.constructor?.name || "?"))
      return
    }

    this.onProxyBinaryMessage(bytes)
  }

  // ================================
  // Message Handlers
  // ================================

  private onProxyTextMessage(data: string): void {
    let msg: any
    try {
      msg = JSON.parse(data)
    } catch (e) {
      rlog("[HybridVoice] Invalid JSON from proxy: " + data.substring(0, 100))
      return
    }

    const msgType = msg.type || ""

    switch (msgType) {
      case "session.started":
        rlog("[HybridVoice] Session confirmed: inputMode=" + (msg.config?.inputMode || "unknown"))
        break

      case "transcript.final":
        this.onTranscript.invoke({ text: msg.text || "", isFinal: true })
        break

      case "response.audio.start":
        if (this.state === HybridVoiceState.PROCESSING) {
          this.transitionTo(HybridVoiceState.RESPONDING)
        }
        break

      case "response.audio.data":
        // Base64-encoded audio (fallback path matching Snap AI Playground pattern)
        if (msg.data) {
          try {
            const raw = this.base64ToUint8Array(msg.data)
            if (this.audioChunksReceived === 0) {
              rlog("[HybridVoice] Receiving audio via Base64 JSON (text frame path)")
            }
            this.onProxyBinaryMessage(raw)
          } catch (e) {
            rlog("[HybridVoice] Base64 decode error: " + e)
          }
        }
        break

      case "response.text.delta":
        this.onResponseDelta.invoke({
          delta: msg.delta || "",
          accumulated: msg.accumulated || "",
          done: false,
        })
        break

      case "response.done":
        rlog(`[HybridVoice] Response done: ${this.audioChunksReceived} chunks, ${this.audioBytesReceived}B audio, ${this.audioFramesEnqueued} frames enqueued`)
        this.onResponseDelta.invoke({
          delta: "",
          accumulated: msg.text || "",
          done: true,
        })
        // Reset playback state for next response
        this.audioQueue = []
        this.playbackStarted = false
        this.audioChunksReceived = 0
        this.audioBytesReceived = 0
        this.audioFramesEnqueued = 0
        this.transitionTo(HybridVoiceState.IDLE)
        break

      case "response.cancel":
        this.flushPlayback()
        this.transitionTo(HybridVoiceState.IDLE)
        break

      case "error":
        this.onError.invoke(msg.message || "Unknown error")
        this.transitionTo(HybridVoiceState.IDLE)
        break
    }
  }

  private audioChunksReceived: number = 0
  private audioBytesReceived: number = 0

  private onProxyBinaryMessage(data: Uint8Array): void {
    this.audioChunksReceived++
    this.audioBytesReceived += data.byteLength

    // Log first chunk and every 50th chunk for diagnostics
    if (this.audioChunksReceived === 1) {
      rlog(`[HybridVoice] FIRST audio chunk: ${data.byteLength}B, state=${this.state}, playbackReady=${this.playbackReady}, audioOutput=${!!this.audioOutput}`)
    } else if (this.audioChunksReceived % 50 === 0) {
      rlog(`[HybridVoice] Audio: ${this.audioChunksReceived} chunks, ${this.audioBytesReceived}B total`)
    }

    if (this.state !== HybridVoiceState.PROCESSING && this.state !== HybridVoiceState.RESPONDING) {
      if (this.audioChunksReceived <= 3) {
        rlog(`[HybridVoice] DISCARDING audio chunk — wrong state: ${this.state}`)
      }
      return
    }

    if (this.state === HybridVoiceState.PROCESSING) {
      this.transitionTo(HybridVoiceState.RESPONDING)
    }

    this.playAudioChunk(data)
  }

  // ================================
  // Audio Playback
  // ================================

  private audioFramesEnqueued: number = 0

  private playAudioChunk(data: Uint8Array): void {
    if (!this.audioOutput || !this.playbackReady) {
      if (this.audioChunksReceived <= 3) {
        rlog(`[HybridVoice] DROPPING audio — audioOutput=${!!this.audioOutput} playbackReady=${this.playbackReady}`)
      }
      return
    }

    this.audioQueue.push(data)

    if (!this.playbackStarted && this.audioQueue.length >= this.jitterBufferSize) {
      this.playbackStarted = true
      rlog(`[HybridVoice] Jitter buffer full — draining ${this.jitterBufferSize} chunks`)
      this.drainPlaybackQueue()
    } else if (this.playbackStarted) {
      this.drainPlaybackQueue()
    }
  }

  private flushPlayback(): void {
    this.audioQueue = []
    this.playbackStarted = false
    // Use stop(false) like Snap's DynamicAudioOutput — NOT stop(true)
    // stop(false) pauses without destroying state; stop(true) resets and breaks the pipeline
    if (this.audioComponent && this.audioComponent.isPlaying()) {
      this.audioComponent.stop(false)
      rlog("[HybridVoice] Playback stopped (flush)")
    }
    rlog("[HybridVoice] Playback flushed")
  }

  private drainPlaybackQueue(): void {
    while (this.audioQueue.length > 0) {
      const chunk = this.audioQueue.shift()!
      this.enqueueAudio(chunk)
    }
  }

  /**
   * Enqueue PCM16 audio for playback — matches Snap DynamicAudioOutput.addAudioFrame() exactly.
   *
   * CRITICAL: Check isPlaying() and re-call play(-1) before EACH enqueue.
   * After buffer underrun or stop(false), the AudioComponent may have stopped.
   * Never call stop(true) — it destroys the AudioOutputProvider connection.
   */
  private enqueueAudio(data: Uint8Array): void {
    if (!this.audioOutput || !this.audioComponent) return

    // Snap DynamicAudioOutput pattern: ensure playing before every enqueue
    if (!this.audioComponent.isPlaying()) {
      this.audioComponent.play(-1)
      if (this.audioFramesEnqueued === 0) {
        rlog("[HybridVoice] AudioComponent play(-1) called before first TTS enqueue")
      }
    }

    // Convert PCM16 to Float32 using Snap's exact bit-shift pattern:
    // ((lo | (hi << 8)) << 16) >> 16  — arithmetic right shift for sign extension
    const safeLength = data.byteLength - (data.byteLength % 2)
    const numSamples = safeLength / 2
    const float32 = new Float32Array(numSamples)
    for (let i = 0, j = 0; i < safeLength; i += 2, j++) {
      const sample = ((data[i] | (data[i + 1] << 8)) << 16) >> 16
      float32[j] = sample / 32768.0
    }

    const shape = new vec3(float32.length, 1, 1)
    try {
      this.audioOutput.enqueueAudioFrame(float32, shape)
      this.audioFramesEnqueued++

      // Deep diagnostics on first 2 frames
      if (this.audioFramesEnqueued <= 2) {
        let nonZero = 0
        let sumSq = 0
        let minVal = 0
        let maxVal = 0
        const preview: string[] = []
        for (let i = 0; i < float32.length; i++) {
          const v = float32[i]
          sumSq += v * v
          if (v !== 0) nonZero++
          if (v < minVal) minVal = v
          if (v > maxVal) maxVal = v
          if (i < 8) preview.push(v.toFixed(4))
        }
        const rms = Math.sqrt(sumSq / float32.length)
        rlog(`[HybridVoice] FRAME #${this.audioFramesEnqueued}: ${float32.length} samples, ` +
          `rms=${rms.toFixed(4)}, range=[${minVal.toFixed(4)},${maxVal.toFixed(4)}], ` +
          `nonZero=${nonZero}/${float32.length}, isPlaying=${this.audioComponent.isPlaying()}`)
      }
    } catch (e) {
      rlog(`[HybridVoice] enqueueAudioFrame ERROR: ${e}`)
    }
  }

  // ================================
  // Barge-In
  // ================================

  private executeBargeIn(): void {
    rlog("[HybridVoice] Barge-in! Interrupting agent (was " + this.state + ")")
    this.flushPlayback()
    this.sendControl({ type: "response.cancel" })
    this.transitionTo(HybridVoiceState.IDLE)
  }

  // ================================
  // Visual Query Support
  // ================================

  /**
   * Send an image attachment to the voice proxy for the next query.
   */
  sendAttachment(data: string, mimeType: string): void {
    this.sendControl({
      type: "input.attachment",
      data: data,
      mimeType: mimeType,
    })
    rlog("[HybridVoice] Attachment sent (" + mimeType + ", " + data.length + " chars)")
  }

  // ================================
  // Helpers
  // ================================

  /**
   * Decode Base64 string to Uint8Array (no atob in Lens Studio).
   */
  private base64ToUint8Array(b64: string): Uint8Array {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    const lookup = new Uint8Array(128)
    for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i

    // Strip padding and compute length
    let len = b64.length
    while (len > 0 && b64[len - 1] === "=") len--
    const outLen = (len * 3) >> 2
    const out = new Uint8Array(outLen)

    let j = 0
    for (let i = 0; i < len; i += 4) {
      const a = lookup[b64.charCodeAt(i)]
      const b = i + 1 < len ? lookup[b64.charCodeAt(i + 1)] : 0
      const c = i + 2 < len ? lookup[b64.charCodeAt(i + 2)] : 0
      const d = i + 3 < len ? lookup[b64.charCodeAt(i + 3)] : 0
      const bits = (a << 18) | (b << 12) | (c << 6) | d
      if (j < outLen) out[j++] = (bits >> 16) & 0xff
      if (j < outLen) out[j++] = (bits >> 8) & 0xff
      if (j < outLen) out[j++] = bits & 0xff
    }
    return out
  }

  private sendControl(msg: any): void {
    if (!this.socket || !this.connected) return
    try {
      this.socket.send(JSON.stringify(msg))
    } catch (e) {
      rlog("[HybridVoice] Failed to send control: " + e)
    }
  }

  private transitionTo(newState: HybridVoiceState): void {
    if (this.state === newState) return
    const oldState = this.state
    this.state = newState
    rlog("[HybridVoice] " + oldState + " → " + newState)
    this.onStateChanged.invoke(newState)
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++
    const delay = Math.min(Math.pow(2, this.reconnectAttempts - 1) * 1000, 30000)
    rlog("[HybridVoice] Reconnecting in " + Math.round(delay) + "ms (attempt " + this.reconnectAttempts + ")")

    this.reconnectTimerId = setTimeout(() => {
      this.connectToProxy()
    }, delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimerId !== null) {
      clearTimeout(this.reconnectTimerId)
      this.reconnectTimerId = null
    }
  }
}

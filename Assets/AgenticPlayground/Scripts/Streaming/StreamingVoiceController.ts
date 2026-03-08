import Event from "SpectaclesInteractionKit.lspkg/Utils/Event"
import { setTimeout, clearTimeout } from "SpectaclesInteractionKit.lspkg/Utils/FunctionTimingUtils"
import { StreamingAudioBridge } from "./StreamingAudioBridge"

/**
 * StreamingVoiceController — Voice conversation state machine.
 *
 * Manages the streaming voice pipeline:
 *   IDLE → LISTENING → PROCESSING → RESPONDING → IDLE
 *   RESPONDING → INTERRUPTING → LISTENING (barge-in)
 *
 * Connects to the voice proxy server via its own WebSocket.
 * Binary frames = PCM16 audio. Text frames = JSON control messages.
 *
 * The voice proxy handles VAD, ASR, OpenClaw, and TTS server-side.
 */

export enum VoiceState {
  IDLE = "idle",
  LISTENING = "listening",
  PROCESSING = "processing",
  RESPONDING = "responding",
  INTERRUPTING = "interrupting",
}

@component
export class StreamingVoiceController extends BaseScriptComponent {
  // ================================
  // Inspector Inputs
  // ================================

  @input("Component.ScriptComponent")
  audioBridge: StreamingAudioBridge

  @input
  @hint("Voice proxy server WebSocket URL (e.g., ws://172.16.8.164:8765)")
  voiceProxyUrl: string = "ws://172.16.2.117:8765"

  @input
  bargeInThreshold: number = 200

  @input
  minInterruptionDuration: number = 500  // ms

  @input
  userAwayTimeout: number = 15000  // ms

  // ================================
  // Events
  // ================================

  /** State changed. */
  public readonly onStateChanged = new Event<VoiceState>()

  /** User's speech transcribed. */
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

  private state: VoiceState = VoiceState.IDLE
  private socket: WebSocket | null = null
  private internetModule: InternetModule | null = null
  private bargeInDuration: number = 0
  private awayTimerId: any = null
  private reconnectTimerId: any = null
  private initialized: boolean = false
  private connected: boolean = false
  private reconnectAttempts: number = 0
  private readonly maxReconnectAttempts: number = 10

  // ================================
  // Lifecycle
  // ================================

  onAwake(): void {
    print("[StreamingVoice] Awake")
  }

  /**
   * Initialize the streaming voice controller.
   * Acquires InternetModule for WebSocket creation.
   */
  initialize(): void {
    if (this.initialized) return

    try {
      this.internetModule = require("LensStudio:InternetModule") as InternetModule
      print("[StreamingVoice] InternetModule acquired")
    } catch (e) {
      print("[StreamingVoice] ERROR: InternetModule not available: " + e)
      return
    }

    if (!this.audioBridge) {
      print("[StreamingVoice] ERROR: audioBridge not set")
      return
    }

    // Wire audio bridge events
    this.audioBridge.onAudioFrame.add((frame: Uint8Array) => {
      this.onMicFrame(frame)
    })

    this.audioBridge.onFrameEnergy.add((rms: number) => {
      this.onMicEnergy(rms)
    })

    this.initialized = true
    print("[StreamingVoice] Initialized")
  }

  // ================================
  // Public API
  // ================================

  /**
   * Start the streaming voice session.
   * Connects to the voice proxy server and begins mic capture.
   */
  start(): void {
    if (!this.initialized) {
      print("[StreamingVoice] Not initialized — call initialize() first")
      return
    }

    this.connectToProxy()
  }

  /**
   * Stop the streaming voice session.
   */
  stop(): void {
    this.audioBridge.stopCapture()
    this.audioBridge.flushPlayback()
    this.clearAwayTimer()
    this.clearReconnectTimer()

    if (this.socket) {
      try {
        this.socket.close()
      } catch (e) {
        print("[StreamingVoice] Error closing socket: " + e)
      }
      this.socket = null
    }

    this.connected = false
    this.transitionTo(VoiceState.IDLE)
    this.onConnectionChanged.invoke({ connected: false })
    print("[StreamingVoice] Session stopped")
  }

  /**
   * Check if connected to the voice proxy.
   */
  isConnected(): boolean {
    return this.connected
  }

  /**
   * Get current voice state.
   */
  getState(): VoiceState {
    return this.state
  }

  // ================================
  // WebSocket Connection
  // ================================

  private connectToProxy(): void {
    if (!this.internetModule) return

    print("[StreamingVoice] Connecting to " + this.voiceProxyUrl)
    this.socket = this.internetModule.createWebSocket(this.voiceProxyUrl)

    this.socket.onopen = () => {
      this.onProxyOpen()
    }

    this.socket.onmessage = async (event: WebSocketMessageEvent) => {
      if (typeof event.data === "string") {
        this.onProxyTextMessage(event.data)
      } else if (event.data instanceof Blob) {
        const bytes = await event.data.bytes()
        this.onProxyBinaryMessage(bytes)
      }
    }

    this.socket.onclose = (event: WebSocketCloseEvent) => {
      print("[StreamingVoice] Socket closed: code=" + event.code)
      this.connected = false
      this.onConnectionChanged.invoke({ connected: false })

      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.scheduleReconnect()
      }
    }

    this.socket.onerror = () => {
      print("[StreamingVoice] Socket error")
      this.onError.invoke("Voice proxy connection error")
    }
  }

  private onProxyOpen(): void {
    print("[StreamingVoice] Connected to voice proxy")
    this.connected = true
    this.reconnectAttempts = 0
    this.onConnectionChanged.invoke({ connected: true })

    // Send session.start as TEXT frame (JSON control message)
    this.sendControl({
      type: "session.start",
      config: {
        sampleRate: 16000,
        channels: 1,
        encoding: "pcm16",
        vadMode: "server",
      }
    })

    // Initialize and start mic capture
    this.audioBridge.initialize()
    this.audioBridge.startCapture()

    this.transitionTo(VoiceState.IDLE)
    this.resetAwayTimer()
    print("[StreamingVoice] Session started")
  }

  /**
   * Handle JSON control messages from the voice proxy server.
   */
  private onProxyTextMessage(data: string): void {
    let msg: any
    try {
      msg = JSON.parse(data)
    } catch (e) {
      print("[StreamingVoice] Invalid JSON from proxy: " + data.substring(0, 100))
      return
    }

    const msgType = msg.type || ""

    switch (msgType) {
      case "session.started":
        print("[StreamingVoice] Session confirmed by server")
        break

      case "vad.speech_start":
        if (this.state === VoiceState.IDLE) {
          this.transitionTo(VoiceState.LISTENING)
        }
        break

      case "vad.speech_end":
        if (this.state === VoiceState.LISTENING) {
          this.transitionTo(VoiceState.PROCESSING)
        }
        break

      case "transcript.final":
        this.onTranscript.invoke({ text: msg.text || "", isFinal: true })
        break

      case "transcript.delta":
        this.onTranscript.invoke({ text: msg.text || "", isFinal: !!msg.isFinal })
        break

      case "response.audio.start":
        if (this.state === VoiceState.PROCESSING) {
          this.transitionTo(VoiceState.RESPONDING)
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
        this.onResponseDelta.invoke({
          delta: "",
          accumulated: msg.text || "",
          done: true,
        })
        this.transitionTo(VoiceState.IDLE)
        break

      case "response.cancel":
        this.audioBridge.flushPlayback()
        this.transitionTo(VoiceState.IDLE)
        break

      case "agent.false_interruption":
        print("[StreamingVoice] False interruption detected")
        break

      case "error":
        this.onError.invoke(msg.message || "Unknown error")
        this.transitionTo(VoiceState.IDLE)
        break
    }
  }

  /**
   * Handle binary audio frames from the voice proxy (TTS output).
   */
  private onProxyBinaryMessage(data: Uint8Array): void {
    if (this.state === VoiceState.INTERRUPTING) {
      return  // Discard audio during barge-in
    }

    if (this.state === VoiceState.PROCESSING || this.state === VoiceState.RESPONDING) {
      if (this.state === VoiceState.PROCESSING) {
        this.transitionTo(VoiceState.RESPONDING)
      }
      this.audioBridge.playAudioChunk(data)
    }
  }

  // ================================
  // Audio Frame Handlers
  // ================================

  /**
   * Handle a mic audio frame (non-silent, already energy-gated).
   * Send to proxy server as binary WebSocket frame.
   */
  private onMicFrame(frame: Uint8Array): void {
    if (!this.socket || !this.connected) return
    try {
      this.socket.send(frame)
    } catch (e) {
      // Silent fail — connection may have dropped
    }
    this.resetAwayTimer()
  }

  /**
   * Handle mic energy level (every frame, including silent).
   * Used for barge-in detection during RESPONDING state.
   */
  private onMicEnergy(rms: number): void {
    if (this.state !== VoiceState.RESPONDING) {
      this.bargeInDuration = 0
      return
    }

    if (rms > this.bargeInThreshold) {
      this.bargeInDuration += 20  // 20ms per frame
      if (this.bargeInDuration >= this.minInterruptionDuration) {
        this.executeBargeIn()
      }
    } else {
      this.bargeInDuration = 0
    }
  }

  // ================================
  // Barge-In
  // ================================

  private executeBargeIn(): void {
    print("[StreamingVoice] Barge-in! Interrupting agent")
    this.bargeInDuration = 0

    // Flush local audio playback immediately
    this.audioBridge.flushPlayback()

    // Send cancel as TEXT frame (JSON control message)
    this.sendControl({ type: "response.cancel" })

    this.transitionTo(VoiceState.LISTENING)
  }

  // ================================
  // Visual Query Support
  // ================================

  /**
   * Send an image attachment to the voice proxy for the next query.
   * The proxy holds the attachment and includes it in the next OpenClaw chat.send.
   */
  sendAttachment(data: string, mimeType: string): void {
    this.sendControl({
      type: "input.attachment",
      data: data,
      mimeType: mimeType,
    })
    print("[StreamingVoice] Attachment sent (" + mimeType + ", " + data.length + " chars)")
  }

  // ================================
  // Helpers
  // ================================

  /**
   * Send a JSON control message as a text frame to the voice proxy.
   */
  private sendControl(msg: any): void {
    if (!this.socket || !this.connected) return
    try {
      this.socket.send(JSON.stringify(msg))
    } catch (e) {
      print("[StreamingVoice] Failed to send control: " + e)
    }
  }

  private transitionTo(newState: VoiceState): void {
    if (this.state === newState) return
    const oldState = this.state
    this.state = newState
    print("[StreamingVoice] " + oldState + " → " + newState)
    this.onStateChanged.invoke(newState)
  }

  // ================================
  // Reconnection
  // ================================

  private scheduleReconnect(): void {
    this.reconnectAttempts++
    const delay = Math.min(Math.pow(2, this.reconnectAttempts - 1) * 1000, 30000)
    print("[StreamingVoice] Reconnecting in " + Math.round(delay) + "ms (attempt " + this.reconnectAttempts + ")")

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

  // ================================
  // User Away Detection
  // ================================

  private resetAwayTimer(): void {
    this.clearAwayTimer()
    this.awayTimerId = setTimeout(() => {
      if (this.state === VoiceState.IDLE || this.state === VoiceState.LISTENING) {
        print("[StreamingVoice] User away (no audio for " + this.userAwayTimeout + "ms)")
        this.transitionTo(VoiceState.IDLE)
      }
    }, this.userAwayTimeout)
  }

  private clearAwayTimer(): void {
    if (this.awayTimerId !== null) {
      clearTimeout(this.awayTimerId)
      this.awayTimerId = null
    }
  }
}

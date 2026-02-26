import Event from "SpectaclesInteractionKit.lspkg/Utils/Event"
import {clearTimeout, setTimeout} from "SpectaclesInteractionKit.lspkg/Utils/FunctionTimingUtils"
import {OpenClawBridge} from "./Bridge/OpenClawBridge"
import {GlassQuery, OpenClawConnectionState, OpenClawStreamingDelta} from "./Bridge/OpenClawTypes"

/**
 * JarvisController - Central coordinator for the Jarvis voice bridge.
 *
 * Thin voice I/O bridge to an OpenClaw gateway server:
 *   Voice In (ASR) → JarvisController → OpenClawBridge → OpenClaw Server
 *                          │                    │
 *                          ├── Native TTS ←─────┘ (streaming response)
 *                          ├── Chat UI ←────────┘ (text display)
 *                          └── Camera Capture ──→  (visual queries as attachments)
 */
@component
export class JarvisController extends BaseScriptComponent {
  // ================================
  // Inspector Inputs
  // ================================

  @input
  @hint("RemoteServiceModule reference for WebSocket (InternetModule) + camera (VideoController)")
  remoteServiceModule: RemoteServiceModule = null

  @input
  @hint("AudioComponent for native TTS playback")
  @allowUndefined
  ttsAudioComponent: AudioComponent

  @input
  @hint("Enable voice output via native TTS")
  enableVoiceOutput: boolean = true

  @input
  @hint("OpenClaw server WebSocket URL (e.g., ws://192.168.1.66:18789)")
  serverUrl: string = "ws://192.168.1.66:18789"

  @input
  @hint("Gateway auth token from openclaw.json gateway.auth.token")
  authToken: string = ""

  @input
  @hint("Enable debug logging")
  enableDebugLogging: boolean = true

  // ================================
  // State
  // ================================

  private bridge: OpenClawBridge = null
  private ttsModule: TextToSpeechModule = null
  private isSpeakingNative: boolean = false
  private isProcessing: boolean = false
  private queryGeneration: number = 0
  private initialized: boolean = false

  // ================================
  // Events
  // ================================

  public onQueryProcessed: Event<{query: string; response: string}> = new Event()
  public onVoiceCompleted: Event<{query: string; response: string}> = new Event()
  public onError: Event<string> = new Event<string>()
  public onConnectionStateChanged: Event<OpenClawConnectionState> = new Event()
  public onStreamingDelta: Event<OpenClawStreamingDelta> = new Event()

  // ================================
  // Lifecycle
  // ================================

  onAwake() {
    this.createEvent("OnStartEvent").bind(this.initialize.bind(this))
  }

  private initialize(): void {
    if (this.initialized) return

    this.bridge = OpenClawBridge.getInstance()

    // Configure bridge
    if (this.remoteServiceModule) {
      this.bridge.setRemoteServiceModule(this.remoteServiceModule)
    }

    this.bridge.configure({
      serverUrl: this.serverUrl,
      authToken: this.authToken,
      enableCamera: true,
      enableVoice: this.enableVoiceOutput,
      enableStreaming: true
    })

    // Subscribe to bridge events
    this.bridge.onConnectionStateChanged.add((state: OpenClawConnectionState) => {
      this.onConnectionStateChanged.invoke(state)
      if (state.status === "connected") {
        print("JarvisController: Connected to OpenClaw")
      } else if (state.status === "disconnected") {
        print("JarvisController: Disconnected from OpenClaw")
      }
    })

    this.bridge.onStreamingDelta.add((data: OpenClawStreamingDelta) => {
      this.onStreamingDelta.invoke(data)
    })

    this.bridge.onError.add((error) => {
      this.onError.invoke(error.message)
    })

    // Connect to server
    this.bridge.connect(this.serverUrl)

    this.initialized = true
    print("JarvisController: Initialized")
  }

  // ================================
  // Public API — Query Processing
  // ================================

  /**
   * Process a query through OpenClaw. Detects visual keywords, optionally
   * captures a camera frame, sends to OpenClaw, speaks the response via TTS,
   * and emits events for the chat UI.
   */
  public async processQuery(query: string): Promise<string> {
    if (!this.bridge || !this.bridge.isConnected()) {
      const error = "Not connected to OpenClaw"
      this.onError.invoke(error)
      return error
    }

    this.isProcessing = true
    const myGeneration = ++this.queryGeneration

    try {
      if (this.enableDebugLogging) {
        print(`JarvisController: Processing: "${query.substring(0, 80)}"`)
      }

      // Optionally capture camera frame for visual queries
      let imageData: string | null = null
      if (this.isVisualQuery(query)) {
        imageData = await this.captureFrame()
        if (this.enableDebugLogging) {
          print(`JarvisController: Camera frame captured: ${imageData ? "yes" : "no"}`)
        }
      }

      // Build and send query
      const glassQuery: GlassQuery = {
        text: query,
        imageData: imageData,
        displayMode: "chat",
        maxResponseLength: 300
      }

      const response = await this.bridge.sendQuery(glassQuery)

      if (this.enableDebugLogging) {
        print(`JarvisController: Response (${response.length} chars): "${response.substring(0, 80)}"`)
      }

      // Speak via native TTS if enabled
      if (this.enableVoiceOutput && response && response.length > 0) {
        this.speakNative(response)
      }

      // Emit events
      this.onQueryProcessed.invoke({query, response})

      return response
    } catch (error) {
      const errorMessage = `Query failed: ${error}`
      this.onError.invoke(errorMessage)
      return errorMessage
    } finally {
      if (myGeneration === this.queryGeneration) {
        this.isProcessing = false
      }
    }
  }

  /**
   * Non-blocking query processing with "last utterance wins" semantics.
   * Aborts any in-flight query before starting the new one.
   */
  public async processQueryNonBlocking(query: string): Promise<string> {
    if (this.enableDebugLogging) {
      print(`JarvisController: [NonBlocking] called, isProcessing: ${this.isProcessing}`)
    }

    if (this.isProcessing) {
      this.abortCurrentQuery()
    }

    this.isProcessing = false
    return this.processQuery(query)
  }

  /**
   * Abort the current in-progress query and stop TTS.
   */
  public abortCurrentQuery(): void {
    if (this.bridge?.isConnected()) {
      this.bridge.abortQuery()
    }
    this.stopNativeTTS()
    this.isProcessing = false
  }

  /**
   * Check if native TTS is currently playing audio (for barge-in detection).
   */
  public isSpeaking(): boolean {
    return this.isSpeakingNative
  }

  /**
   * Check if system is ready for queries.
   */
  public isSystemReady(): boolean {
    return this.initialized && this.bridge?.isConnected() && !this.isProcessing
  }

  /**
   * Get the OpenClaw bridge instance.
   */
  public getOpenClawBridge(): OpenClawBridge | null {
    return this.bridge
  }

  // ================================
  // Visual Query Detection
  // ================================

  private isVisualQuery(query: string): boolean {
    const lower = query.toLowerCase()
    const keywords = [
      "see", "look", "show", "camera",
      "what's in front", "around me",
      "visual", "environment", "room"
    ]
    return keywords.some((kw) => lower.includes(kw))
  }

  // ================================
  // Camera Capture
  // ================================

  private async captureFrame(): Promise<string | null> {
    try {
      const {VideoController} = require("RemoteServiceGateway.lspkg/Helpers/VideoController")

      const videoController = new VideoController(
        1500, // frame interval (ms)
        1,    // CompressionQuality.HighQuality
        0     // EncodingType.Jpg
      )

      const framePromise = new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Camera frame capture timeout"))
        }, 3000)

        videoController.onEncodedFrame.add((encodedFrame: string) => {
          clearTimeout(timeout)
          resolve(encodedFrame)
        })
      })

      videoController.startRecording()
      const frame = await framePromise
      videoController.stopRecording()

      return frame
    } catch (error) {
      print(`JarvisController: Camera capture failed: ${error}`)
      return null
    }
  }

  // ================================
  // Native TTS
  // ================================

  /**
   * Speak text using Spectacles native TextToSpeechModule.
   * Cleans markdown, splits into 380-char chunks, plays sequentially.
   */
  private speakNative(text: string): void {
    if (!text) return

    if (!this.ttsModule) {
      try {
        this.ttsModule = require("LensStudio:TextToSpeechModule")
        print("JarvisController: [TTS] TextToSpeechModule loaded")
      } catch (e) {
        print(`JarvisController: [TTS] FAILED to load TextToSpeechModule: ${e}`)
        return
      }
    }

    const cleanText = this.cleanTextForTTS(text)
    const chunks = this.splitTextForTTS(cleanText, 380)

    if (this.enableDebugLogging) {
      print(`JarvisController: [TTS] Speaking ${chunks.length} chunk(s), ${cleanText.length} chars`)
    }

    this.isSpeakingNative = true
    this.speakChunks(chunks, 0)
  }

  /**
   * Stop native TTS playback immediately.
   */
  public stopNativeTTS(): void {
    if (this.ttsAudioComponent && this.isSpeakingNative) {
      this.ttsAudioComponent.stop(false)
      this.isSpeakingNative = false
      print("JarvisController: [TTS] Playback interrupted")
    }
  }

  /**
   * Play TTS chunks sequentially.
   */
  private speakChunks(chunks: string[], index: number): void {
    if (index >= chunks.length || !this.isSpeakingNative) {
      this.isSpeakingNative = false
      if (index >= chunks.length && this.enableDebugLogging) {
        print("JarvisController: [TTS] All chunks finished")
      }
      return
    }

    const chunk = chunks[index]
    if (this.enableDebugLogging) {
      print(`JarvisController: [TTS] Chunk ${index + 1}/${chunks.length}: "${chunk.substring(0, 50)}..."`)
    }

    try {
      const options = TextToSpeech.Options.create()
      this.ttsModule.synthesize(
        chunk,
        options,
        (audioTrackAsset: AudioTrackAsset) => {
          if (!this.isSpeakingNative) return

          if (this.ttsAudioComponent) {
            this.ttsAudioComponent.audioTrack = audioTrackAsset
            this.ttsAudioComponent.play(1)
            this.ttsAudioComponent.setOnFinish(() => {
              this.speakChunks(chunks, index + 1)
            })
          } else {
            print("JarvisController: [TTS] No AudioComponent — skipping")
            this.isSpeakingNative = false
          }
        },
        (error: number, description: string) => {
          print(`JarvisController: [TTS] Chunk ${index + 1} error ${error}: ${description}`)
          this.speakChunks(chunks, index + 1)
        }
      )
    } catch (e) {
      print(`JarvisController: [TTS] EXCEPTION: ${e}`)
      this.isSpeakingNative = false
    }
  }

  /**
   * Strip markdown formatting that TTS can't handle.
   */
  private cleanTextForTTS(text: string): string {
    let clean = text
    clean = clean.replace(/\*\*([^*]+)\*\*/g, "$1")
    clean = clean.replace(/\*([^*]+)\*/g, "$1")
    clean = clean.replace(/__([^_]+)__/g, "$1")
    clean = clean.replace(/_([^_]+)_/g, "$1")
    clean = clean.replace(/^#{1,6}\s+/gm, "")
    clean = clean.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    clean = clean.replace(/`([^`]+)`/g, "$1")
    clean = clean.replace(/^[\-\*]\s+/gm, "")
    clean = clean.replace(/^\d+\.\s+/gm, "")
    clean = clean.replace(/\s*—\s*/g, ", ")
    clean = clean.replace(/\n+/g, " ")
    clean = clean.replace(/\s{2,}/g, " ")
    return clean.trim()
  }

  /**
   * Split text into chunks at sentence boundaries, staying under maxLen chars.
   */
  private splitTextForTTS(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text]

    const chunks: string[] = []
    let remaining = text

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining)
        break
      }

      let splitAt = -1
      const searchArea = remaining.substring(0, maxLen)

      // Try sentence endings: . ! ?
      for (let i = searchArea.length - 1; i >= 0; i--) {
        const ch = searchArea[i]
        if (ch === "." || ch === "!" || ch === "?") {
          splitAt = i + 1
          break
        }
      }

      // Fallback: comma or semicolon
      if (splitAt <= 0) {
        for (let i = searchArea.length - 1; i >= 0; i--) {
          if (searchArea[i] === "," || searchArea[i] === ";") {
            splitAt = i + 1
            break
          }
        }
      }

      // Last fallback: space
      if (splitAt <= 0) {
        splitAt = searchArea.lastIndexOf(" ")
        if (splitAt <= 0) splitAt = maxLen
      }

      chunks.push(remaining.substring(0, splitAt).trim())
      remaining = remaining.substring(splitAt).trim()
    }

    return chunks
  }
}

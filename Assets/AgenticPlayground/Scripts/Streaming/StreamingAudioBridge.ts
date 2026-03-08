import Event from "SpectaclesInteractionKit.lspkg/Utils/Event"

/**
 * StreamingAudioBridge — Raw audio I/O over WebSocket.
 *
 * Captures Float32 audio from MicrophoneAudioProvider (using getAudioFrame),
 * converts to PCM16, and sends non-silent frames as binary Uint8Array over WebSocket.
 * Plays received PCM16 audio through AudioOutputProvider.
 *
 * NOTE: Uses getAudioFrame() (Float32) instead of getAudioFramePCM16() because
 * all working Snap sample projects (Voice Playback, Snap Cloud Audio) use the
 * Float32 API. The PCM16 variant returns zero-data on Spectacles hardware.
 *
 * Audio format: 16kHz mono PCM16 (signed int16 little-endian) over WebSocket
 */
@component
export class StreamingAudioBridge extends BaseScriptComponent {
  // ================================
  // Inspector Inputs
  // ================================

  @input("Asset.AudioTrackAsset")
  micTrack: AudioTrackAsset

  @input("Asset.AudioTrackAsset")
  outputTrack: AudioTrackAsset

  @input
  @hint("RMS energy threshold for sending frames. Set to 0 for server-side VAD (sends all frames)")
  energyThreshold: number = 0

  // ================================
  // Events
  // ================================

  /** Fired when a non-silent audio frame is captured from the mic. */
  public readonly onAudioFrame = new Event<Uint8Array>()

  /** Fired with RMS energy of each frame (for barge-in detection). */
  public readonly onFrameEnergy = new Event<number>()

  // ================================
  // State
  // ================================

  private micProvider: MicrophoneAudioProvider | null = null
  private audioOutput: AudioOutputProvider | null = null
  private floatBuffer: Float32Array | null = null
  private updateEvent: UpdateEvent | null = null
  private capturing: boolean = false
  private playing: boolean = false

  // Jitter buffer: queue frames before starting playback
  private audioQueue: Uint8Array[] = []
  private jitterBufferSize: number = 3  // 60ms at 20ms/frame
  private playbackStarted: boolean = false

  // ================================
  // Lifecycle
  // ================================

  onAwake(): void {
    print("[StreamingAudio] Awake — early init starting")

    // Initialize immediately in onAwake like all working Snap samples
    if (!this.micTrack || !this.outputTrack) {
      print("[StreamingAudio] ERROR: micTrack or outputTrack not set")
      return
    }

    // Setup mic capture — use getAudioFrame (Float32) like working Snap samples
    // Keep native 44100Hz sample rate — downsample to 16kHz before sending
    this.micProvider = this.micTrack.control as MicrophoneAudioProvider
    if (this.micProvider) {
      const rate = this.micProvider.sampleRate
      this.floatBuffer = new Float32Array(this.micProvider.maxFrameSize)
      print("[StreamingAudio] Mic initialized: sampleRate=" + rate + " maxFrameSize=" + this.micProvider.maxFrameSize)

      // Create update event immediately (disabled) — like Snap Voice Playback sample
      this.updateEvent = this.createEvent("UpdateEvent")
      this.updateEvent.bind(() => this.onUpdate())
      this.updateEvent.enabled = false
    } else {
      print("[StreamingAudio] ERROR: Could not get MicrophoneAudioProvider")
    }

    // Setup audio output — keep at 16kHz since proxy sends 16kHz PCM16
    this.audioOutput = this.outputTrack.control as AudioOutputProvider
    if (this.audioOutput) {
      this.audioOutput.sampleRate = 16000
      print("[StreamingAudio] Audio output initialized: sampleRate=16000")
    } else {
      print("[StreamingAudio] ERROR: Could not get AudioOutputProvider")
    }

    print("[StreamingAudio] Awake — early init complete")
  }

  /**
   * Initialize audio providers (now a no-op, kept for API compat).
   * Real init happens in onAwake().
   */
  initialize(): void {
    // Already initialized in onAwake
  }

  // ================================
  // Mic Capture
  // ================================

  /**
   * Start capturing audio from the microphone.
   * Non-silent frames are emitted via onAudioFrame event.
   */
  startCapture(): void {
    if (!this.micProvider || !this.floatBuffer || !this.updateEvent) {
      print("[StreamingAudio] Cannot start capture — not initialized")
      return
    }

    if (this.capturing) {
      print("[StreamingAudio] Already capturing — skipping duplicate start")
      return
    }

    this.micProvider.start()
    this.capturing = true
    this.updateEvent.enabled = true
    print("[StreamingAudio] Capture started")
  }

  /**
   * Stop capturing audio.
   */
  stopCapture(): void {
    this.capturing = false
    if (this.updateEvent) {
      this.updateEvent.enabled = false
    }
    if (this.micProvider) {
      this.micProvider.stop()
    }
    print("[StreamingAudio] Capture stopped")
  }

  private frameCount: number = 0
  private nonZeroDataSeen: boolean = false

  private onUpdate(): void {
    if (!this.capturing || !this.micProvider || !this.floatBuffer) return

    // Use getAudioFrame (Float32) — the only variant that works on Spectacles hardware
    const shape = this.micProvider.getAudioFrame(this.floatBuffer)
    const frameSize = shape.x

    this.frameCount++

    // Log every 200 frames — unconditionally, even if size=0
    if (this.frameCount % 200 === 1) {
      print("[StreamingAudio] #" + this.frameCount + " size=" + frameSize + " shape=(" + shape.x + "," + shape.y + "," + shape.z + ")")
    }

    if (frameSize <= 0) return

    const floatSamples = this.floatBuffer.subarray(0, frameSize)

    // Log first non-zero frame details
    if (!this.nonZeroDataSeen) {
      this.nonZeroDataSeen = true
      let maxVal = 0
      for (let i = 0; i < Math.min(frameSize, 10); i++) {
        maxVal = Math.max(maxVal, Math.abs(floatSamples[i]))
      }
      print("[StreamingAudio] FIRST DATA: size=" + frameSize + " first10max=" + maxVal)
    }

    // Compute RMS on float samples (range -1.0 to 1.0, scale to Int16 range for threshold compat)
    const rms = this.computeRMSFloat(floatSamples)

    // Always emit energy for barge-in detection
    this.onFrameEnergy.invoke(rms)

    // Energy-gate: skip silence frames
    if (rms < this.energyThreshold) return

    // Downsample from 44100 to 16000 and convert Float32 to PCM16
    const ratio = 44100 / 16000  // ~2.756
    const outLen = Math.floor(frameSize / ratio)
    const int16 = new Int16Array(outLen)
    for (let i = 0; i < outLen; i++) {
      const srcIdx = Math.min(Math.floor(i * ratio), frameSize - 1)
      const s = Math.max(-1, Math.min(1, floatSamples[srcIdx]))
      int16[i] = s < 0 ? s * 32768 : s * 32767
    }
    const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength)
    this.onAudioFrame.invoke(bytes)
  }

  // ================================
  // Audio Playback
  // ================================

  /**
   * Enqueue a PCM16 audio chunk for playback.
   * Uses a jitter buffer to smooth network variance.
   */
  playAudioChunk(data: Uint8Array): void {
    if (!this.audioOutput) return

    this.audioQueue.push(data)

    // Start playback once jitter buffer is filled
    if (!this.playbackStarted && this.audioQueue.length >= this.jitterBufferSize) {
      this.playbackStarted = true
      this.drainPlaybackQueue()
    } else if (this.playbackStarted) {
      this.drainPlaybackQueue()
    }
  }

  /**
   * Flush all queued audio and stop playback.
   * Used during barge-in to immediately silence the speaker.
   */
  flushPlayback(): void {
    this.audioQueue = []
    this.playbackStarted = false
    print("[StreamingAudio] Playback flushed")
  }

  private drainPlaybackQueue(): void {
    while (this.audioQueue.length > 0) {
      const chunk = this.audioQueue.shift()!
      this.playChunkDirect(chunk)
    }
  }

  private playChunkDirect(data: Uint8Array): void {
    if (!this.audioOutput) return

    // Convert PCM16 (Int16) to Float32 for AudioOutputProvider
    const int16 = new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2)
    const float32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0
    }

    const shape = new vec3(float32.length, 1, 1)  // frames x channels x 1
    this.audioOutput.enqueueAudioFrame(float32, shape)
  }

  // ================================
  // Utilities
  // ================================

  /**
   * Compute RMS energy of Float32 samples, scaled to Int16 range for threshold compatibility.
   */
  computeRMSFloat(samples: Float32Array): number {
    let sum = 0
    for (let i = 0; i < samples.length; i++) {
      // Scale to Int16 range so existing thresholds still work
      const scaled = samples[i] * 32768
      sum += scaled * scaled
    }
    return Math.sqrt(sum / samples.length)
  }

  /**
   * Check if currently capturing audio.
   */
  isCapturing(): boolean {
    return this.capturing
  }
}

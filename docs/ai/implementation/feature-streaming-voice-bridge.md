---
phase: implementation
title: "Implementation: Streaming Voice Bridge"
description: Technical implementation notes, patterns, and code guidelines
feature: streaming-voice-bridge
---

# Implementation: Streaming Voice Bridge

## Development Setup

### Prerequisites
- **Lens Studio v5.15.0+** with Experimental APIs enabled
- **Spectacles OS v5.64+** for Permission Alerts
- **Python 3.10+** with pip
- **OpenClaw server** running on LAN (`openclaw gateway --bind lan`)

### Python Proxy Server Setup
```bash
# In project root
mkdir -p voice-proxy
cd voice-proxy
python -m venv venv
source venv/bin/activate
pip install fastapi uvicorn websockets silero-vad torch deepgram-sdk cartesia
```

### Lens Studio Setup
1. Project Settings → General → Enable "Experimental APIs"
2. Import `RemoteServiceGateway.lspkg` from Asset Library (for `MicrophoneRecorder` reference)
3. Add "Audio From Microphone" asset → exposes `MicrophoneAudioProvider`
4. Add "Audio Output" asset → exposes `AudioOutputProvider`
5. Wire `AudioComponent` in scene for output

## Code Structure

### Spectacles (New/Modified Files)
```
Assets/AgenticPlayground/Scripts/
├── JarvisController.ts           # MODIFIED: add streamingMode toggle
├── Streaming/                    # NEW directory
│   ├── StreamingAudioBridge.ts   # NEW: raw audio I/O over WebSocket
│   └── StreamingVoiceController.ts # NEW: state machine + barge-in
├── Bridge/
│   └── OpenClawBridge.ts         # MODIFIED: add binary WebSocket support
└── ...existing files unchanged
```

### Proxy Server (New)
```
voice-proxy/
├── server.py                     # WebSocket server entry point
├── pipeline.py                   # Audio pipeline orchestrator
├── vad.py                        # Silero VAD wrapper
├── asr.py                        # Deepgram streaming ASR client
├── tts.py                        # Cartesia TTS (persistent WebSocket, sonic-2)
├── openclaw_client.py            # OpenClaw protocol v3 Python client
├── config.py                     # Configuration (API keys, thresholds)
└── requirements.txt
```

## Implementation Notes

### Core Feature 1: Spectacles Audio Capture

Reference implementation from Snap's AI Playground:

```typescript
// StreamingAudioBridge.ts — key pattern
@component
export class StreamingAudioBridge extends BaseScriptComponent {
    private micProvider: MicrophoneAudioProvider
    private audioOutput: AudioOutputProvider
    private pcmBuffer: Int16Array
    private energyThreshold: number = 50  // Skip silence frames

    initialize(micTrack: AudioTrackAsset, outputTrack: AudioTrackAsset) {
        this.micProvider = micTrack.control as MicrophoneAudioProvider
        this.micProvider.sampleRate = 16000
        this.pcmBuffer = new Int16Array(this.micProvider.maxFrameSize)

        this.audioOutput = outputTrack.control as AudioOutputProvider
        this.audioOutput.sampleRate = 16000  // Match server output rate
    }

    startCapture() {
        this.micProvider.start()
        // Read frames on every update tick
        this.createEvent("UpdateEvent").bind(() => this.onUpdate())
    }

    private onUpdate() {
        const shape = this.micProvider.getAudioFramePCM16(this.pcmBuffer)
        const frameSize = shape.x  // number of samples read

        if (frameSize <= 0) return

        // Energy-gate: compute RMS, skip if below threshold
        const samples = this.pcmBuffer.subarray(0, frameSize)
        const rms = this.computeRMS(samples)
        if (rms < this.energyThreshold) return

        // Send as binary WebSocket frame
        const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
        this.socket.send(bytes)
    }

    playAudioChunk(data: Uint8Array) {
        // Convert PCM16 (Int16) to Float32 for AudioOutputProvider
        const int16 = new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2)
        const float32 = new Float32Array(int16.length)
        for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i] / 32768.0
        }
        const shape = new vec3(float32.length, 1, 1)  // frames × channels × 1
        this.audioOutput.enqueueAudioFrame(float32, shape)
    }

    private computeRMS(samples: Int16Array): number {
        let sum = 0
        for (let i = 0; i < samples.length; i++) {
            sum += samples[i] * samples[i]
        }
        return Math.sqrt(sum / samples.length)
    }
}
```

### Core Feature 2: WebSocket Binary Frame Handling

Modify `OpenClawBridge.ts` to handle binary frames:

```typescript
// In createWebSocket() → onmessage handler
this.socket.onmessage = async (event: WebSocketMessageEvent) => {
    if (typeof event.data === "string") {
        // Existing JSON protocol
        this.onSocketMessage(event.data)
    } else if (event.data instanceof Blob) {
        // Check if this is audio binary or text blob
        const bytes = event.data.bytes()
        if (this.isStreamingAudio) {
            // Route to audio bridge
            this.onBinaryAudioFrame.invoke(bytes)
        } else {
            // Legacy: convert to text
            const text = await event.data.text()
            this.onSocketMessage(text)
        }
    }
}
```

### Core Feature 3: Voice State Machine

```typescript
// StreamingVoiceController.ts — state machine
enum VoiceState { IDLE, LISTENING, PROCESSING, RESPONDING }

class StreamingVoiceController {
    private state: VoiceState = VoiceState.IDLE
    private audioBridge: StreamingAudioBridge

    // Server tells us state transitions via JSON messages
    handleServerMessage(msg: any) {
        switch (msg.type) {
            case "vad.speech_start":
                this.transitionTo(VoiceState.LISTENING)
                break
            case "vad.speech_end":
                this.transitionTo(VoiceState.PROCESSING)
                break
            case "response.audio":
                this.transitionTo(VoiceState.RESPONDING)
                break
            case "response.done":
                this.transitionTo(VoiceState.IDLE)
                break
        }
    }

    // Barge-in: detected on-device when mic has energy during RESPONDING
    private checkBargeIn(rms: number) {
        if (this.state === VoiceState.RESPONDING && rms > this.bargeInThreshold) {
            this.audioBridge.flushPlayback()
            this.sendControl({ type: "response.cancel" })
            this.transitionTo(VoiceState.LISTENING)
        }
    }
}
```

### Core Feature 4: Proxy Server Pipeline

```python
# pipeline.py — key orchestration pattern
class VoicePipeline:
    def __init__(self, ws, openclaw_client, asr, tts, vad):
        self.ws = ws  # WebSocket to Spectacles
        self.openclaw = openclaw_client
        self.asr = asr
        self.tts = tts
        self.vad = vad
        self.state = "idle"
        self.token_buffer = ""

    async def handle_audio_frame(self, pcm_bytes: bytes):
        """Called for each binary WebSocket frame from Spectacles"""
        is_speech = self.vad.process(pcm_bytes)

        if is_speech and self.state == "idle":
            self.state = "listening"
            self.asr.start_stream()
            await self.ws.send_json({"type": "vad.speech_start"})

        if self.state == "listening":
            self.asr.feed_audio(pcm_bytes)

        if not is_speech and self.state == "listening":
            # Silence detected → commit
            self.state = "processing"
            transcript = await self.asr.finalize()
            await self.ws.send_json({"type": "vad.speech_end"})
            await self.ws.send_json({"type": "transcript.delta", "text": transcript, "isFinal": True})

            # Send to OpenClaw
            await self.process_with_openclaw(transcript)

    async def process_with_openclaw(self, text: str):
        """Send transcript to OpenClaw, stream TTS as tokens arrive.

        Producer-consumer pattern: LLM tokens push sentences to queue,
        background TTS consumer synthesizes in parallel.
        """
        self.token_buffer = ""
        tts_queue = asyncio.Queue()
        tts_task = asyncio.create_task(self._tts_consumer(tts_queue))

        async for token in self.openclaw.chat_send_streaming(text):
            self.token_buffer += token
            await self.ws.send_json({"type": "response.text.delta", "delta": token})

            # Check for sentence boundary — push to TTS queue (non-blocking)
            if len(self.token_buffer) >= 20 and SENTENCE_BOUNDARY.search(self.token_buffer):
                await tts_queue.put(self.token_buffer.strip())
                self.token_buffer = ""

        # Flush remaining + signal done
        if self.token_buffer.strip():
            await tts_queue.put(self.token_buffer.strip())
        await tts_queue.put(None)
        await tts_task

        await self.ws.send_json({"type": "response.done"})
        self.state = "idle"

    async def _tts_consumer(self, queue):
        """Background: pull sentences, synthesize TTS, send audio."""
        while True:
            sentence = await queue.get()
            if sentence is None:
                break
            async for audio_chunk in self.tts.synthesize_streaming(sentence):
                await self.ws.send_bytes(audio_chunk)

    async def handle_cancel(self):
        """Barge-in: cancel everything"""
        self.openclaw.abort()
        self.tts.cancel()
        self.asr.reset()
        self.state = "idle"
```

### Core Feature 5: Enhanced Barge-In with False Interruption Recovery

Based on LiveKit agents SDK and Vapi production patterns:

```python
# pipeline.py — enhanced barge-in handler
class VoicePipeline:
    BARGE_IN_CONFIG = {
        "min_interruption_duration": 0.5,    # 500ms sustained speech required
        "false_interruption_timeout": 2.0,   # Wait for real words after interrupt
        "resume_false_interruption": True,    # Auto-resume on false positive
        "barge_in_confidence_threshold": 0.6, # Reject low-confidence during SPEAKING
    }

    async def handle_barge_in(self, pcm_bytes: bytes):
        """Called when VAD detects speech during SPEAKING state"""
        if self.state != "speaking":
            return

        # Track sustained speech duration
        self.barge_in_speech_duration += 0.02  # 20ms per frame
        if self.barge_in_speech_duration < self.BARGE_IN_CONFIG["min_interruption_duration"]:
            return  # Not sustained enough — could be cough/noise

        # INTERRUPT: cascade cancellation
        self.state = "interrupting"
        self.openclaw.abort()         # 1. Abort LLM generation
        self.tts.cancel()             # 2. Stop TTS synthesis
        await self.ws.send_json({     # 3. Tell client to flush audio
            "type": "response.cancel",
            "interrupted_at": self.tts_chars_played  # For context truncation
        })
        self.asr.start_stream()       # 4. Start new ASR session

        # Wait for real words (false interruption detection)
        self.false_interrupt_timer = asyncio.create_task(
            self._check_false_interruption()
        )
        self.state = "listening"

    async def _check_false_interruption(self):
        """If no words arrive within timeout, resume agent speech"""
        await asyncio.sleep(self.BARGE_IN_CONFIG["false_interruption_timeout"])
        if not self.asr.has_words and self.BARGE_IN_CONFIG["resume_false_interruption"]:
            # False positive — resume from where we left off
            await self._resume_speech()
            await self.ws.send_json({"type": "agent.false_interruption"})
```

### Core Feature 6: Context Truncation on Interrupt

Critical for chat quality — only keep what the user actually heard:

```python
# pipeline.py — context management
async def truncate_on_interrupt(self, interrupted_at_chars: int):
    """Truncate agent response in chat history to what user heard"""
    if self.current_response_text and interrupted_at_chars > 0:
        heard_text = self.current_response_text[:interrupted_at_chars]
        # Update OpenClaw chat context with truncated response
        # This prevents LLM from assuming user heard information they didn't
        self.chat_history[-1]["content"] = heard_text + " [interrupted]"
```

### Patterns & Best Practices

> See `docs/ai/implementation/knowledge-voice-bot-best-practices.md` for comprehensive analysis from LiveKit, Pipecat, and industry sources.

**Fundamentals**:
- **Binary/Text frame separation**: All binary WebSocket frames are audio PCM16. All text frames are JSON control messages. Never mix.
- **Energy-gate on device**: Don't send silence. Compute RMS per frame, skip if below threshold. Saves bandwidth and server CPU.
- **State machine**: Both Spectacles and proxy server maintain the same state machine. Server is authoritative.

**VAD (from Silero/LiveKit)**:
- Use 4-state VAD: QUIET → STARTING (200ms) → SPEAKING → STOPPING (550ms)
- **prefix_padding=500ms**: Prepend pre-speech audio to avoid clipping first syllable
- **activation_threshold=0.5**: Balance between sensitivity and noise rejection
- **500ms grace period at speech start**: Don't process/clip word onsets

**TTS Streaming (from LiveKit SentenceStreamPacer)**:
- **Sentence-boundary TTS**: Buffer LLM tokens until `.!?;\n` or clause boundary, then send to TTS
- **Adaptive pacing**: Don't synthesize next batch until playback buffer drops below 3s
- **max_text_length=300 chars**: Cap per TTS request for consistent latency
- **Persistent WebSocket to TTS provider**: Avoid 50-200ms reconnection overhead per sentence

**Barge-In (from LiveKit/Vapi)**:
- **min_interruption_duration=500ms**: Prevent false interrupts from coughs/noise
- **False interruption recovery**: Wait 2s for real words; auto-resume if none arrive
- **Confidence threshold=0.6 during SPEAKING**: Reject low-confidence STT during agent speech
- **Context truncation**: Only record what user actually heard in chat history
- **Cancellation cascade order**: abort LLM → stop TTS → flush audio buffer → activate listening (must complete in <100ms)

**Jitter Buffer (from production systems)**:
- Queue 2-3 incoming audio frames (40-60ms) before starting playback on LAN
- Insert silence frames on underrun (no clicks/pops)
- Drop oldest frames on overrun

**Turn Detection (Phase 2)**:
- Deepgram endpointing (free, built-in to ASR API) as simplest upgrade
- Pipecat Smart Turn v3 (8MB, 10ms inference) for audio-native detection
- LiveKit EOU model (135MB, 50ms inference) for semantic understanding

## Integration Points

### Spectacles ↔ Proxy Server
- Single WebSocket connection (same URL format as current OpenClaw: `ws://host:port`)
- Binary frames: PCM16 audio (640 bytes per 20ms frame at 16kHz)
- Text frames: JSON control messages (session.start, response.cancel, transcript.delta, etc.)

### Proxy Server ↔ OpenClaw
- Standard OpenClaw protocol v3 (WebSocket, JSON request/response)
- `chat.send` with text (ASR transcript) and optional `attachments` (visual queries)
- `chat` events with `state: "delta"` for streaming text (accumulated in `message.content`)
- `chat` events with `state: "final"` for response completion
- `chat.abort` for barge-in cancellation
- Note: `agent` events have `data` field = accumulated state, NOT incremental tokens

### Proxy Server ↔ Deepgram ASR
- WebSocket streaming API (`wss://api.deepgram.com/v1/listen`)
- Send PCM16 audio frames
- Receive JSON transcript events

### Proxy Server ↔ Cartesia TTS
- Persistent WebSocket API (`wss://api.cartesia.ai/tts/ws`, via `client.tts.websocket_connect()`)
- Pre-connected at session start (`tts.warmup()`) to eliminate first-request handshake
- Each sentence gets its own context: `ctx.send()` + `ctx.no_more_inputs()` → `async for event in ctx.receive()`
- Send text, receive PCM16 audio chunks (~0.41s per sentence synthesis latency)

## Error Handling

| Scenario | Handling |
|---|---|
| WebSocket disconnect during streaming | Auto-reconnect (existing logic). Resume in IDLE state. |
| ASR service unavailable | Fall back to on-device `AsrModule` (text mode) |
| TTS service unavailable | Fall back to on-device `TextToSpeechModule` (text mode) |
| OpenClaw timeout | Send error to Spectacles, resume IDLE state |
| Audio buffer underrun | Insert silence frame (zeros), no audible pop |
| Audio buffer overrun | Drop oldest frames, log warning |
| Barge-in during PROCESSING | Cancel ASR/OpenClaw, start new listening session |

## Performance Considerations

### Bandwidth Budget
| Stream | Rate | Bandwidth |
|---|---|---|
| Mic → Server (PCM16, 16kHz, mono) | 50 frames/s × 640 bytes | 32 KB/s |
| Server → Speaker (PCM16, 16kHz, mono) | 50 frames/s × 640 bytes | 32 KB/s |
| Control messages (JSON) | ~1-5 messages/s | < 1 KB/s |
| **Total** | | **~65 KB/s bidirectional** |

WiFi capacity on Spectacles: >> 1 MB/s. No bandwidth concern.

### Latency Budget (Target: < 1000ms mouth-to-ear, excluding LLM)
| Stage | Measured | Notes |
|---|---|---|
| VAD speech_end detection | 550ms | min_silence_duration threshold |
| Network (Spectacles → Proxy) | ~5ms | LAN |
| ASR finalize | ~200ms | Deepgram finalize after speech_end |
| Network (Proxy → OpenClaw) | ~1ms | Same machine or LAN |
| LLM first token | 2-11s | **Model-dependent, largest variable** (Qwen via OpenClaw) |
| Sentence buffer | ~350ms | Accumulate 20+ chars to sentence boundary |
| TTS first chunk (WebSocket) | ~410ms | Cartesia persistent WebSocket, pre-connected |
| Network (Proxy → Spectacles) | ~5ms | LAN |
| **Proxy overhead** | **~760ms** | Sentence buffer + TTS (excluding LLM) |
| **Total** | **LLM + ~1.5s** | LLM latency dominates; proxy adds <1s |

Note: TTS was previously using SSE (2.75s first chunk). Switching to persistent WebSocket
reduced TTS latency by ~85% (2.75s → 0.41s). Pre-connecting at session start eliminates
the WebSocket handshake overhead on first sentence.

## Security Notes

- Audio data is transient — processed in memory, never written to disk
- WebSocket auth reuses OpenClaw gateway token
- Permission Alerts ensure user consent for mic access on every session
- No PII stored in proxy server logs (transcript may be logged for debugging, disable in production)
- Proxy server should bind to LAN only (not exposed to internet)

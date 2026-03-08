# Spectacles + LiveKit: Workarounds & Real-Time Audio Streaming

> Date: 2026-03-04
> Context: Deep research into whether Snap Spectacles can participate in real-time audio/video communication despite lacking WebRTC.
> Key finding: Spectacles HAVE raw audio APIs — previous analysis was incomplete. Full bidirectional audio streaming over WebSocket is proven and working (Snap's own AI Playground sample does it).

---

## 1. Critical Correction: Spectacles Raw Audio APIs Exist

### What Was Wrong in Initial Analysis

Initial analysis stated Spectacles only have ASR text output and JPEG snapshots. **This was incomplete.** The platform has full raw audio I/O:

### Available Raw Audio/Video APIs

| API | Class | What It Does | Format |
|---|---|---|---|
| **Mic input (raw)** | `MicrophoneAudioProvider` | Raw PCM frames from microphone | `Float32Array` or `Int16Array` (PCM16) |
| **Audio output (raw)** | `AudioOutputProvider` | Play raw PCM frames to speakers | `Float32Array` |
| **WebSocket binary send** | `WebSocket.send()` | Send binary data | `Uint8Array` |
| **WebSocket binary receive** | `Blob.bytes()` | Receive binary data | `Uint8Array` |
| **Continuous camera frames** | `CameraModule.onNewFrame` | Steady stream of camera frames | Texture (opaque handle) |
| **ASR (text, on-device)** | `AsrModule` | Speech-to-text transcription | `string` (text only) |
| **TTS (on-device)** | `TextToSpeechModule` | Text-to-speech synthesis | `AudioTrackAsset` (no raw bytes out) |

### MicrophoneAudioProvider API

Source: [developers.snap.com/lens-studio/api/lens-scripting/classes/Built-In.MicrophoneAudioProvider.html](https://developers.snap.com/lens-studio/api/lens-scripting/classes/Built-In.MicrophoneAudioProvider.html)

Setup: Add "Audio From Microphone" asset in Lens Studio → access via `audioTrack.control as MicrophoneAudioProvider`.

```typescript
// Properties
microphoneProvider.sampleRate: number       // Read/write sample rate
microphoneProvider.maxFrameSize: number     // Max frame size (readonly)

// Methods
microphoneProvider.start(): void            // Begin capturing
microphoneProvider.stop(): void             // Stop capturing
microphoneProvider.getAudioFrame(buf: Float32Array): vec3    // Float32 PCM frames
microphoneProvider.getAudioFramePCM16(buf: Int16Array): vec3 // PCM16 frames (Int16)
```

Call `getAudioFramePCM16()` on each `UpdateEvent` tick to read continuous audio frames.

### AudioOutputProvider API

Source: [developers.snap.com/lens-studio/features/audio/audio-track-assets](https://developers.snap.com/lens-studio/features/audio/audio-track-assets)

Setup: Add "Audio Output" asset in Lens Studio → access via `audioTrack.control as AudioOutputProvider`.

```typescript
// Properties
audioOutputProvider.sampleRate: number              // 4000–48000 Hz
audioOutputProvider.maxFrameSize: number             // readonly

// Methods
audioOutputProvider.enqueueAudioFrame(buf: Float32Array, shape: vec3): void
audioOutputProvider.getPreferredFrameSize(): number  // How many samples system wants
```

### WebSocket Binary Support

Source: [developers.snap.com/spectacles/about-spectacles-features/apis/web-socket](https://developers.snap.com/spectacles/about-spectacles-features/apis/web-socket)

```typescript
// Sending binary
const int16Buf: Int16Array = micProvider.getAudioFramePCM16(buffer);
const uint8View = new Uint8Array(int16Buf.buffer);
socket.send(uint8View);  // Binary WebSocket frame

// Receiving binary
socket.binaryType = 'blob';  // Only 'blob' supported, NOT 'arraybuffer'
socket.onmessage = (event) => {
    const bytes: Uint8Array = event.data.bytes();
    // Convert to Float32Array for playback
    const int16View = new Int16Array(bytes.buffer);
    const float32Buf = new Float32Array(int16View.length);
    for (let i = 0; i < int16View.length; i++) {
        float32Buf[i] = int16View[i] / 32767.0;
    }
    audioOutputProvider.enqueueAudioFrame(float32Buf, shape);
};
```

### Proven Working: Snap's AI Playground Sample

Snap's official sample repo (`github.com/Snapchat/Spectacles-Sample`) contains the **AI Playground** project implementing full bidirectional audio streaming to OpenAI Realtime API and Gemini Live API.

Implementation uses `RemoteServiceGateway.lspkg` helpers:
- `MicrophoneRecorder` — wraps `MicrophoneAudioProvider`, emits `onAudioFrame` events
- `AudioProcessor` — buffers raw frames, base64-encodes PCM16, emits `onAudioChunkReady`
- `DynamicAudioOutput` — receives base64 PCM16, decodes, plays via `AudioOutputProvider`
- `VideoController` — encodes camera frames for visual AI processing

Audio specs used: Gemini Live = 16 kHz input, OpenAI Realtime = 24 kHz input/output.

---

## 2. Permission System — The Real Constraint

### Permission Modes

| Mode | Mic + Internet | Camera + Internet | Publishable? | User Experience |
|---|---|---|---|---|
| **Default** | BLOCKED | BLOCKED | Yes | Normal |
| **RemoteServiceGateway (RSG)** | ALLOWED (RSG endpoints only) | ALLOWED (RSG endpoints only) | Yes | Normal |
| **Experimental + Permission Alerts** | ALLOWED (any server) | ALLOWED (any server) | Yes | Permission prompt every launch + LED blinks |
| **Experimental (no alerts)** | ALLOWED (any server) | ALLOWED (any server) | Draft only | Watermark |

### What Changed at Lens Fest 2025 / Snap OS 2.0

**Before**: Lenses combining mic + internet could NOT be published at all.

**Now**: Permission Alerts (requires Lens Studio v5.15.0+ and Spectacles OS v5.64+) allow publishing with:
- User sees permission prompt on every lens launch
- Privacy LED blinks continuously during capture
- Lens carries "Experimental" designation

### RemoteServiceGateway Exception

Access to Snap's Remote Service Gateway does NOT count as "external internet access." Published lenses CAN stream mic audio through RSG to approved endpoints (OpenAI, Gemini, Lyria, Snap3D) without Experimental mode.

**Implication**: If OpenClaw could be proxied through an RSG-compatible pattern, the permission restriction could be bypassed entirely. Otherwise, Permission Alerts mode is required for custom servers.

---

## 3. The Complete Viable Pipeline

### Current Architecture (Text + Snapshots)

```
ASR (on-device text) → WebSocket text → OpenClaw → WebSocket text → TTS (on-device)
```

### New Architecture (Raw Audio Streaming)

```
MicrophoneAudioProvider (PCM16)
  → Int16Array → Uint8Array
  → WebSocket binary frame
  → Server (OpenClaw / Proxy)
  → Server-side ASR + LLM + TTS
  → PCM audio bytes
  → WebSocket binary frame
  → Uint8Array → Float32Array
  → AudioOutputProvider.enqueueAudioFrame()
  → Speaker playback
```

### What Changes in JarvisController.ts

| Component | Current | New |
|---|---|---|
| Audio input | `AsrModule` (text transcription) | `MicrophoneAudioProvider` (raw PCM16) |
| Audio output | `TextToSpeechModule` (on-device TTS) | `AudioOutputProvider` (raw PCM playback) |
| WebSocket data | Text JSON messages | Binary PCM16 frames + JSON control messages |
| ASR processing | On-device | Server-side (Whisper/Deepgram) |
| TTS processing | On-device | Server-side (ElevenLabs/Cartesia/etc.) |

---

## 4. Workaround Architectures (Ranked)

### Option 1: LiveKit Agent as WebSocket-to-WebRTC Proxy

```
Spectacles ──[WS: PCM16 binary]──► Proxy Agent Server (Python/Go)
                                        │
                            ┌───────────┴───────────┐
                            │  livekit.rtc.AudioSource  │
                            │  capture_frame(AudioFrame) │
                            │  publish_track(audio_track)│
                            └───────────┬───────────┘
                                        │
                                        ▼
                                  LiveKit Room (SFU)
                                        │
                            ┌───────────┴───────────┐
                            │  Subscribe to room audio  │
                            │  AudioFrame → PCM16 bytes │
                            └───────────┬───────────┘
                                        │
Spectacles ◄──[WS: PCM16 binary]────────┘
```

**How it works:**
1. Python/Go server runs a LiveKit Agent that joins the room as a participant
2. Agent listens on a WebSocket for PCM16 audio from the glasses
3. Wraps received PCM into `AudioFrame` objects
4. Pushes them into an `AudioSource`, publishes as LiveKit audio track
5. Subscribes to room audio tracks, converts `AudioFrame` → PCM16
6. Streams audio back to glasses over the same WebSocket

**LiveKit Python SDK API:**
```python
source = rtc.AudioSource(sample_rate=16000, num_channels=1)
track = rtc.LocalAudioTrack.create_audio_track("glasses-mic", source)
await room.local_participant.publish_track(track)
# Per frame:
frame = rtc.AudioFrame(data=pcm_bytes, sample_rate=16000, num_channels=1, samples_per_channel=320)
await source.capture_frame(frame)
```

**Existing references:**
- `livekit/websocket-bridge` (official) — accepts WebM/Opus over WebSocket, publishes to LiveKit room
- `Sean-Der/livekit-microcontroller-bridge` — ESP32 proof of concept for constrained devices

**Pros:** Multi-party rooms, full LiveKit features, proven SDK
**Cons:** Highest complexity, extra server component, ~150-300ms latency

### Option 2: Pipecat with WebSocket Transport (No LiveKit Needed)

```
Spectacles ──[WS: PCM16]──► Pipecat Server
                                │
                    ┌───────────┴───────────┐
                    │ FastAPIWebsocketTransport │
                    │ VAD → ASR → LLM → TTS     │
                    │ (Deepgram/Whisper/OpenAI)  │
                    └───────────┬───────────┘
                                │
Spectacles ◄──[WS: PCM16]──────┘
```

**What:** Open-source Python framework for real-time voice AI agents
**Key feature:** First-class WebSocket transport — no WebRTC anywhere
**Pipeline:** Audio in → VAD → ASR (Deepgram/Whisper) → LLM (OpenAI/Anthropic/OpenClaw) → TTS (ElevenLabs/Cartesia) → Audio out
**Also supports:** LiveKit, Daily, Twilio as alternative transport backends for upgrade path
**Repo:** `github.com/pipecat-ai/pipecat`
**Docs:** `docs.pipecat.ai/server/services/transport/websocket-server`

**Pros:** Simplest architecture, built-in voice AI pipeline, no WebRTC complexity
**Cons:** 1:1 only (no multi-party rooms), Python server overhead

### Option 3: TEN Framework (Agora, Embedded-Focused)

```
Spectacles ──[WS]──► TEN Agent Server (C++ core)
                         │
                   ASR → LLM → TTS
                         │
Spectacles ◄──[WS]──────┘
```

**What:** Open-source from Agora, designed for embedded/constrained devices
**Key feature:** WebSocket as first-class transport alongside RTC and SIP
**Core:** Lightweight C++ (runs even on ESP32)
**Repo:** `github.com/TEN-framework/ten-framework`

**Pros:** Lightweight, embedded-focused, multiple transport options
**Cons:** Less mature ecosystem than Pipecat, smaller community

### Option 4: Direct OpenClaw Enhancement (Simplest)

```
Spectacles ──[WS: PCM16 + JPEG]──► OpenClaw Gateway (enhanced)
                                        │
                            Server-side:
                            - ASR (Whisper/Deepgram)
                            - LLM (existing OpenClaw)
                            - TTS (ElevenLabs/etc.)
                                        │
Spectacles ◄──[WS: PCM16 audio]────────┘
```

**What:** Enhance existing OpenClaw gateway to handle raw audio instead of text
**Wire protocol:** Adopt OpenAI Realtime API format:
```json
// Client → Server
{"type": "input_audio_buffer.append", "audio": "<base64-pcm16>"}

// Server → Client
{"type": "response.audio.delta", "delta": "<base64-pcm16>"}
```

**Pros:** Minimal new infrastructure, extends existing architecture, lowest complexity
**Cons:** 1:1 only, must add ASR/TTS to server, no multi-party

---

## 5. Comparison Matrix

| | Option 1: LiveKit Proxy | Option 2: Pipecat | Option 3: TEN | Option 4: OpenClaw |
|---|---|---|---|---|
| **Multi-party rooms** | Yes | No (1:1) | No (1:1) | No (1:1) |
| **WebRTC needed** | Server-side only | No | No | No |
| **New infrastructure** | LiveKit + Agent server | Pipecat server | TEN server | Enhance existing |
| **Latency (estimated)** | ~150-300ms | ~100-200ms | ~100-200ms | ~100-200ms |
| **Complexity** | High | Medium | Medium | Low |
| **Voice AI pipeline** | DIY | Built-in (VAD+ASR+LLM+TTS) | Built-in | DIY |
| **Spectacles code changes** | Replace ASR→raw mic | Replace ASR→raw mic | Replace ASR→raw mic | Replace ASR→raw mic |
| **Upgrade path** | Full LiveKit ecosystem | Can add LiveKit later | Can add RTC later | Can add any later |
| **Best for** | Multi-user collaboration | Voice AI assistant | IoT/embedded focus | Quick iteration |

---

## 6. Alternative Frameworks to LiveKit (Same Idea, Different Protocol)

### WebSocket-Native Real-Time Audio Frameworks

| Framework | Transport | Language | Notes |
|---|---|---|---|
| **Pipecat** | WebSocket (first-class) | Python | Best for voice AI. Also supports LiveKit/Daily/Twilio backends |
| **TEN Framework** | WebSocket + RTC + SIP | C++ core | From Agora. Runs on ESP32. WebSocket voice assistant quickstart |
| **AG2 WebSocket Audio Adapter** | WebSocket | Python | Microsoft AutoGen fork. `WebSocketAudioAdapter` for AI agents |
| **VoiceStreamAI** | WebSocket | Python | WebSocket server + Whisper ASR. ASR only, not bidirectional |
| **3LAS** | WebSocket | TypeScript | Browser-only audio streaming. Not for embedded |

### WebRTC SFUs with Server-Side Audio Injection

| SFU | Bridge Method | Notes |
|---|---|---|
| **LiveKit** | Agent SDK (`AudioSource` + `AudioFrame`) | Best documented. Python/Go/Node SDKs |
| **LiveKit** | `websocket-bridge` (official repo) | Accepts WebM/Opus over WS, publishes to room |
| **mediasoup** | `PlainTransport` (raw RTP/UDP) | Accepts RTP from any source without WebRTC |
| **Janus** | RTP Forwarders | Forward external RTP into rooms |
| **GStreamer** | `webrtcsink` with LiveKit backend | GStreamer pipeline → LiveKit room |

### Commercial WebSocket Audio APIs (Wire Protocol References)

| Service | Protocol | Audio Format | Direction |
|---|---|---|---|
| **OpenAI Realtime API** | `wss://` WebSocket | Base64 PCM16, 24kHz | Bidirectional |
| **Twilio Media Streams** | WebSocket + JSON | 8kHz MULAW, base64 | Bidirectional |
| **Vonage Voice WS** | WebSocket binary | PCM | Bidirectional |
| **Google Gemini Live** | WebSocket | PCM/base64, 16kHz | Bidirectional |
| **AssemblyAI Streaming** | `wss://` | 16kHz+ PCM16/MULAW | Input only (ASR) |

---

## 7. Recommended Wire Protocol for Spectacles Audio Streaming

Based on industry standards (OpenAI Realtime, Twilio, Gemini Live), recommended protocol:

### Binary Mode (Lower Latency, Recommended)

```
Client → Server:
  Binary WebSocket frames: raw int16le PCM, 16kHz mono, 20ms chunks (320 samples = 640 bytes)

Server → Client:
  Binary WebSocket frames: raw int16le PCM, 16kHz or 24kHz mono
```

### JSON Mode (Easier Debugging, Higher Overhead)

```
Client → Server:
  {"type": "audio.input", "audio": "<base64-pcm16>", "sampleRate": 16000}

Server → Client:
  {"type": "audio.output", "audio": "<base64-pcm16>", "sampleRate": 24000}
  {"type": "transcript", "text": "...", "isFinal": true}
  {"type": "response.text", "text": "..."}
```

### Hybrid Mode (Recommended for OpenClaw Integration)

```
Control messages: JSON text WebSocket frames
  {"type": "session.start", "config": {"sampleRate": 16000, "channels": 1}}
  {"type": "audio.commit"}  // signal end of utterance
  {"type": "response.cancel"}  // barge-in

Audio data: Binary WebSocket frames
  Raw int16le PCM bytes (no JSON wrapping, no base64 overhead)
```

---

## 8. Recommendation

**Start with Option 4 (Direct OpenClaw enhancement):**
- Smallest change to existing architecture
- Swap ASR text for raw mic PCM on Spectacles side
- Add server-side ASR (Whisper/Deepgram) + TTS (ElevenLabs/Cartesia) to OpenClaw
- Use binary WebSocket frames for audio, JSON for control

**Upgrade to Option 1 (LiveKit Agent Proxy) when:**
- You need multiple human participants in the same room
- You need screen sharing, video, or complex media routing
- You want to connect phone/laptop users alongside Spectacles users

**Consider Option 2 (Pipecat) if:**
- You want a batteries-included voice AI pipeline
- You don't want to build VAD + ASR + TTS orchestration yourself
- You want an easy upgrade path to LiveKit later

---

## 9. References

### Snap Spectacles APIs
- [MicrophoneAudioProvider](https://developers.snap.com/lens-studio/api/lens-scripting/classes/Built-In.MicrophoneAudioProvider.html)
- [AudioOutputProvider](https://developers.snap.com/lens-studio/api/lens-scripting/classes/Built-In.AudioOutputProvider.html)
- [Audio Tracks](https://developers.snap.com/lens-studio/features/audio/audio-track-assets)
- [WebSocket API](https://developers.snap.com/spectacles/about-spectacles-features/apis/web-socket)
- [WebSocket Class](https://developers.snap.com/lens-studio/api/lens-scripting/classes/Built-In.WebSocket.html)
- [Camera Module](https://developers.snap.com/spectacles/about-spectacles-features/apis/camera-module)
- [RSG Overview](https://developers.snap.com/spectacles/about-spectacles-features/apis/remoteservice-gateway)
- [Permission Overview](https://developers.snap.com/spectacles/permission-privacy/overview)
- [Experimental APIs](https://developers.snap.com/spectacles/permission-privacy/experimental-apis)
- [ASR Module](https://developers.snap.com/spectacles/about-spectacles-features/apis/asr-module)
- [AI Playground Sample](https://github.com/Snapchat/Spectacles-Sample)

### LiveKit WebSocket Bridge Solutions
- [livekit/websocket-bridge](https://github.com/livekit/websocket-bridge) — Official WebSocket-to-LiveKit bridge
- [Sean-Der/livekit-microcontroller-bridge](https://github.com/Sean-Der/livekit-microcontroller-bridge) — ESP32 bridge
- [LiveKit Agents SDK](https://docs.livekit.io/agents/)
- [livekit.rtc.AudioSource](https://docs.livekit.io/python/livekit/rtc/audio_source.html)
- [LiveKit ESP32 Blog](https://blog.livekit.io/livekit-sdk-for-esp32-bringing-voice-ai-to-embedded-devices/)
- [LiveKit Ingress](https://github.com/livekit/ingress) — RTMP/WHIP ingress

### Alternative Frameworks
- [Pipecat](https://github.com/pipecat-ai/pipecat) — WebSocket-native voice AI framework
- [Pipecat WebSocket Transport Docs](https://docs.pipecat.ai/server/services/transport/websocket-server)
- [TEN Framework](https://github.com/TEN-framework/ten-framework) — Agora embedded-focused framework
- [AG2 WebSocket Audio Adapter](https://dev.to/ag2ai/real-time-voice-interactions-with-the-websocket-audio-adapter-4keb)

### Wire Protocol References
- [OpenAI Realtime API WebSocket](https://platform.openai.com/docs/guides/realtime-websocket)
- [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams)
- [Vonage Voice WebSocket](https://developer.vonage.com/en/voice/voice-api/concepts/websockets)

### WebRTC SFUs with Non-WebRTC Ingress
- [mediasoup PlainTransport](https://mediasoup.org/documentation/v3/mediasoup/api/)
- [Janus RTP Forwarders (FOSDEM 2020)](https://archive.fosdem.org/2020/schedule/event/janus/attachments/audio/3993/export/events/attachments/janus/audio/3993/fosdem2020_janus_rtp_forwarders.pdf)
- [Janus Gateway](https://github.com/meetecho/janus-gateway)

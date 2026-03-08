---
phase: design
title: "Design: Hybrid Voice Bridge"
description: Architecture for native ASR input + server-side streaming TTS output with barge-in
feature: hybrid-voice-bridge
---

# Design: Hybrid Voice Bridge

## Architecture Overview

### Previous Streaming Architecture (Blocked)
```
Spectacles Mic -> MicrophoneAudioProvider -> WebSocket binary -> Voice Proxy
                  ^^^^^^^^^^^^^^^^^^^^^^^^
                  BROKEN: returns zero frames on Spectacles hardware
```

### New Hybrid Architecture
```
Spectacles                              Voice Proxy Server
+-----------------------+               +----------------------------+
|                       |    JSON text   |                            |
| AsrModule (native ASR)|--"query.text"->| Skip VAD/ASR               |
| (handles mic perms)   |   WebSocket   |      |                     |
|                       |               |      v                     |
|                       |               | OpenClaw Client            |
|                       |               |   chat.send(text)          |
|                       |               |      |                     |
|                       |  JSON text    |      v                     |
| Chat UI <-------------|<-"response.*"-| LLM streaming tokens       |
|                       |               |      |                     |
|                       |  binary PCM16 |      v                     |
| AudioOutputProvider <-|<--PCM16 audio-| Cartesia TTS (streaming)   |
| OR Native TTS         |   WebSocket   |                            |
+-----------------------+               +----------------------------+

Barge-in: AsrModule detects speech -> send "response.cancel" -> flush audio
```

### Key Design Decision: Text Input, Audio Output

The proxy server already handles:
- OpenClaw WebSocket client (connect, auth, chat.send, stream response)
- Sentence-boundary detection for TTS batching
- Cartesia TTS with persistent WebSocket (pre-connected, ~0.41s per sentence)
- Parallel LLM+TTS via producer-consumer asyncio.Queue

We keep all of this, but **replace the input path**:
- OLD: Binary PCM16 audio -> VAD -> Deepgram ASR -> text
- NEW: Text directly from Spectacles AsrModule -> skip VAD/ASR

## Data Models

### Control Messages (JSON Text Frames)

```typescript
// Client -> Server: Send transcribed text (replaces binary audio)
interface QueryText {
  type: "query.text"
  text: string                    // Final transcription from AsrModule
  attachment?: {                  // Optional visual query
    data: string                  // Base64 JPEG
    mimeType: string
  }
}

// Client -> Server: Cancel current response (barge-in)
interface ResponseCancel {
  type: "response.cancel"
}

// Client -> Server: Session lifecycle
interface SessionStart {
  type: "session.start"
  config: {
    inputMode: "text"             // NEW: indicates text input, not audio
    outputFormat: "pcm16"         // TTS output format
    sampleRate: 16000
  }
}

// Server -> Client: Response text (streaming)
interface ResponseTextDelta {
  type: "response.text.delta"
  delta: string
  accumulated: string
}

// Server -> Client: Response complete
interface ResponseDone {
  type: "response.done"
  text: string
}

// Server -> Client: Response audio start
interface ResponseAudioStart {
  type: "response.audio.start"
}

// Server -> Client: Error
interface ErrorMessage {
  type: "error"
  message: string
}
```

### Audio Output (Binary Frames - Server to Client only)
```
Binary WebSocket Frame (Server -> Client):
+----------------------------------------+
| Raw PCM16 signed int16 little-endian   |
| 16000 Hz, mono, 20ms chunks           |
| 320 samples = 640 bytes per frame      |
+----------------------------------------+
```

Note: Binary frames are **unidirectional** now (server->client only). Client sends text JSON only.

## Component Breakdown

### Spectacles Side (TypeScript)

#### 1. HybridVoiceController (new, replaces StreamingVoiceController)
- State machine: IDLE -> LISTENING -> PROCESSING -> RESPONDING -> IDLE
- Manages WebSocket connection to voice proxy
- Receives text from AsrModule (via JarvisController)
- Sends `query.text` JSON to proxy
- Receives `response.*` JSON + binary PCM16 audio from proxy
- Handles barge-in: detects new ASR input while RESPONDING

#### 2. ChatASRController (existing, minor changes)
- Already has always-on mode with barge-in detection
- Change: In hybrid mode, route final transcriptions to HybridVoiceController instead of JarvisController.processQuery()
- Change: Emit partial transcriptions for UI updates

#### 3. JarvisController (existing, modify streamingMode path)
- `streamingMode=true` now uses HybridVoiceController instead of StreamingVoiceController
- Routes ASR transcriptions from ChatASRController to HybridVoiceController
- Visual query detection remains the same

#### 4. StreamingAudioBridge (existing, simplified)
- Only used for audio OUTPUT (playback), not input
- AudioOutputProvider confirmed safe — no `@exposesUserData`, not in Spectacles permission table
- Must create AudioComponent and call `play(-1)` before enqueuing frames (per Snap Voice Playback sample pattern)
- Native TTS fallback only for network-down scenarios

### Voice Proxy Side (Python)

#### 5. server.py (modify)
- Accept `session.start` with `inputMode: "text"`
- Handle `query.text` messages (skip VAD/ASR, go directly to OpenClaw)
- Keep binary audio output path unchanged

#### 6. pipeline.py (modify)
- New method: `process_text_query(text, attachment?)` — bypasses VAD/ASR
- Reuse existing: `_stream_response()` (OpenClaw -> sentence buffer -> TTS -> binary audio)
- Reuse existing: parallel LLM+TTS producer-consumer pattern

#### 7. vad.py, asr.py (no changes, but not used in text input mode)

## State Machine

```
                    ASR final transcript
          +---------- received ----------+
          |                              |
          v         send query.text      |
       IDLE ---------> PROCESSING       |
        ^                  |             |
        |          response.audio.start  |
        |                  |             |
        |                  v             |
        +----------- RESPONDING         |
        |  response.done   |             |
        |                  |  ASR input  |
        |                  +---> BARGE-IN
        |                        |
        +--- send response.cancel+
             flush audio
```

### Barge-in Flow (Detailed)
1. State is RESPONDING (agent speaking, TTS audio playing)
2. AsrModule detects speech (partial transcript arrives)
3. Immediately:
   - Send `response.cancel` to proxy
   - Flush local audio playback (AudioOutputProvider or stop native TTS)
   - Transition to LISTENING
4. Proxy receives cancel:
   - Abort OpenClaw streaming
   - Stop TTS synthesis
   - Discard remaining audio
5. AsrModule produces final transcript -> send as new `query.text`

## Design Decisions

### D1: Keep voice proxy (don't go direct to OpenClaw)
**Decision**: Keep the proxy even though ASR is now on-device.
**Rationale**:
- Proxy still provides streaming TTS (Cartesia) which is much better than native TTS
- Proxy handles sentence-boundary detection for natural TTS
- Proxy manages OpenClaw connection lifecycle
- Future upgrade path: if MicrophoneAudioProvider permissions are fixed, can re-enable full audio streaming

### D2: AudioOutputProvider — Confirmed No Permission Issues
**Decision**: Use AudioOutputProvider for streaming TTS audio playback. Keep native TTS as fallback only for network failures.
**Rationale**:
- **No `@exposesUserData` annotation** on `enqueueAudioFrame()` or `getPreferredFrameSize()` (unlike MicrophoneAudioProvider which has it on both methods)
- **Not listed in Spectacles permission table** — audio output is unrestricted (only Microphone, Camera, Location, etc. require permissions)
- **Snap Voice Playback sample** uses AudioOutputProvider directly without any permission flow
- Native TTS fallback kept for network-down scenarios only

**Important implementation detail** from Snap Voice Playback sample:
An `AudioComponent` must be created and `play(-1)` called BEFORE enqueuing frames:
```typescript
const audioComponent = sceneObject.createComponent("AudioComponent")
audioComponent.audioTrack = outputTrack
audioComponent.play(-1)  // Required — starts the playback pipeline
audioOutputProvider.enqueueAudioFrame(data, shape)
```
Our current StreamingAudioBridge skips this step — must be added.

### D3: Reuse ChatASRController
**Decision**: Reuse existing ChatASRController with its always-on mode rather than building new ASR handling.
**Rationale**:
- ChatASRController already has: always-on mode, silence detection, barge-in awareness, activity indicators
- Only need to route its output differently (to proxy instead of direct OpenClaw)

### D4: Endpointing — Tune silenceUntilTerminationMs to 1000ms
**Decision**: Set `AsrModule.AsrTranscriptionOptions.silenceUntilTerminationMs = 1000` (down from default 2000ms).
**Rationale**:
- Server-side Silero VAD achieves ~550ms endpointing, but is unavailable in hybrid mode (no audio reaches the server)
- The native AsrModule uses `silenceUntilTerminationMs` as its sole endpointing mechanism
- Default 2000ms adds unnecessary latency — the user waits 2s of silence before the query is sent
- 1000ms is a good balance: fast enough for conversational feel, long enough to avoid cutting off mid-sentence pauses
- Can be tuned further based on hardware testing (too aggressive = clips natural pauses, too conservative = feels sluggish)
- Combined with proxy overhead (~0.76s), total time-to-first-audio = ~1.76s (within <2s target)

**Configuration**: Set in `ChatASRController.createAlwaysOnASROptions()`:
```typescript
options.silenceUntilTerminationMs = 1000
```

## Non-Functional Requirements

**Performance targets:**
- ASR endpointing: 1000ms silence timeout (tunable)
- Time-to-first-audio: < 2s after user stops speaking (~1s endpointing + ~0.76s proxy)
- Barge-in to silence: < 500ms
- Proxy overhead (text -> OpenClaw -> TTS -> first audio): ~0.76s (measured)

**Reliability:**
- Graceful fallback to classic mode if proxy unreachable
- Reconnection with exponential backoff (existing in StreamingVoiceController)

**Compatibility:**
- Classic mode (streamingMode=false) must continue working unchanged
- ChatBridge/ChatComponent UI must work with both modes

---
phase: implementation
title: "Implementation: Hybrid Voice Bridge"
description: Implementation notes and knowledge for native ASR + server-side streaming TTS
feature: hybrid-voice-bridge
---

# Implementation: Hybrid Voice Bridge

## Key Implementation Knowledge

### Why Hybrid?
`MicrophoneAudioProvider.getAudioFrame()` and `getAudioFramePCM16()` both return zero-size frames (`shape=(0,1,1)`) on Spectacles hardware. The `@exposesUserData` annotation requires mic permission, but no permission prompt appears. Tried: Float32 API, PCM16 API, 44100Hz native rate, 16000Hz, early init in onAwake, delayed init, VoiceMLModule permission flow — all return size=0. The `AsrModule` handles mic permissions internally and works fine.

### Components to Modify

**Voice Proxy (Python):**
- `server.py`: Add `query.text` message handler alongside existing binary audio handler
- `pipeline.py`: Add `process_text_query()` that skips VAD/ASR, goes directly to OpenClaw

**Spectacles (TypeScript):**
- New `HybridVoiceController.ts`: WebSocket + state machine (adapted from StreamingVoiceController)
- Modified `JarvisController.ts`: Route ASR to HybridVoiceController in streaming mode
- Modified `ChatASRController.ts`: Route transcriptions differently in hybrid mode
- `StreamingAudioBridge.ts`: Keep playback path only, remove mic capture code

### Protocol Changes

Old protocol (full streaming):
- Client -> Server: Binary PCM16 audio frames (mic capture)
- Server -> Client: Binary PCM16 audio frames (TTS output)
- Both directions: JSON text frames for control

New protocol (hybrid):
- Client -> Server: JSON text only (`query.text`, `response.cancel`, `session.start`)
- Server -> Client: Binary PCM16 audio frames (TTS output) + JSON text frames (response.text.delta, response.done)

### AudioOutputProvider — Confirmed Safe
- No `@exposesUserData` on `enqueueAudioFrame()` or `getPreferredFrameSize()`
- Not listed in Spectacles permission table (only Microphone, Camera, Location, etc. are restricted)
- Snap Voice Playback sample uses it directly without permission flow
- **Required pattern**: Create `AudioComponent`, assign output track, call `play(-1)` before enqueuing frames

### Existing Code to Reuse
- `StreamingVoiceController.ts` lines 182-215: WebSocket connection pattern (InternetModule)
- `StreamingVoiceController.ts` lines 246-318: JSON message handling (response.*, error)
- `StreamingVoiceController.ts` lines 437-452: Reconnection with exponential backoff
- `StreamingAudioBridge.ts` lines 200-250: Audio playback (playChunkDirect, jitter buffer)
- `ChatASRController.ts` lines 330-420: Always-on ASR with silence detection
- `pipeline.py` `_stream_response()`: LLM -> sentence buffer -> TTS -> binary audio output
- `pipeline.py` producer-consumer pattern for parallel LLM+TTS

## Status
- [ ] Phase 1: Proxy text input mode
- [ ] Phase 2: HybridVoiceController
- [ ] Phase 3: JarvisController integration
- [ ] Phase 4: Testing & polish

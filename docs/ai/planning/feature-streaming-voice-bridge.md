---
phase: planning
title: "Planning: Streaming Voice Bridge"
description: Task breakdown and implementation plan for real-time audio streaming
feature: streaming-voice-bridge
---

# Planning: Streaming Voice Bridge

## Milestones

- [x] **M1: Audio I/O on Spectacles** — Raw mic capture + raw audio playback working over WebSocket
- [x] **M2: Proxy Server MVP** — WebSocket server with VAD + ASR + TTS pipeline, echoes transcription back as audio
- [x] **M3: OpenClaw Integration** — Proxy connects to OpenClaw, streams LLM responses as audio
- [x] **M4: Barge-in & State Machine** — Full conversation state machine with 4-state VAD, false interruption recovery, context truncation, SentenceStreamPacer
- [x] **M5: Polish & Fallback** — Error handling, text-mode fallback, jitter buffering, chat UI integration
- [ ] **M6: Advanced Optimizations** — Turn detector model, preemptive generation, adaptive jitter, noise floor

## Task Breakdown

### Phase 1: Foundation — Audio I/O (M1)

- [x] **Task 1.1: Create `StreamingAudioBridge.ts`**
  - Import `MicrophoneAudioProvider`, configure at 16kHz mono
  - Implement `startCapture()` / `stopCapture()` methods
  - Read PCM16 frames via `getAudioFramePCM16()` on UpdateEvent
  - Energy-gate: skip frames below threshold (don't send silence)
  - Send non-silent frames as `Uint8Array` binary via WebSocket
  - **Dependencies**: None
  - **Effort**: Medium

- [x] **Task 1.2: Add binary WebSocket support to `OpenClawBridge.ts`**
  - Add `sendBinary(data: Uint8Array)` method
  - Handle incoming binary frames in `onmessage` handler (currently only handles text)
  - Route binary frames to a new `onBinaryMessage` event
  - Existing JSON protocol unchanged
  - **Dependencies**: None
  - **Effort**: Small

- [x] **Task 1.3: Implement audio playback in `StreamingAudioBridge.ts`**
  - Import `AudioOutputProvider`, configure at 16kHz/24kHz
  - Receive binary frames from WebSocket → convert `Uint8Array` → `Int16Array` → `Float32Array`
  - Call `enqueueAudioFrame()` for each received chunk
  - Implement simple jitter buffer (queue 2-3 frames before starting playback)
  - **Dependencies**: Task 1.2
  - **Effort**: Medium

- [ ] **Task 1.4: End-to-end audio loopback test** *(manual hardware test)*
  - Create simple Python WebSocket server that echoes received audio back
  - Verify: speak into Spectacles mic → hear own voice from Spectacles speaker
  - Measure round-trip latency
  - **Dependencies**: Tasks 1.1, 1.2, 1.3
  - **Effort**: Small

### Phase 2: Proxy Server MVP (M2)

- [x] **Task 2.1: Python WebSocket server scaffold**
  - FastAPI + `websockets` library
  - Accept binary + text WebSocket frames
  - Handle `session.start` JSON message → initialize per-connection state
  - **Dependencies**: None (parallel with Phase 1)
  - **Effort**: Small

- [x] **Task 2.2: Integrate Silero VAD**
  - Load Silero VAD model (PyTorch, ~2MB)
  - Process incoming PCM16 frames through VAD
  - Detect speech start (300ms threshold) and speech end (500ms silence)
  - Emit `speech_start` / `speech_end` events
  - **Dependencies**: Task 2.1
  - **Effort**: Medium

- [x] **Task 2.3: Integrate streaming ASR (Deepgram)**
  - Open Deepgram WebSocket for real-time transcription
  - Forward audio frames from VAD → Deepgram
  - Receive partial + final transcripts
  - Send `transcript.delta` JSON messages to Spectacles
  - **Dependencies**: Task 2.2
  - **Effort**: Medium

- [x] **Task 2.4: Integrate streaming TTS (Cartesia or ElevenLabs)**
  - Implement streaming TTS: text input → PCM16 audio chunks output
  - Sentence boundary detection (buffer tokens until `.!?`)
  - Send audio chunks as binary WebSocket frames to Spectacles
  - **Dependencies**: Task 2.1
  - **Effort**: Medium

- [x] **Task 2.5: End-to-end ASR → echo TTS test**
  - Speak → proxy transcribes → proxy speaks back the transcription via TTS
  - No LLM involved yet — validates audio pipeline end-to-end
  - Measure latency: speech_end → first TTS audio
  - **Dependencies**: Tasks 2.2, 2.3, 2.4
  - **Effort**: Small

### Phase 3: OpenClaw Integration (M3)

- [x] **Task 3.1: Python OpenClaw client**
  - Implement OpenClaw protocol v3 in Python (connect handshake, token auth)
  - Support `chat.send` with text message
  - Subscribe to `agent` streaming events (token-by-token)
  - Subscribe to `chat` events (final response)
  - Support `chat.abort` for cancellation
  - **Dependencies**: None (parallel with Phase 2)
  - **Effort**: Large (complex protocol)

- [x] **Task 3.2: Wire ASR → OpenClaw → TTS pipeline**
  - On `speech_end`: commit ASR transcript → `chat.send` to OpenClaw
  - On `agent` token events: buffer tokens, detect sentence boundaries
  - On sentence boundary: send to streaming TTS → audio to Spectacles
  - On `chat` final event: flush remaining tokens through TTS
  - **Dependencies**: Tasks 2.3, 2.4, 3.1
  - **Effort**: Large (orchestration complexity)

- [x] **Task 3.3: End-to-end voice conversation test**
  - Full flow: speak → ASR → OpenClaw LLM → TTS → hear response
  - Measure time-to-first-audio
  - Test multi-turn conversation
  - **Dependencies**: Task 3.2
  - **Effort**: Medium

### Phase 4: Barge-in & State Machine (M4)

- [x] **Task 4.1: Create `StreamingVoiceController.ts`**
  - Implement enhanced state machine: IDLE → LISTENING → COMMITTING → PROCESSING → RESPONDING → INTERRUPTING
  - COMMITTING state allows turn detection (Phase 1: pass-through, Phase 2: model-based)
  - INTERRUPTING state ensures clean cancellation cascade
  - Coordinate `StreamingAudioBridge` with state transitions
  - Emit events for chat UI integration
  - **Dependencies**: Phase 1 complete
  - **Effort**: Medium

- [x] **Task 4.2: Implement barge-in on Spectacles**
  - Detect sustained mic input during RESPONDING state (500ms min_interruption_duration)
  - Send `response.cancel` JSON message with `interrupted_at` position
  - Stop local audio playback (`AudioOutputProvider` flush)
  - Transition through INTERRUPTING → LISTENING states
  - **Dependencies**: Task 4.1
  - **Effort**: Medium

- [x] **Task 4.3: Implement barge-in on proxy server**
  - On `response.cancel`: cascading cancellation (abort LLM → stop TTS → flush audio, <100ms)
  - **False interruption recovery**: wait 2s for STT words; if none, auto-resume speech
  - **Context truncation**: truncate agent response in chat history to what user actually heard
  - Confidence threshold (0.6) to reject noise during SPEAKING state
  - **Dependencies**: Task 3.2
  - **Effort**: Large (upgraded from Medium — false interrupt recovery is complex)

- [x] **Task 4.4: Implement 4-state VAD on proxy server**
  - Upgrade from binary speech/silence to: QUIET → STARTING (200ms) → SPEAKING → STOPPING (550ms)
  - Add prefix_padding (500ms) to avoid clipping word onsets
  - Add 500ms grace period at speech start
  - Silero config: activation_threshold=0.5, sample_rate=16000
  - **Dependencies**: Task 2.2
  - **Effort**: Medium

- [x] **Task 4.5: Implement SentenceStreamPacer for TTS**
  - Adaptive TTS batching based on playback buffer depth
  - Don't send next TTS batch until remaining audio < 3s
  - Cap per-request at 300 chars, min sentence 20 chars
  - Persistent WebSocket connection to TTS provider (reuse across sentences)
  - **Dependencies**: Task 2.4
  - **Effort**: Medium

- [ ] **Task 4.6: Barge-in end-to-end test** *(manual hardware test)*
  - Agent starts long response → user interrupts → agent stops → processes new input
  - Test false interruption: cough during response → agent pauses → resumes
  - Verify no audio artifacts, clean state transition
  - Verify context truncation in chat history
  - **Dependencies**: Tasks 4.2, 4.3
  - **Effort**: Small

### Phase 5: Polish & Integration (M5)

- [x] **Task 5.1: Text-mode fallback in `JarvisController.ts`**
  - Add `streamingMode: boolean` Inspector toggle
  - If true: delegate to `StreamingVoiceController`
  - If false: use existing ASR + TTS flow (unchanged)
  - Auto-fallback to text mode if streaming connection fails
  - **Dependencies**: Task 4.1
  - **Effort**: Small

- [x] **Task 5.2: Chat UI integration**
  - Forward `transcript.delta` to chat UI (show user's speech as they talk)
  - Forward `response.text.delta` to chat UI (show agent's response as it generates)
  - Integrate with existing `ChatBridge.ts` / `ChatComponent.ts`
  - **Dependencies**: Task 4.1
  - **Effort**: Medium

- [ ] **Task 5.3: Jitter buffering and audio smoothing** *(manual hardware tuning)*
  - Implement adaptive jitter buffer on Spectacles (2-5 frames lookahead)
  - Handle audio underrun gracefully (insert silence, no pops)
  - Handle audio overrun (drop oldest frames)
  - **Dependencies**: Task 1.3
  - **Effort**: Medium

- [x] **Task 5.4: Error handling and resilience**
  - WebSocket disconnect during streaming → attempt reconnect, fall back to text
  - ASR service failure → fall back to on-device ASR
  - TTS service failure → fall back to on-device TTS
  - OpenClaw timeout → show error in chat UI, resume listening
  - Degraded mode reporting to client on session start
  - OpenClaw auto-reconnection before processing queries
  - **Dependencies**: All prior tasks
  - **Effort**: Medium

- [x] **Task 5.5: Visual query support in streaming mode**
  - Camera capture still works via existing `VideoController` (JPEG)
  - When visual keywords detected in ASR transcript, trigger camera capture
  - Attach JPEG to the OpenClaw `chat.send` request via `input.attachment` control message
  - Proxy stores pending attachment, includes in next `chat.send`
  - **Dependencies**: Task 3.2
  - **Effort**: Small

### Phase 6: Advanced Optimizations (M6) — Post-MVP

> These optimizations are based on deep research into LiveKit agents SDK, Pipecat, and production
> voice AI systems. See `docs/ai/implementation/knowledge-voice-bot-best-practices.md`.

- [ ] **Task 6.1: Add turn detector model**
  - Option A: Use Deepgram's `endpointing` API parameter (0 extra work, built-in)
  - Option B: Run Pipecat Smart Turn v3 (8MB model, 10ms inference, audio-native)
  - Option C: Run LiveKit EOU model (135MB, 50ms inference, semantic understanding)
  - Integrate with COMMITTING state — reduce endpointing delay from 550ms to ~160ms
  - **Dependencies**: Task 4.1
  - **Effort**: Medium (Option A) / Large (Option B/C)

- [ ] **Task 6.2: Preemptive/speculative LLM generation**
  - Start LLM inference on partial STT transcript before turn confirmed
  - Only trigger when: STT confidence > 0.9, utterance > 3 words, silence > 300ms
  - Discard if user continues speaking and transcript changes
  - Potential savings: 200-500ms on time-to-first-audio
  - **Dependencies**: Tasks 4.1, 2.3
  - **Effort**: Large

- [ ] **Task 6.3: Per-utterance interruption control**
  - Add `allow_interruptions: boolean` to protocol messages
  - Support `session.say` with `allow_interruptions=false` for critical announcements
  - During non-interruptible speech, discard incoming user audio
  - **Dependencies**: Task 4.3
  - **Effort**: Small

- [ ] **Task 6.4: Adaptive jitter buffer based on network quality**
  - Monitor RTT via ping/pong messages
  - Adjust buffer depth: 2-3 frames (LAN), 3-5 (WiFi), 5-10 (cellular)
  - Adjust VAD silence threshold: base + (jitter * 0.5)
  - **Dependencies**: Task 5.3
  - **Effort**: Medium

- [ ] **Task 6.5: Adaptive noise floor / VAD baseline**
  - 30-second rolling window of audio levels
  - 85th percentile as dynamic noise floor
  - RMS monitoring with 20ms chunks, exponential smoothing
  - Static fallback at -35dB
  - **Dependencies**: Task 4.4
  - **Effort**: Medium

## Dependencies

### Task Dependencies
```
Phase 1 (Spectacles Audio I/O):
  1.1 ─┐
  1.2 ─┤──► 1.3 ──► 1.4
       │

Phase 2 (Proxy Server, parallel with Phase 1):
  2.1 ──► 2.2 ──► 2.3 ──┐
  2.1 ──► 2.4 ───────────┤──► 2.5
                         │

Phase 3 (OpenClaw Integration):
  3.1 ──────────┐
  2.3 + 2.4 ────┤──► 3.2 ──► 3.3

Phase 4 (Barge-in):
  Phase 1 ──► 4.1 ──► 4.2 ──┐
  3.2 ──────► 4.3 ───────────┤──► 4.4

Phase 5 (Polish):
  4.1 ──► 5.1, 5.2
  1.3 ──► 5.3
  All ──► 5.4
  3.2 ──► 5.5
```

### External Dependencies
- **Deepgram API key** — for streaming ASR (or alternative: Whisper, AssemblyAI)
- **Cartesia API key** — for streaming TTS (or alternative: ElevenLabs, Deepgram TTS)
- **Python 3.10+** — for proxy server
- **PyTorch** — for Silero VAD model
- **Lens Studio v5.15.0+** — for Permission Alerts support
- **Spectacles OS v5.64+** — for Extended Permissions + Permission Alerts

## Timeline & Estimates

| Phase | Tasks | Estimated Effort | Parallelizable? |
|---|---|---|---|
| Phase 1: Audio I/O | 4 tasks | 2-3 days | Yes (with Phase 2) |
| Phase 2: Proxy MVP | 5 tasks | 3-4 days | Yes (with Phase 1) |
| Phase 3: OpenClaw Integration | 3 tasks | 3-4 days | Task 3.1 parallel with Phase 2 |
| Phase 4: Barge-in & State Machine | 6 tasks | 4-5 days | After Phase 1 + 3 |
| Phase 5: Polish | 5 tasks | 3-4 days | Mostly sequential |
| Phase 6: Advanced Optimizations | 5 tasks | 4-6 days | Post-MVP, incremental |
| **Total (MVP: P1-P5)** | **23 tasks** | **~12-16 days** (with parallelization) | |
| **Total (Full: P1-P6)** | **28 tasks** | **~16-22 days** | |

## Risks & Mitigation

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| `MicrophoneAudioProvider` has undocumented limitations (buffer size, sample rate) | High | Medium | Test early in Phase 1. Reference Snap AI Playground sample code. |
| `AudioOutputProvider` has playback glitches with rapid frame enqueueing | High | Medium | Implement jitter buffer (Task 5.3). Test with various chunk sizes. |
| Spectacles battery drains too fast with continuous mic streaming | Medium | High | Implement duty cycling in IDLE state. Energy-gate to skip silence. |
| Deepgram/Cartesia API latency exceeds targets | Medium | Low | Have fallback to alternative providers. Benchmark in Task 2.5. |
| OpenClaw protocol reimplementation in Python has edge cases | Medium | Medium | Reference existing test scripts (`tests/test-*.mjs`). Port protocol carefully. |
| Network jitter causes audio gaps | Medium | Medium | Jitter buffer (Task 5.3). Adaptive buffer depth based on network quality. |
| Permission Alerts UX is too intrusive for users | Low | Low | Non-blocking. Users accept once per session. |

## Resources Needed

### Services & APIs
- Deepgram streaming ASR (pay-per-use, ~$0.0043/min)
- Cartesia streaming TTS (pay-per-use, ~$0.015/1K chars) or ElevenLabs
- OpenClaw server (existing, self-hosted)

### Infrastructure
- Python server (can run on same machine as OpenClaw)
- Spectacles hardware for testing

### Documentation & References
- `docs/ai/implementation/knowledge-spectacles-workarounds.md` — Raw audio API details
- `docs/ai/implementation/knowledge-livekit.md` — LiveKit architecture (future upgrade reference)
- `docs/ai/implementation/knowledge-smart-glasses-livekit.md` — Trade-off analysis
- Snap AI Playground sample: `github.com/Snapchat/Spectacles-Sample` — reference implementation
- OpenAI Realtime API wire protocol: `platform.openai.com/docs/guides/realtime-websocket`

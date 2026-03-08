---
phase: planning
title: "Planning: Hybrid Voice Bridge"
description: Task breakdown for native ASR + server-side streaming TTS hybrid architecture
feature: hybrid-voice-bridge
---

# Planning: Hybrid Voice Bridge

## Task Breakdown

### Phase 1: Proxy Server — Text Input Mode
*Modify voice proxy to accept text queries instead of audio*

- [x] **Task 1.1**: Add `query.text` handler in `server.py`
  - Accept `{"type": "query.text", "text": "...", "attachment": {...}}` JSON messages
  - Route to pipeline's new `_handle_query_text()` method
  - Keep existing binary audio output path unchanged
  - Effort: Small

- [x] **Task 1.2**: Add `_handle_query_text()` in `pipeline.py`
  - Bypass VAD/ASR — go directly to `_process_with_openclaw()`
  - Reuses existing LLM -> sentence buffer -> TTS -> audio output
  - Handles inline attachment + pending attachment for visual queries
  - Effort: Small

- [x] **Task 1.3**: Update `session.start` to accept `inputMode: "text"`
  - Skip VAD/ASR initialization when text input mode
  - Still initialize TTS (Cartesia WebSocket warmup)
  - Still initialize OpenClaw client
  - Effort: Small

- [x] **Task 1.4**: Handle `response.cancel` for text input mode
  - Same as existing: abort OpenClaw stream, stop TTS, discard audio
  - Already works — no changes needed
  - Effort: Trivial

### Phase 2: Spectacles — HybridVoiceController
*New controller that connects AsrModule output to voice proxy text input*

- [x] **Task 2.1**: Create `HybridVoiceController.ts`
  - State machine: IDLE -> LISTENING -> PROCESSING -> RESPONDING
  - WebSocket connection to voice proxy (reuse InternetModule pattern from StreamingVoiceController)
  - Send `session.start` with `inputMode: "text"` on connect
  - Send `query.text` JSON when receiving final ASR transcript
  - Handle incoming JSON control messages (response.text.delta, response.done, error)
  - Handle incoming binary frames (PCM16 TTS audio)
  - Effort: Medium (mostly adapted from StreamingVoiceController)

- [x] **Task 2.2**: Integrate AudioOutputProvider for TTS playback
  - AudioOutputProvider confirmed safe: no `@exposesUserData`, not in Spectacles permission table
  - Must follow Snap Voice Playback sample pattern: create AudioComponent, assign output track, call `play(-1)` before enqueuing
  - Receive binary PCM16 from proxy -> convert to Float32 -> enqueue via AudioOutputProvider
  - Reuse StreamingAudioBridge playback code (playChunkDirect, jitter buffer)
  - Effort: Small

- [x] **Task 2.3**: Implement barge-in via AsrModule
  - Detect new partial/final transcript while state is RESPONDING
  - Send `response.cancel` to proxy
  - Flush audio playback (AudioComponent.stop + clear queue)
  - Transition to LISTENING
  - Effort: Small

- [ ] **Task 2.4**: Fallback — Native TTS for network-down only (deferred to hardware testing)
  - Only needed if proxy is unreachable (AudioOutputProvider itself is confirmed working)
  - On `response.done`, synthesize with native TTS (like classic mode)
  - Effort: Small

### Phase 3: JarvisController Integration
*Wire HybridVoiceController into the existing coordinator*

- [x] **Task 3.1**: Add `hybridMode` path in JarvisController
  - When `streamingMode=true`, use HybridVoiceController instead of StreamingVoiceController
  - Route ChatASRController transcriptions to HybridVoiceController
  - Forward events (state changes, transcripts, response deltas) to JarvisController's event system
  - Effort: Small

- [x] **Task 3.2**: Modify ChatASRController for hybrid routing
  - In hybrid mode: final transcriptions go to HybridVoiceController.sendQuery(text)
  - Keep always-on mode and continuous listening
  - Tune `silenceUntilTerminationMs` to 1000ms (down from 2000ms) for faster endpointing
  - Barge-in: if new transcript arrives while HybridVoiceController is RESPONDING, trigger barge-in
  - Effort: Small

- [x] **Task 3.3**: Visual query support
  - Detect visual keywords in ASR transcript (existing `isVisualQuery()`)
  - Capture camera frame (existing `captureFrame()`)
  - Include as attachment in `query.text` message
  - Effort: Small

- [x] **Task 3.4**: ChatBridge compatibility
  - Verify ChatBridge works with hybrid mode events
  - onTranscript, onStreamingDelta, onQueryProcessed events should fire correctly
  - Effort: Trivial (should work as-is if events are forwarded correctly)

### Phase 4: Testing & Polish

- [x] **Task 4.1**: Proxy text input E2E test
  - Python test: connect via WebSocket, send `query.text`, verify response audio + text
  - Effort: Small

- [ ] **Task 4.2**: Spectacles hardware test — basic flow
  - Speak -> ASR transcribes -> proxy responds with text + audio
  - Verify end-to-end on real Spectacles
  - Effort: Manual test

- [ ] **Task 4.3**: Spectacles hardware test — barge-in
  - Speak -> agent responds -> interrupt with new speech
  - Verify agent stops and processes new query
  - Effort: Manual test

- [ ] **Task 4.4**: Spectacles hardware test — AudioOutputProvider
  - Determine if AudioOutputProvider works on Spectacles
  - If not, activate native TTS fallback (Task 2.4)
  - Effort: Manual test

- [ ] **Task 4.5**: Error handling and resilience
  - Proxy disconnect -> reconnect with backoff
  - Proxy unreachable at start -> fallback to classic mode
  - OpenClaw errors -> surface to user via Chat UI
  - Effort: Small

## Dependencies

```
Task 1.1 ─┐
Task 1.2 ─┤── Phase 1 (proxy) ──> Task 4.1 (proxy test)
Task 1.3 ─┤                              |
Task 1.4 ─┘                              v
                                   Task 2.1 (HybridVoiceController)
                                          |
                            ┌─────────────┼─────────────┐
                            v             v              v
                       Task 2.2      Task 2.3       Task 2.4
                    (audio out)    (barge-in)    (native TTS fallback)
                            |             |              |
                            v             v              v
                       Task 3.1 (JarvisController integration)
                            |
                       Task 3.2 (ChatASR routing)
                            |
                       Task 3.3 + 3.4 (visual query + ChatBridge)
                            |
                       Tasks 4.2-4.5 (hardware tests)
```

## Implementation Order

1. **Phase 1** (Tasks 1.1-1.4) — Proxy text input mode (~1 session)
2. **Task 4.1** — Proxy E2E test to validate Phase 1
3. **Phase 2** (Tasks 2.1-2.3) — HybridVoiceController (~1-2 sessions)
4. **Phase 3** (Tasks 3.1-3.4) — Integration (~1 session)
5. **Phase 4** (Tasks 4.2-4.5) — Hardware testing + polish

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| ~~AudioOutputProvider has same permission issue~~ | ~~High~~ **RESOLVED** — confirmed no `@exposesUserData`, not in permission table | No risk — AudioOutputProvider is safe to use |
| AsrModule latency adds to pipeline | Medium — 2s silence timeout | Tune `silenceUntilTerminationMs` to 1.5s or use streaming partial transcripts |
| Binary WebSocket frames (server->client) don't work on Spectacles | High — no audio streaming | Already validated in StreamingVoiceController (Blob handling works) |
| ChatASRController always-on mode unreliable | Medium — missed utterances | Tested and working in classic mode |

## Notes

- This is an evolution of `feature-streaming-voice-bridge`, not a replacement
- The voice proxy server, OpenClaw client, TTS pipeline all remain unchanged
- Only the INPUT path changes: binary audio -> text JSON
- If future Lens Studio updates fix MicrophoneAudioProvider permissions, we can switch back to full audio streaming with minimal changes

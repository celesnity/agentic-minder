---
phase: testing
title: "Testing: Streaming Voice Bridge"
description: Testing strategy for real-time audio streaming feature
feature: streaming-voice-bridge
---

# Testing: Streaming Voice Bridge

## Test Coverage Goals

- Unit test coverage: 100% of proxy server Python code (VAD, ASR, TTS, pipeline logic)
- Integration tests: Spectacles ↔ Proxy ↔ OpenClaw full path
- End-to-end tests: Voice conversation scenarios on actual Spectacles hardware
- Performance benchmarks: Latency measurements against success criteria

## Unit Tests

### StreamingAudioBridge.ts (Spectacles)
- [ ] `getAudioFramePCM16` returns valid Int16Array with expected frame size
- [ ] Energy-gate correctly filters frames below threshold
- [ ] Energy-gate passes frames above threshold
- [ ] `computeRMS` returns correct values for known inputs
- [ ] `playAudioChunk` correctly converts Int16 PCM to Float32
- [ ] Float32 conversion is normalized to [-1.0, 1.0] range
- [ ] Binary WebSocket frames are correctly formatted as Uint8Array

### StreamingVoiceController.ts (Spectacles)
- [ ] State transitions: IDLE → LISTENING on `vad.speech_start`
- [ ] State transitions: LISTENING → PROCESSING on `vad.speech_end`
- [ ] State transitions: PROCESSING → RESPONDING on `response.audio`
- [ ] State transitions: RESPONDING → IDLE on `response.done`
- [ ] Barge-in: RESPONDING → LISTENING on mic energy detection
- [ ] Barge-in sends `response.cancel` message
- [ ] Invalid state transitions are rejected/logged
- [ ] Fallback to text mode on error

### OpenClawBridge.ts (Modified)
- [ ] Binary frame routing: binary Blob → `onBinaryAudioFrame` event
- [ ] Text frame routing: text string → existing JSON handler (unchanged)
- [ ] `sendBinary(Uint8Array)` sends correct binary WebSocket frame
- [ ] Existing JSON protocol tests still pass (regression)

### Proxy Server — VAD (vad.py)
- [ ] Speech detection with known speech audio samples
- [ ] Silence detection with known silence samples
- [ ] Speech start threshold (300ms of continuous speech)
- [ ] Speech end threshold (500ms of continuous silence)
- [ ] Edge case: very short utterance ("yes") detected correctly
- [ ] Edge case: speech with brief pauses doesn't false-trigger end

### Proxy Server — ASR (asr.py)
- [ ] Deepgram WebSocket connection established successfully
- [ ] Audio frames forwarded correctly to Deepgram
- [ ] Partial transcripts received and forwarded
- [ ] Final transcript received on finalize
- [ ] Error handling: Deepgram connection failure
- [ ] Error handling: Invalid audio format

### Proxy Server — TTS (tts.py)
- [ ] Text input produces PCM16 audio output
- [ ] Streaming mode: first chunk arrives within 200ms
- [ ] Empty text input handled gracefully
- [ ] Cancellation stops ongoing synthesis
- [ ] Error handling: TTS service unavailable

### Proxy Server — Pipeline (pipeline.py)
- [ ] Audio frame routing to VAD
- [ ] Speech start → ASR stream initialization
- [ ] Speech end → ASR finalize → OpenClaw send
- [ ] OpenClaw token streaming → sentence boundary detection
- [ ] Sentence boundary triggers TTS synthesis
- [ ] TTS audio chunks sent as binary frames
- [ ] `response.cancel` aborts all pending operations
- [ ] State machine transitions are correct
- [ ] Concurrent requests handled (one at a time per connection)

### Proxy Server — OpenClaw Client (openclaw_client.py)
- [ ] Connect handshake (challenge-response, token auth)
- [ ] `chat.send` serialization matches protocol v3
- [ ] `agent` event parsing (streaming tokens)
- [ ] `chat` event parsing (final response, aborted, error states)
- [ ] `chat.abort` sent correctly
- [ ] Heartbeat/tick handling
- [ ] Reconnection on disconnect

## Integration Tests

### Audio Pipeline (Spectacles ↔ Proxy)
- [ ] Binary PCM16 frames sent from Spectacles arrive intact at proxy
- [ ] Binary PCM16 frames sent from proxy play correctly on Spectacles
- [ ] Round-trip audio loopback (echo test) — audible verification
- [ ] JSON control messages interleaved with audio frames work correctly
- [ ] WebSocket reconnection resumes audio streaming

### ASR Pipeline (Proxy ↔ Deepgram)
- [ ] Live speech transcription produces accurate text
- [ ] Streaming partial transcripts arrive in real-time
- [ ] Multiple sequential utterances transcribed correctly
- [ ] Network interruption to Deepgram handled gracefully

### TTS Pipeline (Proxy ↔ Cartesia/ElevenLabs)
- [ ] Text → streaming audio → playback produces intelligible speech
- [ ] Multiple sequential sentences synthesized without gaps
- [ ] Cancellation mid-synthesis stops cleanly

### Full Pipeline (Spectacles ↔ Proxy ↔ OpenClaw)
- [ ] Speak → transcribe → LLM → TTS → hear response (happy path)
- [ ] Multi-turn conversation (3+ exchanges) works correctly
- [ ] Visual query: speech with "look" keyword triggers camera capture
- [ ] Barge-in during long response: agent stops, processes new input
- [ ] Barge-in during short response: handled gracefully
- [ ] OpenClaw server restart: proxy reconnects, conversation resumes

## End-to-End Tests

### User Flow 1: Basic Conversation
- [ ] Put on Spectacles → lens starts → permission prompt accepted
- [ ] Say "Hello, how are you?" → hear agent response within 1 second
- [ ] Say "Tell me about the weather" → hear streaming response
- [ ] Verify chat UI shows both user speech and agent response

### User Flow 2: Barge-in
- [ ] Ask "Tell me a long story about space exploration"
- [ ] After 5 seconds of agent speaking, say "Stop, tell me about cats instead"
- [ ] Agent stops within 300ms, begins answering about cats
- [ ] No audio artifacts during transition

### User Flow 3: Visual Query
- [ ] Say "What do you see in front of me?"
- [ ] Camera captures frame while question is being processed
- [ ] Agent describes the scene based on the captured image
- [ ] Audio response arrives with normal latency

### User Flow 4: Rapid-fire Questions
- [ ] Ask 3 questions in quick succession without waiting for responses
- [ ] Each question correctly barge-ins the previous response
- [ ] Final question gets a complete response

### User Flow 5: Fallback to Text Mode
- [ ] Disconnect proxy server mid-conversation
- [ ] Verify graceful fallback to text-based ASR + TTS
- [ ] Reconnect proxy → streaming mode resumes

### User Flow 6: Extended Session
- [ ] 10-minute continuous conversation
- [ ] Monitor battery level
- [ ] Monitor audio quality degradation (if any)
- [ ] Monitor latency drift over time

## Test Data

### Audio Test Fixtures
- `test_silence_16khz.pcm` — 2 seconds of silence (zeros)
- `test_speech_hello_16khz.pcm` — "Hello, how are you?" at 16kHz PCM16
- `test_speech_long_16khz.pcm` — 30-second speech sample
- `test_noise_16khz.pcm` — Background noise without speech

### Configuration
- Proxy server URL: `ws://localhost:8765` (test)
- OpenClaw server URL: `ws://localhost:18789` (existing)
- Sample rate: 16000 Hz
- Chunk size: 320 samples (20ms)

## Performance Testing

### Latency Benchmarks

| Metric | Target | How to Measure |
|---|---|---|
| Time-to-first-audio (p50) | < 1000ms | Timestamp: speech_end → first audio chunk received on Spectacles |
| Time-to-first-audio (p95) | < 1500ms | Same, 95th percentile over 50+ utterances |
| Barge-in latency | < 300ms | Timestamp: mic energy spike → agent audio stops |
| ASR latency | < 300ms | Timestamp: speech_end → final transcript available |
| TTS first-chunk latency | < 200ms | Timestamp: text sent to TTS → first audio chunk |

### Load Testing
- [ ] Single connection sustained for 30 minutes — no memory leaks
- [ ] Audio frame rate stability (50 fps ± 2) over 10 minutes
- [ ] Proxy server CPU usage during active conversation (target: < 30% single core)

### Battery Testing (Spectacles)
- [ ] Streaming mode session duration vs text mode session duration
- [ ] Target: > 15 minutes of active streaming conversation
- [ ] Measure with mic continuously capturing vs duty-cycled (idle pauses)

## Bug Tracking

### Severity Levels
- **P0 (Critical)**: Audio doesn't work at all, crashes, data loss
- **P1 (High)**: Barge-in doesn't work, latency > 3s consistently, frequent disconnects
- **P2 (Medium)**: Occasional audio glitches, latency > 1.5s sometimes, minor state machine bugs
- **P3 (Low)**: Minor UI issues, log noise, cosmetic problems

### Regression Testing
- [ ] All existing `JarvisController` text-mode tests still pass
- [ ] All existing `OpenClawBridge` tests still pass
- [ ] Existing `ChatASRController` → `JarvisController` flow unchanged
- [ ] Existing camera capture flow unchanged

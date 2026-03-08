---
phase: testing
title: "Testing: Hybrid Voice Bridge"
description: Test plan for native ASR + server-side streaming TTS hybrid architecture
feature: hybrid-voice-bridge
---

# Testing: Hybrid Voice Bridge

## Test Plan

### Unit/Integration Tests (Automated)

#### T1: Proxy text input E2E
- Connect to proxy via WebSocket
- Send `session.start` with `inputMode: "text"`
- Send `query.text` with sample text (e.g., "Hello, how are you?")
- Verify: receive `response.text.delta` messages with streaming text
- Verify: receive binary PCM16 audio frames
- Verify: receive `response.done` with full text

#### T2: Proxy cancel during response
- Connect and send `query.text` with a long question
- Wait for first `response.text.delta`
- Send `response.cancel`
- Verify: no more audio frames arrive
- Verify: can send a new `query.text` immediately after cancel

#### T3: Proxy visual query
- Send `query.text` with attachment (base64 JPEG)
- Verify: OpenClaw receives the image and references it in response

### Hardware Tests (Manual on Spectacles)

#### T4: Basic voice flow
**Setup**: Spectacles + proxy server on same WiFi
**Steps**:
1. Launch lens with `streamingMode=true`
2. Speak a question clearly
3. Wait for ASR to transcribe
4. Listen for streaming audio response
**Expected**: Audio response begins within ~2s of silence detection
**Pass criteria**: Hear agent's voice response + see text in chat UI

#### T5: Barge-in
**Setup**: Same as T4
**Steps**:
1. Ask a question that produces a long response
2. While agent is speaking, say a new question
3. Observe: agent should stop speaking immediately
4. Agent should respond to the new question
**Expected**: Barge-in latency < 500ms
**Pass criteria**: Agent stops, processes new query

#### T6: AudioOutputProvider playback test
**Setup**: Spectacles
**Note**: AudioOutputProvider confirmed safe — no `@exposesUserData`, not in Spectacles permission table. No permission issues expected.
**Steps**:
1. Run lens in hybrid mode
2. Agent responds with TTS audio
3. Verify `AudioComponent.play(-1)` + `enqueueAudioFrame()` produces audible output
**Expected**: Hear audio through Spectacles speaker
**Pass criteria**: Audible, intelligible speech output

#### T7: Visual query
**Steps**:
1. Say "what do you see?" or similar visual keyword
2. Observe camera capture and proxy response
**Expected**: Agent describes what the camera sees

#### T8: Reconnection
**Steps**:
1. Start voice session
2. Kill proxy server process
3. Wait for reconnection attempts (check logs)
4. Restart proxy server
5. Verify: reconnects and resumes working
**Expected**: Reconnects within 30s with exponential backoff

#### T9: Classic mode fallback
**Steps**:
1. Set `streamingMode=false` in JarvisController inspector
2. Deploy and test basic voice flow
**Expected**: Classic mode (AsrModule + native TTS + direct OpenClaw) works unchanged

## Success Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Time-to-first-audio | < 2s | Proxy logs: timestamp from query.text to first audio frame |
| Barge-in latency | < 500ms | Subjective: agent stops "instantly" when user speaks |
| E2E reliability | > 95% | 20 consecutive queries without failure |
| Audio quality | Intelligible | Subjective listening test on Spectacles |

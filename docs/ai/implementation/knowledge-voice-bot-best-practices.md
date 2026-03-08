---
phase: implementation
title: "Knowledge: Voice Bot Best Practices (from LiveKit, Pipecat, Industry)"
description: Deep research on streaming voice bot patterns extracted from LiveKit agents, Pipecat, OpenAI Realtime, and production voice AI systems
feature: streaming-voice-bridge
---

# Knowledge: Voice Bot Best Practices

> Extracted from LiveKit agents SDK, Pipecat, OpenAI Realtime API, Vapi, and production voice AI systems. These patterns should be applied to our OpenClaw streaming voice bridge proxy server.

## 1. Architecture Pattern: The Voice Pipeline

Every production voice bot follows the same core pipeline, but the devil is in the details:

```
Mic Audio → [VAD] → [STT] → [Turn Detector] → [LLM] → [Sentence Tokenizer] → [TTS] → [Audio Emitter] → Speaker
                                                                                              ↑
                                                                               [Jitter Buffer / Pacer]
```

**LiveKit's key insight**: The pipeline is NOT a simple chain. It's a stateful orchestrator with:
- Parallel processing (STT runs while VAD tracks speech)
- Speculative execution (preemptive LLM inference before turn confirmed)
- Adaptive pacing (TTS synthesis rate matched to playback consumption)
- Cancellation propagation (barge-in cascades through all stages)

### LiveKit SFU vs Our Architecture

LiveKit's SFU is transport infrastructure — it forwards RTP packets between WebRTC peers. The voice intelligence (VAD, STT, LLM, TTS) runs in **agent workers** that join rooms as participants. Our proxy server is equivalent to a LiveKit agent worker, but we skip the SFU/WebRTC layer since Spectacles use raw WebSocket + PCM.

**Our advantage**: No WebRTC overhead (ICE negotiation, DTLS handshake, codec transcoding). Direct PCM over WebSocket is simpler and lower latency on LAN.

---

## 2. VAD: Silero VAD Configuration (Production-Tested)

### Silero VAD Parameters (LiveKit Defaults)

| Parameter | Default | Range | Purpose |
|-----------|---------|-------|---------|
| `min_speech_duration` | 0.05s (50ms) | 0.02-0.2s | Min speech to start a new chunk |
| `min_silence_duration` | 0.55s (550ms) | 0.3-1.0s | Silence after speech → end of speech |
| `prefix_padding_duration` | 0.5s (500ms) | 0.2-1.0s | Audio prepended to speech start (captures word onsets) |
| `max_buffered_speech` | 60.0s | 10-120s | Max speech buffer before forced commit |
| `activation_threshold` | 0.5 | 0.3-0.8 | Probability threshold for speech classification |
| `sample_rate` | 16000 | 8000/16000 | Only these two rates supported |
| `force_cpu` | True | - | Force CPU inference (~1/8th core) |

### Tuning Guide

- **Lower `activation_threshold` (0.3)**: More sensitive — catches soft speech, but may trigger on background noise
- **Higher `activation_threshold` (0.7)**: More conservative — may miss quiet speech
- **Lower `min_silence_duration` (0.3s)**: Faster end-of-speech but may cut off mid-sentence pauses
- **Higher `min_silence_duration` (0.8s)**: Tolerates pauses but slower turn-taking
- **`prefix_padding_duration` (0.5s)**: Critical — without this, first syllable of speech is clipped

### Vapi's Production VAD State Machine (4 States)

More sophisticated than simple binary speech/silence:

```
QUIET → STARTING → SPEAKING → STOPPING → QUIET
  ↑                    ↓         ↓
  └────────────────────┘         └─→ SPEAKING (if speech resumes)
```

| State | Description | Duration Before Transition |
|-------|-------------|--------------------------|
| QUIET | No speech detected | — |
| STARTING | Possible speech beginning | ~200ms sustained detection → SPEAKING |
| SPEAKING | Active speech confirmed | Continuous above threshold |
| STOPPING | Possible speech end | ~800ms sustained silence → QUIET |

**Additional refinements from Vapi**:
- 30-second rolling window of audio levels for adaptive baseline
- 85th percentile as dynamic noise floor
- RMS amplitude over 3-second rolling windows using 20ms chunks
- Baseline updates every 100ms via exponential smoothing
- Static fallback at -35dB
- **500ms grace period** at speech start to prevent word-onset clipping

### Recommendation for Our Proxy Server

```python
# vad.py — recommended configuration
SILERO_CONFIG = {
    "min_speech_duration": 0.05,      # 50ms — don't miss short utterances
    "min_silence_duration": 0.55,     # 550ms — balanced endpointing
    "prefix_padding_duration": 0.5,   # 500ms — capture word onsets
    "activation_threshold": 0.5,      # balanced sensitivity
    "sample_rate": 16000,             # match Spectacles mic
}
```

**Enhancement**: Implement the 4-state VAD (QUIET → STARTING → SPEAKING → STOPPING) instead of simple binary. This prevents false triggers from brief noise while allowing fast speech-start detection.

---

## 3. Turn Detection: Beyond Simple Silence Thresholds

This is the **single biggest differentiator** between a good and great voice bot. Simple silence timeout (VAD-only) creates a dilemma:
- Too short (300ms) → cuts user off mid-thought during pauses
- Too long (1000ms) → sluggish, unresponsive feel

### Three Generations of Turn Detection

#### Generation 1: Fixed Silence Timeout (VAD-Only)
- Wait for N ms of silence after speech ends
- Simple but frustrating for users who pause to think
- **Our current design** in the proxy server

#### Generation 2: Semantic Endpointing (Text-Based)
- Uses ASR transcript to predict if user is done
- AssemblyAI's approach: special token predicted by ASR model
- Parameters:
  - `end_of_turn_confidence_threshold`: 0.7
  - `min_end_of_turn_silence_when_confident`: 160ms
  - `max_turn_silence`: 2400ms (fallback)
- Can start LLM response **before turn officially ends**, saving 200-500ms

#### Generation 3: Transformer Model (Best)
- **LiveKit EOU Model**: 135M param transformer (SmolLM v2 fine-tuned)
  - Input: text (last 4 turns of conversation)
  - Inference: ~50ms on CPU
  - Reduces false interruptions by **85%**
  - Works with `min_endpointing_delay` (0.5s) and `max_endpointing_delay` (3.0s)

- **Pipecat Smart Turn v3**: 8M param (Whisper Tiny + linear classifier)
  - Input: raw PCM audio (captures prosody, not just text)
  - Inference: ~10-65ms on CPU
  - int8 quantized: 8MB model
  - Supports 23 languages

### LiveKit's Hybrid Approach (Recommended)

```python
# Turn detection flow:
# 1. VAD detects silence (min_silence_duration = 0.55s)
# 2. Turn detector model evaluates transcript
# 3. If model says "turn complete" → apply min_endpointing_delay (0.5s) → commit
# 4. If model says "user will continue" → wait up to max_endpointing_delay (3.0s)
# 5. Timeout at max_endpointing_delay regardless → commit

TURN_DETECTION_CONFIG = {
    "min_endpointing_delay": 0.5,   # Applied when model confirms turn complete
    "max_endpointing_delay": 3.0,   # Max wait when model says user may continue
}
```

### Recommendation for Our Proxy Server

**Phase 1 (MVP)**: Use VAD-only with 550ms silence threshold. Good enough for initial testing.

**Phase 2 (Enhancement)**: Add a lightweight turn detector. Options:
1. **Simplest**: Use Deepgram's `endpointing` parameter (built into their API, 0 extra work)
2. **Better**: Run Pipecat Smart Turn v3 model (8MB, 10ms inference, audio-native)
3. **Best**: Run LiveKit EOU model (135MB, 50ms inference, text-based semantic understanding)

---

## 4. Barge-In: The Full Interruption System

Our current design is too simplistic (just detect energy → cancel). Production systems handle many edge cases.

### LiveKit's Complete Barge-In System

#### Configuration Parameters

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `allow_interruptions` | True | Global toggle |
| `min_interruption_duration` | 0.5s | Min speech before triggering interrupt |
| `min_interruption_words` | 0 | Min STT words before interrupt (0 = disabled) |
| `false_interruption_timeout` | 2.0s | Wait for real words after VAD-only interrupt |
| `resume_false_interruption` | True | Auto-resume speech after false positive |
| `discard_audio_if_uninterruptible` | True | Drop user audio during non-interruptible speech |

#### Barge-In Sequence (Step by Step)

```
1. Agent is SPEAKING (streaming TTS audio to client)
2. VAD detects user speech in incoming audio
3. Duration check: speech must persist for min_interruption_duration (500ms)
   → Prevents brief noise/cough from interrupting
4. Word count check (optional): STT must have transcribed min_interruption_words
   → Prevents non-speech sounds that pass VAD
5. Both thresholds met → INTERRUPT:
   a. Stop TTS synthesis immediately
   b. Flush audio output buffer (critical — queued TTS chunks would play over user)
   c. Abort in-flight LLM request
   d. Truncate agent's response in chat history to only what user actually heard
   e. Transition to LISTENING state
6. Start processing user's new speech normally
```

#### False Interruption Recovery

This is a **critical edge case** we missed in our design:

```
1. Agent is SPEAKING
2. VAD detects "speech" (actually a cough, background noise, or feedback)
3. Agent stops speaking (barge-in triggered)
4. Wait false_interruption_timeout (2.0s) for STT to produce actual words
5a. If words arrive → real interruption, process normally
5b. If NO words arrive → false positive:
    - Fire "agent_false_interruption" event
    - If resume_false_interruption=True:
      → Resume agent speech from where it was interrupted
      → Seamless experience for user
```

#### Per-Utterance Interruption Control

Some utterances should NOT be interruptible (e.g., critical instructions):

```python
# Non-interruptible speech
handle = session.say("Please do not hang up. Transferring you now.",
                     allow_interruptions=False)

# During non-interruptible speech:
# - User audio is actively discarded (discard_audio_if_uninterruptible=True)
# - Prevents audio buffering issues
```

#### Context Truncation on Interrupt

When user interrupts, the agent's response in chat history should be **truncated to only what the user actually heard**:

```python
# Agent was saying: "The weather today is sunny with a high of 75 degrees
#                    and clear skies expected through the weekend."
# User interrupts after "75 degrees"
# Chat history records: "The weather today is sunny with a high of 75 degrees"
# (rest is discarded — user never heard it)
```

This prevents the LLM from assuming the user heard information they didn't.

### Barge-In Confidence Filtering (from Vapi)

```python
# During SPEAKING state, apply stricter filtering:
if state == "speaking":
    # Reject low-confidence transcripts (likely background noise or echo)
    if transcript.confidence < 0.6:
        return  # Ignore, don't interrupt
```

### Recommendation for Our Proxy Server

```python
# pipeline.py — enhanced barge-in configuration
BARGE_IN_CONFIG = {
    "allow_interruptions": True,
    "min_interruption_duration": 0.5,    # 500ms of sustained speech
    "min_interruption_words": 0,         # Phase 1: VAD-only; Phase 2: add STT word count
    "false_interruption_timeout": 2.0,   # Wait for real words
    "resume_false_interruption": True,   # Auto-resume on false positive
    "barge_in_confidence_threshold": 0.6, # Reject low-confidence during SPEAKING
}
```

---

## 5. Streaming TTS: Sentence Tokenization & Pacing

### The Problem

LLM tokens arrive one at a time ("The", " weather", " today", " is"...). Sending each token to TTS produces terrible audio. Waiting for full response defeats streaming.

### Sentence Boundary Detection

**Simple regex approach** (what we have now):
```python
# Split at terminal punctuation
if buffer.rstrip().endswith(('.', '!', '?', '\n')):
    flush_to_tts(buffer)
```

**Better approach** (from Deepgram):
```python
# Also split at clause boundaries for long sentences
import re
SENTENCE_BOUNDARY = re.compile(r'[.!?;]|\, (and|but|or|nor|for|yet|so)\b')

# Dynamic splitting:
# 1. Primary: split at sentence boundaries (.!?;)
# 2. If clause > 100 chars: split at coordinating conjunctions
# 3. Reject sub-chunks with < 3 words
```

**Best approach** (from LiveKit — BlingFire tokenizer):
```python
# Parameters:
# min_sentence_len = 20 chars  (don't split too early)
# stream_context_len = 10 chars (lookahead for boundary detection)
# retain_format = True (preserve whitespace/formatting)
```

### SentenceStreamPacer: Adaptive TTS Batching

LiveKit's most sophisticated optimization. Instead of sending each sentence to TTS immediately:

```python
class SentenceStreamPacer:
    min_remaining_audio = 5.0  # seconds of buffered audio before sending next batch
    max_text_length = 300      # chars per TTS request

    def should_flush(self, buffered_audio_seconds, pending_text):
        # Only send next TTS batch when playback buffer is getting low
        if buffered_audio_seconds < self.min_remaining_audio:
            return True
        return False
```

**Why this matters**:
1. **Reduces waste**: If user interrupts, less pre-synthesized audio is thrown away
2. **Improves quality**: TTS gets more context per request (multiple sentences)
3. **Maintains smoothness**: Buffer never runs dry
4. **Saves cost**: Fewer TTS API calls

### TTS Provider Connection Strategies

| Provider | Connection | Session Duration | Key Optimization |
|----------|-----------|-----------------|-----------------|
| Cartesia | WebSocket | 300s pool | Persistent sessions with keepalive |
| ElevenLabs | WebSocket | Pooled | Multiplexes via context IDs |
| Deepgram TTS | WebSocket | 3600s | Persistent with keepalive |
| OpenAI | HTTP chunked | Per-request | Chunked transfer encoding |

**Critical**: Use persistent WebSocket connections to TTS services. Reconnecting per sentence adds 50-200ms overhead.

### Recommendation for Our Proxy Server

**Phase 1**: Sentence boundary TTS (current design) with persistent WebSocket to Cartesia.

**Phase 2**: Add SentenceStreamPacer to batch sentences based on playback buffer depth. Parameters:
```python
TTS_PACER_CONFIG = {
    "min_remaining_audio": 3.0,  # 3s (lower than LiveKit's 5s — our responses are shorter)
    "max_text_length": 300,      # chars per TTS request
    "min_sentence_len": 20,      # chars before allowing sentence split
}
```

---

## 6. Preemptive / Speculative Generation

### The Idea

Start LLM inference BEFORE the user finishes speaking, using the partial STT transcript.

### LiveKit's Implementation

```python
# When preemptive_generation=True:
# 1. STT emits "preflight transcript" — stable portion of speech
# 2. Agent immediately begins LLM inference on partial transcript
# 3. If final transcript matches preflight → response is already generating
# 4. If user continues speaking and transcript changes → discard and restart

# Savings: 200-500ms (overlaps LLM TTFT with VAD silence detection)
```

### When It Helps

- Fast STT (Deepgram) returns final transcript BEFORE VAD confirms end-of-speech
- With conservative VAD silence thresholds (550ms+), there's dead time to exploit
- Most impactful for short queries ("What time is it?", "Yes", "Tell me more")

### When It Hurts

- User says "Tell me about..." then pauses and continues "...the solar system"
- Preemptive generation on "Tell me about" produces wrong response
- Wasted LLM compute (extra API call)

### Recommendation

**Phase 1**: Don't implement. Adds complexity.
**Phase 2**: Consider for short-utterance optimization. Only trigger if:
1. STT confidence > 0.9
2. Utterance length > 3 words (avoid preempting "um", "let me think")
3. VAD silence duration > 300ms (user likely done)

---

## 7. Audio Buffering & Jitter Handling

### Jitter Buffer Strategy

```
Incoming audio chunks from server:
  chunk1 (t=0ms) → chunk2 (t=20ms) → [gap: 60ms] → chunk3 (t=80ms) → chunk4 (t=100ms)

Without jitter buffer: gap causes audible click/pop
With jitter buffer (3 frames = 60ms lookahead):
  Buffer: [chunk1, chunk2, chunk3] → start playback
  Smooth continuous audio despite network variance
```

### Adaptive Buffer Sizing

```python
# Adjust buffer based on network conditions
if network == "LAN":       buffer_frames = 2-3   # 40-60ms
if network == "WiFi":      buffer_frames = 3-5   # 60-100ms
if network == "cellular":  buffer_frames = 5-10  # 100-200ms
```

### Endpointing Threshold Adjustment for Network Jitter (from CallStack.tech)

```python
effective_threshold = base_threshold + (network_jitter * 0.5)
# WiFi:    550ms + (50ms * 0.5)  = 575ms
# Mobile:  550ms + (200ms * 0.5) = 650ms
```

### Audio Buffer Underrun/Overrun

| Event | Action |
|-------|--------|
| Underrun (buffer empty, no audio to play) | Insert silence frame (zeros), no audible pop |
| Overrun (buffer growing, audio arriving faster than playing) | Drop oldest frames, log warning |
| Network disconnect | Stop playback, don't insert silence (prevents zombie audio) |

### Recommendation for Our Spectacles Client

```typescript
// StreamingAudioBridge.ts — jitter buffer
const JITTER_BUFFER_SIZE = 3  // 60ms at 20ms/frame
private audioQueue: Uint8Array[] = []

onBinaryFrame(data: Uint8Array) {
    this.audioQueue.push(data)
    if (this.audioQueue.length >= JITTER_BUFFER_SIZE && !this.isPlaying) {
        this.startPlayback()
    }
}

private startPlayback() {
    this.isPlaying = true
    // Dequeue and play frames on timer
}
```

---

## 8. State Machine: Production-Grade Design

### LiveKit's Agent State Machine

```
Agent states: initializing → listening → thinking → speaking → listening (loop)
                                                        |
                                                  [interrupted] → listening

User states: listening | speaking | away
```

### Enhanced State Machine for Our Proxy Server

Based on research, our state machine should be enhanced:

```
IDLE ──[VAD: STARTING for 200ms]──► LISTENING
LISTENING ──[VAD: STOPPING for 550ms]──► COMMITTING
COMMITTING ──[turn detector: complete]──► PROCESSING
COMMITTING ──[turn detector: continue]──► LISTENING (extend wait up to 3s)
PROCESSING ──[first TTS audio]──► SPEAKING
SPEAKING ──[response.done]──► IDLE
SPEAKING ──[barge-in detected (500ms sustained)]──► INTERRUPTING
INTERRUPTING ──[cancel complete + flush]──► LISTENING
LISTENING ──[15s no speech]──► IDLE (user away)
```

**Key additions over our current design**:
1. **COMMITTING state**: Between speech end and processing — allows turn detector to decide
2. **INTERRUPTING state**: Brief transitional state for clean cancellation cascade
3. **User away timeout**: 15s of silence → stop listening (save resources)

### Critical Rules

1. **Block VAD events during PROCESSING**: Prevent duplicate responses from echo/feedback
2. **500ms grace period at speech start**: Don't clip first word
3. **Confidence threshold 0.6-0.7 during SPEAKING**: Reject noise that passes VAD
4. **Interruption cascade must complete in <100ms**: abort LLM → stop TTS → flush audio buffer → activate listening

---

## 9. Latency Budget: Industry Benchmarks

### Per-Stage Breakdown (Best Achievable)

| Stage | Target (ms) | Best-in-class (ms) | Our Budget (ms) |
|-------|------------|--------------------|-|
| VAD endpointing | 550 | 160 (with semantic) | 550 (Phase 1) → 300 (Phase 2) |
| Network (device → server) | 5 | 1 (localhost) | 5 (LAN) |
| ASR finalize | 0 | 0 (streaming) | 0 (done during speech) |
| LLM first token (TTFT) | 375 | 200 (Groq) | 300-500 (OpenClaw) |
| Sentence buffer | 200 | 0 (first sentence) | 0-200 |
| TTS first byte (TTFB) | 100 | 100 (Cartesia) | 100-200 |
| Network (server → device) | 5 | 1 | 5 |
| **Total** | **1,235** | **462** | **960-1,460** |

### Industry Targets

| Metric | Target | Upper Limit | Source |
|--------|--------|-------------|--------|
| Mouth-to-Ear Turn Gap | 1,115ms | 1,400ms | Twilio |
| Platform Turn Gap | 885ms | 1,100ms | Twilio |
| STT latency | 350ms | 500ms | Twilio |
| LLM TTFT | 375ms | 750ms | Twilio |
| TTS TTFB | 100ms | 250ms | Twilio |

### Best-in-Class Benchmarks

- Vapi optimized pipeline: ~465ms end-to-end
- Deepgram Nova-3 TTS: 150ms time-to-first-audio
- Twilio ConversationRelay: p50 491ms, p95 713ms
- Sub-300ms is the aspirational target for "indistinguishable from human"

### Latency Optimization Checklist

1. **Streaming everything**: No batch processing at any stage
2. **Persistent connections**: WebSocket keepalive to STT/TTS services
3. **Preemptive generation**: Overlap LLM inference with silence detection
4. **Sentence-level TTS**: Start speaking at first complete sentence
5. **Connection reuse**: Don't re-establish WebSocket per utterance
6. **Infrastructure colocation**: Keep proxy on same machine/LAN as OpenClaw
7. **Model selection**: Cartesia (fastest TTS), Deepgram Nova-3 (fastest STT)
8. **Tune VAD thresholds**: Balance speed vs false positives per environment
9. **Turn detector model**: Can reduce VAD endpointing delay from 550ms to 160ms

---

## 10. Key Constants & Magic Numbers (Production-Tested)

| Constant | Value | Source | Purpose |
|----------|-------|--------|---------|
| PLAYED_FOR_COMMIT | 1.5s | LiveKit | Min playback before committing to chat history |
| Default sample rate | 16000 Hz | Silero/Deepgram | Standard for speech |
| Min sentence length | 20 chars | BlingFire | Don't split too early |
| Stream context length | 10 chars | BlingFire | Lookahead for boundary detection |
| Min remaining audio | 5.0s | LiveKit Pacer | Buffer threshold for next TTS batch |
| Max TTS text length | 300 chars | LiveKit Pacer | Max chars per TTS request |
| Barge-in min duration | 500ms | LiveKit | Prevent false interrupts |
| False interrupt timeout | 2.0s | LiveKit | Wait for real words after VAD-only interrupt |
| User away timeout | 15.0s | LiveKit | Silence before marking user away |
| Confidence threshold | 0.6-0.7 | Vapi | Reject noise during SPEAKING |
| VAD activation threshold | 0.5 | Silero | Speech probability cutoff |
| Prefix padding | 500ms | Silero | Don't clip word onsets |

---

## 11. Audio Format Recommendations

| Context | Sample Rate | Format | Channels |
|---------|------------|--------|----------|
| Mic input / STT | 16kHz | PCM16 | Mono |
| TTS output (Cartesia) | 16kHz or 24kHz | PCM16 | Mono |
| OpenAI Realtime API | 24kHz | PCM16 | Mono |
| Network transport (future) | — | Opus preferred | Mono |
| Internal processing | 16kHz | PCM16 | Mono |

**For our system**: Use 16kHz PCM16 mono throughout. Matches Spectacles mic, Silero VAD, and Deepgram input. If TTS outputs 24kHz, resample to 16kHz on server before sending to Spectacles.

---

## 12. LiveKit Agent Framework: Relevant Patterns for Our Proxy

### What We Can Borrow

| LiveKit Pattern | Our Equivalent | Status |
|----------------|----------------|--------|
| AgentSession state machine | VoicePipeline class | Enhance with COMMITTING + INTERRUPTING states |
| Silero VAD with 4-state detection | vad.py | Enhance from binary to 4-state |
| SentenceStreamPacer | pipeline.py token buffering | Add adaptive pacing |
| False interruption recovery | pipeline.py barge-in handler | Add (currently missing) |
| Turn detector model | — | Phase 2 enhancement |
| Preemptive generation | — | Phase 2 enhancement |
| Per-utterance interruption control | — | Add to protocol |
| Context truncation on interrupt | pipeline.py | Add (critical for chat quality) |

### What We Skip (LiveKit-Specific)

- WebRTC transport (we use raw WebSocket)
- SFU forwarding (single-client, no room)
- Multi-participant handling (1:1 voice only)
- Agent worker registration/dispatch (we have a single proxy process)
- RTP packetization (raw PCM over WebSocket)

---

## Sources

### LiveKit
- [LiveKit Agents Voice Pipeline](https://docs.livekit.io/agents/voice-agent/voice-pipeline)
- [LiveKit Turn Detection](https://docs.livekit.io/agents/build/turns/)
- [LiveKit Turn Detector Plugin](https://docs.livekit.io/agents/logic/turns/turn-detector/)
- [LiveKit Silero VAD Plugin](https://docs.livekit.io/agents/logic/turns/vad/)
- [LiveKit Agent Session](https://docs.livekit.io/agents/logic/sessions/)
- [LiveKit Pipeline Nodes](https://docs.livekit.io/agents/logic/nodes/)
- [LiveKit Latency Reduction](https://kb.livekit.io/articles/4490830410-how-can-i-reduce-latency)
- [LiveKit Transformer Turn Detection Blog](https://blog.livekit.io/using-a-transformer-to-improve-end-of-turn-detection/)

### Pipecat
- [Pipecat GitHub](https://github.com/pipecat-ai/pipecat)
- [Pipecat Smart Turn v3](https://github.com/pipecat-ai/smart-turn)
- [Pipecat TTS Guide](https://docs.pipecat.ai/guides/learn/text-to-speech)

### Industry
- [Vapi Pipeline Architecture](https://vapi.ai/blog/how-we-built-vapi-s-voice-ai-pipeline-part-2)
- [Twilio Latency Guide](https://www.twilio.com/en-us/blog/developers/best-practices/guide-core-latency-ai-voice-agents)
- [Deepgram Text Chunking](https://developers.deepgram.com/docs/text-chunking-for-tts-optimization)
- [AssemblyAI Turn Detection](https://www.assemblyai.com/blog/turn-detection-endpointing-voice-agent)
- [Sierra Voice Latency](https://sierra.ai/blog/voice-latency)
- [SparkCo Barge-In Guide](https://sparkco.ai/blog/master-voice-agent-barge-in-detection-handling)
- [CallStack VAD Implementation](https://dev.to/callstacktech/implementing-vad-and-turn-taking-for-natural-voice-ai-flow-my-experience-1bdf)

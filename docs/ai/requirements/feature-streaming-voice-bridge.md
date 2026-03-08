---
phase: requirements
title: "Feature: Streaming Voice Bridge"
description: Replace sequential text-based voice pipeline with real-time bidirectional audio streaming
feature: streaming-voice-bridge
---

# Requirements: Streaming Voice Bridge

## Problem Statement

**What problem are we solving?**

The current Jarvis voice pipeline is sequential and slow:
1. User speaks → on-device ASR waits for 2s silence → produces text (~2-3s)
2. Text sent to OpenClaw → LLM generates full response (~2-5s)
3. Full text sent back → on-device TTS synthesizes audio (~0.5-1s)
4. Audio playback starts

**Total latency: 4-9 seconds** before the user hears anything. This creates a "walkie-talkie" experience, not a natural conversation. The user cannot interrupt the agent mid-response without awkward delays.

**Who is affected?**
- The primary user wearing Spectacles, interacting with the OpenClaw AI agent via voice.

**Current workaround:**
- `JarvisController.ts` uses `AsrModule` (on-device ASR → text) and `TextToSpeechModule` (text → on-device TTS). The entire flow is request-response with no overlap between stages.

## Goals & Objectives

**Primary goals:**
1. **Reduce time-to-first-audio** from 4-9 seconds to **<1 second** after the user stops speaking
2. **Enable streaming responses** — user hears audio as the LLM generates, not after it finishes
3. **Enable barge-in** — user can interrupt the agent mid-response and the agent immediately listens

**Secondary goals:**
4. Stream audio to OpenClaw instead of text, enabling richer voice understanding (tone, emphasis, pauses)
5. Support server-side VAD for smarter endpoint detection (shorter silence thresholds)
6. Maintain backward compatibility — text-based mode should still work as fallback

**Non-goals (out of scope):**
- Multi-party rooms / LiveKit integration (future upgrade path)
- Video streaming from camera (keep existing JPEG snapshot approach for now)
- Custom wake word detection
- On-device ASR as primary path (becomes fallback only)
- Opus/compressed audio encoding (use raw PCM16 first, optimize later)

## User Stories & Use Cases

**US-1: Natural conversation**
> As a Spectacles user, I want to talk to the AI agent and hear its response begin almost immediately after I stop speaking, so the interaction feels like a real conversation.

**US-2: Barge-in / interruption**
> As a Spectacles user, I want to interrupt the agent while it's speaking by starting to talk, so I can redirect the conversation without waiting for it to finish.

**US-3: Streaming response**
> As a Spectacles user, I want to hear the agent's response word-by-word as it's being generated, not wait for the complete answer, so I get information faster.

**US-4: Continuous conversation**
> As a Spectacles user, I want to have a back-and-forth conversation without manually triggering each query, so the experience feels hands-free and natural.

**US-5: Visual query with voice**
> As a Spectacles user, I want to ask "what do you see?" and hear the agent describe what's in front of me with minimal delay, with camera capture happening in parallel with my speech.

### Key Workflows

**Normal conversation flow:**
```
User starts speaking
  → Mic audio streams to server immediately
  → Server runs VAD + streaming ASR in parallel
  → User stops speaking (server detects 500ms silence)
  → Server commits transcript to LLM
  → LLM begins generating tokens
  → Server-side streaming TTS converts first sentence to audio
  → Audio streams back to Spectacles (~300-500ms after user stops)
  → More audio chunks follow as LLM continues generating
  → Agent finishes → returns to listening state
```

**Barge-in flow:**
```
Agent is speaking (streaming audio chunks)
  → User starts speaking
  → Spectacles detects local audio input
  → Spectacles sends barge-in signal to server
  → Server cancels LLM generation + TTS pipeline
  → Server flushes pending audio
  → Server switches to processing new user input
  → User's new utterance is processed normally
```

### Edge Cases
- User speaks very briefly ("yes", "no") — server must handle short utterances without excessive silence wait
- Network jitter causes audio gaps — need buffering strategy
- User speaks during network disconnection — queue or discard?
- Agent response is very short ("Got it.") — single audio chunk, no streaming benefit
- Simultaneous visual query + voice — camera capture must not block audio pipeline

## Success Criteria

**SC-1: Latency**
- Time from end of user utterance to first audio response: **< 1000ms** (p50), **< 1500ms** (p95)
- Compare against current: 4000-9000ms baseline

**SC-2: Barge-in responsiveness**
- Time from user speech onset to agent audio stopping: **< 300ms**

**SC-3: Audio quality**
- No audible glitches/pops during normal conversation
- Smooth transitions between streaming audio chunks
- Server-side TTS quality comparable to or better than on-device `TextToSpeechModule`

**SC-4: Reliability**
- Graceful fallback to text mode if audio streaming fails
- No connection drops due to audio streaming overhead
- Audio pipeline doesn't interfere with existing OpenClaw protocol (heartbeats, events)

**SC-5: Battery impact**
- Streaming audio should not reduce session duration below 15 minutes on Spectacles
- Continuous mic capture + WiFi streaming is the primary power concern

## Constraints & Assumptions

### Technical Constraints
- **Spectacles APIs**: Must use `MicrophoneAudioProvider` (raw PCM16) and `AudioOutputProvider` (raw Float32 playback). No WebRTC, no Opus codec, no UDP.
- **WebSocket only**: All audio must travel over the existing WebSocket connection (or a parallel one). Binary frames supported (`Uint8Array`).
- **Permission model**: Requires Experimental APIs + Permission Alerts for mic + internet. Publishable but with user prompt on every launch + LED blink.
- **Single WebSocket**: Prefer multiplexing audio + control over one connection to avoid complexity. Consider separate audio WebSocket only if needed for performance.
- **Battery**: ~45 min total Spectacles battery. Continuous mic + WiFi streaming will reduce this. Target: 15+ min usable session.

### Server-Side Constraints
- OpenClaw gateway must be enhanced to accept audio input (or a proxy server sits in front)
- Need server-side ASR service (Deepgram, Whisper, etc.)
- Need server-side streaming TTS service (ElevenLabs, Cartesia, etc.)
- Server must handle binary WebSocket frames alongside existing JSON protocol

### Assumptions
- Spectacles WiFi bandwidth is sufficient for bidirectional 16kHz PCM16 mono (~64 KB/s each direction)
- OpenClaw's `agent` streaming events can be intercepted for real-time TTS conversion
- `MicrophoneAudioProvider` and `AudioOutputProvider` work reliably in continuous streaming mode
- Server-side TTS latency (first chunk) is < 200ms with services like Cartesia or ElevenLabs streaming

## Questions & Open Items

### Resolved
- **Q: Can Spectacles stream raw audio?** → YES: `MicrophoneAudioProvider.getAudioFramePCM16()` + binary WebSocket. Proven by Snap's AI Playground sample.
- **Q: Can Spectacles play raw audio from server?** → YES: `AudioOutputProvider.enqueueAudioFrame()`.
- **Q: Is this publishable?** → YES with Permission Alerts (Lens Studio v5.15.0+, Spectacles OS v5.64+).

### Open
- **Q1: Can OpenClaw be modified to accept streaming audio?** Or do we need a separate proxy server that handles ASR/TTS and talks to OpenClaw via text?
- **Q2: Which server-side TTS to use?** Cartesia (fastest, ~100ms first chunk) vs ElevenLabs (best quality) vs Deepgram TTS (integrated with ASR)?
- **Q3: Which server-side ASR to use?** Deepgram (streaming, fastest) vs Whisper (best accuracy) vs AssemblyAI?
- **Q4: Single WebSocket or two?** One for control+audio (simpler) vs one for control + one for audio (better separation)?
- **Q5: Should VAD run on-device, server-side, or hybrid?** Hybrid (device energy-gate + server Silero VAD) seems best.
- **Q6: What sample rate?** 16kHz (speech standard) vs 24kHz (OpenAI Realtime standard)?

---
phase: requirements
title: "Feature: Hybrid Voice Bridge"
description: Replace raw MicrophoneAudioProvider with native AsrModule for input, keep server-side TTS via voice proxy, support barge-in
feature: hybrid-voice-bridge
supersedes: streaming-voice-bridge (input path only)
---

# Requirements: Hybrid Voice Bridge

## Problem Statement

**What problem are we solving?**

The streaming voice bridge architecture (feature-streaming-voice-bridge) relies on `MicrophoneAudioProvider` to capture raw PCM16 audio from the Spectacles microphone. However, `MicrophoneAudioProvider.getAudioFrame()` returns zero-size frames on Spectacles hardware due to unresolvable `@exposesUserData` permission issues — no permission prompt appears, and the API silently returns empty data.

Meanwhile, the native `AsrModule` works perfectly on Spectacles — it handles its own mic permissions internally and produces accurate transcriptions. The current classic mode (using AsrModule + native TTS) works but has high latency (4-9s) due to sequential processing.

**The hybrid approach**: Use what works on each side:
- **Input**: Native `AsrModule` on Spectacles (proven working, handles mic permissions)
- **Output**: Server-side TTS via voice proxy (proven working, low latency streaming audio)
- **Barge-in**: AsrModule always-on mode detects user speech during agent response

**Who is affected?**
- The primary user wearing Spectacles, who currently cannot use streaming voice mode at all due to the mic permission issue.

**Current workaround:**
- Classic mode works (AsrModule + native TTS) but has 4-9s latency and no true streaming.

## Goals & Objectives

**Primary goals:**
1. **Unblock streaming voice** — Get a working streaming pipeline on actual Spectacles hardware
2. **Reduce response latency** — Server-side streaming TTS (Cartesia) starts audio playback as LLM generates, instead of waiting for full response
3. **Enable barge-in** — User can interrupt the agent mid-response using AsrModule always-on mode
4. **Reuse existing components** — Leverage working AsrModule (ChatASRController) and working voice proxy (VAD/ASR/TTS pipeline)

**Secondary goals:**
5. Keep the voice proxy architecture so it can be upgraded to full audio streaming if mic permissions are resolved in future Lens Studio updates
6. Maintain classic mode as fallback (text-only, no proxy dependency)
7. Support visual queries (camera capture on keywords like "look", "see")

**Non-goals (out of scope):**
- Fixing MicrophoneAudioProvider permissions (hardware/platform limitation)
- Server-side VAD/ASR (input handled on-device now)
- Multi-party rooms / LiveKit integration
- Wake word detection

## User Stories & Use Cases

**US-1: Natural conversation with streaming response**
> As a Spectacles user, I want to speak and hear the AI's response begin streaming back within ~1 second, so the interaction feels conversational.

**US-2: Barge-in interruption**
> As a Spectacles user, I want to interrupt the AI while it's speaking by simply talking, and have it stop and listen to my new request.

**US-3: Visual query in streaming mode**
> As a Spectacles user, I want to say "what do you see" and have the AI analyze what my camera sees, using the streaming response path.

**US-4: Seamless mode switching**
> As a developer, I want a `streamingMode` toggle that switches between classic (fully on-device) and hybrid (native ASR + proxy TTS) without code changes.

**Edge cases:**
- User speaks very short utterances (1-2 words) — AsrModule should still detect and transcribe
- User speaks while proxy is mid-TTS — barge-in must flush audio and cancel server response
- Network drops mid-response — graceful degradation, no crash
- Proxy server unreachable — fallback to classic mode

## Success Criteria

1. **Streaming voice works on real Spectacles hardware** (not just preview)
2. **Time-to-first-audio < 2 seconds** after user stops speaking (vs 4-9s in classic mode)
3. **Barge-in latency < 500ms** from user speech to agent silence
4. **No mic permission prompts needed** — AsrModule handles this internally
5. **Visual queries work** in hybrid mode (camera capture + proxy response)

## Constraints & Assumptions

**Technical constraints:**
- `MicrophoneAudioProvider` is unusable on Spectacles (zero frames, no permission flow)
- `AsrModule` takes exclusive mic access — cannot run simultaneously with MicrophoneAudioProvider
- `AudioOutputProvider` confirmed safe — no `@exposesUserData`, not in Spectacles permission table
- Must follow Snap sample pattern: create `AudioComponent`, call `play(-1)` before enqueuing frames
- Voice proxy server must be reachable on local network (no mDNS, IP-only)

**Assumptions:**
- AsrModule always-on mode (ChatASRController) reliably detects speech and produces transcriptions
- Voice proxy TTS pipeline (Cartesia WebSocket) continues to work for text→audio
- WebSocket text frames work on Spectacles (confirmed working)
- WebSocket binary frames work on Spectacles for receiving TTS audio (needs testing)

## Questions & Open Items

1. ~~**AudioOutputProvider**: Does it work on Spectacles without the same permission issues as MicrophoneAudioProvider?~~ **RESOLVED**: Yes — no `@exposesUserData` annotation, not in Spectacles permission table. Safe to use. Must follow Snap sample pattern: `AudioComponent.play(-1)` before enqueuing.
2. **Proxy protocol simplification**: With ASR on-device, do we still need the full binary audio protocol? Or can we switch to text-only JSON messages?
3. **Barge-in mechanism**: Should barge-in be detected by AsrModule (new transcription while responding) or by a simpler signal (any ASR activity)?
4. **Latency measurement**: How to measure end-to-end latency on Spectacles? (No profiling tools available)

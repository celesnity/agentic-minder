# Jarvis Voice Bridge - Project Rules

## Project Context
Jarvis Voice Bridge: Spectacles act as a thin voice I/O bridge to an OpenClaw AI gateway server. All AI reasoning, tools, storage, and memory are handled server-side.

## Architecture

### Classic Mode (streamingMode=false)
```
Voice In (ASR) -> JarvisController -> OpenClawBridge -> OpenClaw Server
                       |                    |
                       +-- Native TTS <-----+ (streaming response)
                       +-- Chat UI <--------+ (text display)
                       +-- Camera Capture ->   (visual queries)
```

### Streaming Mode (streamingMode=true)
```
Spectacles Mic → StreamingAudioBridge → WebSocket → Voice Proxy Server
                                                         |
                                        VAD → ASR → OpenClaw → TTS
                                                         |
Spectacles Speaker ← StreamingAudioBridge ← WebSocket ←─┘
                                                         |
Chat UI ← ChatBridge ← JarvisController ← StreamingVoiceController
```
- Binary WebSocket frames = PCM16 audio (640 bytes per 20ms frame at 16kHz)
- Text WebSocket frames = JSON control messages (session.start, vad.*, transcript.*, response.*, input.attachment, etc.)
- Visual queries: Spectacles sends `input.attachment` with base64 JPEG → proxy includes in next `chat.send`
- Voice proxy at `ws://host:8765`, OpenClaw at `ws://host:18789`

## Key Files

### Spectacles (TypeScript)
- `Scripts/JarvisController.ts` — Central coordinator; `streamingMode` toggle switches between classic and streaming voice
- `Scripts/ASR/ChatASRController.ts` — Voice input with always-on mode and barge-in (classic mode)
- `Scripts/Streaming/StreamingVoiceController.ts` — Streaming voice state machine; own WebSocket to voice proxy
- `Scripts/Streaming/StreamingAudioBridge.ts` — Raw mic capture + audio playback via MicrophoneAudioProvider/AudioOutputProvider
- `Scripts/Components/ChatBridge.ts` — Connects JarvisController to ChatComponent (supports both modes)
- `Scripts/Components/ChatComponent.ts` — Card-based chat UI
- `Scripts/Bridge/OpenClawBridge.ts` — WebSocket client for OpenClaw protocol v3 (classic mode)
- `Scripts/Bridge/OpenClawProtocol.ts` — Frame serialization
- `Scripts/Bridge/OpenClawAuth.ts` — Token management
- `Scripts/Bridge/OpenClawConfig.ts` — Configuration persistence
- `Scripts/Bridge/OpenClawTypes.ts` — Protocol type definitions
- `Scripts/Utils/ChatExtensions.ts` — Chat UI helpers
- `Scripts/Utils/TextLimiter.ts` — Character limit enforcement

### Voice Proxy Server (Python)
- `voice-proxy/server.py` — FastAPI WebSocket server entry point
- `voice-proxy/pipeline.py` — Audio pipeline orchestrator (VAD → ASR → OpenClaw → TTS, parallel streaming)
- `voice-proxy/vad.py` — Silero VAD v5 (ONNX, 256-sample frames, 4-state)
- `voice-proxy/asr.py` — Deepgram ASR (raw WebSocket, nova-3)
- `voice-proxy/tts.py` — Cartesia TTS (persistent WebSocket, sonic-2, pre-connected at session start)
- `voice-proxy/openclaw_client.py` — OpenClaw protocol v3 Python client
- `voice-proxy/config.py` — Configuration (.env loading)

## Code Style & Standards
- Follow Lens Studio / Spectacles TypeScript conventions
- Use `@component` decorator for scene components
- Use `@input` for Inspector-exposed properties
- Use `print()` for logging (not console.log)
- Import timers from `SpectaclesInteractionKit.lspkg/Utils/FunctionTimingUtils`
- Import Event from `SpectaclesInteractionKit.lspkg/Utils/Event`

## OpenClaw Protocol Notes
- Client ID: `gateway-client` (NOT `openclaw-control-ui`)
- Auth: token-only via `gateway.auth.token` in openclaw.json
- Handshake: challenge-response with 750ms fallback
- Streaming text arrives via `chat` events with `state: "delta"` (accumulated text in `message.content`)
- `agent` events have `data` field (accumulated state, NOT incremental tokens) — do NOT use for text extraction
- `chat` event `state: "final"` may lack `message` field if agent errors (e.g., expired OAuth)
- `chat.send` returns ack immediately; response is async via broadcast events

## Documentation
- `docs/ai/` — Phase documentation (requirements, design, planning, implementation)
- `docs/ai/implementation/knowledge-agentic-minder-repo.md` — Historical (pre-refactor)
- `docs/ai/implementation/knowledge-openclaw.md` — OpenClaw protocol knowledge

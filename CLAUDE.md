# Jarvis Voice Bridge - Project Rules

## Project Context
Jarvis Voice Bridge: Spectacles act as a thin voice I/O bridge to an OpenClaw AI gateway server. All AI reasoning, tools, storage, and memory are handled server-side.

## Architecture
```
Voice In (ASR) -> JarvisController -> OpenClawBridge -> OpenClaw Server
                       |                    |
                       +-- Native TTS <-----+ (streaming response)
                       +-- Chat UI <--------+ (text display)
                       +-- Camera Capture ->   (visual queries)
```

## Key Files
- `Scripts/JarvisController.ts` — Central coordinator (query processing, TTS, camera, events)
- `Scripts/ASR/ChatASRController.ts` — Voice input with always-on mode and barge-in
- `Scripts/Components/ChatBridge.ts` — Connects JarvisController to ChatComponent
- `Scripts/Components/ChatComponent.ts` — Card-based chat UI
- `Scripts/Bridge/OpenClawBridge.ts` — WebSocket client for OpenClaw protocol v3
- `Scripts/Bridge/OpenClawProtocol.ts` — Frame serialization
- `Scripts/Bridge/OpenClawAuth.ts` — Token management
- `Scripts/Bridge/OpenClawConfig.ts` — Configuration persistence
- `Scripts/Bridge/OpenClawTypes.ts` — Protocol type definitions
- `Scripts/Utils/ChatExtensions.ts` — Chat UI helpers
- `Scripts/Utils/TextLimiter.ts` — Character limit enforcement

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
- Responses arrive as `chat` events (NOT `agent` events for final text)
- `chat.send` returns ack immediately; response is async via broadcast events

## Documentation
- `docs/ai/` — Phase documentation (requirements, design, planning, implementation)
- `docs/ai/implementation/knowledge-agentic-minder-repo.md` — Historical (pre-refactor)
- `docs/ai/implementation/knowledge-openclaw.md` — OpenClaw protocol knowledge

---
phase: requirements
title: "Feature: Gateway Bridge - OpenClaw Integration"
description: Bridge AgenticMinder smart glass app to OpenClaw core AI agent for personal context management
---

# Requirements & Problem Understanding

## Problem Statement
**What problem are we solving?**

- AgenticMinder (the smart glass app on Spectacles) currently routes all AI requests directly to OpenAI and Gemini APIs via RemoteServiceGateway. This means every conversation is stateless — the AI has no persistent personal context, no memory of past interactions, and no ability to manage user-specific knowledge across sessions.
- OpenClaw is a fully-featured AI agent platform with session management, personal context, multi-agent workspaces, memory (embeddings + vector search), and 93+ RPC methods — but it currently has no smart glass transport.
- Users cannot get a "real Jarvis" experience because the glass app and the core agent brain are completely disconnected. Each interaction starts from zero.
- The current workaround is the local `AgentMemorySystem` with 10MB device storage and a 10-message conversation context window — grossly insufficient for a personal assistant.

## Goals & Objectives
**What do we want to achieve?**

### Primary Goals
1. **Bridge the smart glass app to OpenClaw** — Route all user queries from AgenticMinder through OpenClaw's gateway instead of directly to OpenAI/Gemini
2. **Enable personal context** — Leverage OpenClaw's session management, memory system, and agent runtime to maintain persistent personal context across all interactions
3. **Maintain real-time voice I/O** — Preserve the current voice-in (ASR) / voice-out (TTS) pipeline with minimal latency increase
4. **Support multimodal input** — Forward camera frames and audio data alongside text queries to OpenClaw for spatial and environmental awareness
5. **Device registration** — Register the smart glasses as a paired device in OpenClaw's device ecosystem

### Secondary Goals
- Enable cross-device context sharing (e.g., start conversation on glasses, continue on phone)
- Support OpenClaw's event broadcasting for proactive notifications on glasses
- Allow tool execution results from OpenClaw agents to drive glass UI (diagrams, summaries, images)
- Lay the foundation for multi-glass-provider support (Meta Ray-Ban, etc.)

### Non-Goals (Explicitly Out of Scope)
- Modifying OpenClaw's core agent logic, LLM provider routing, or tool/skill execution engine (minor protocol schema additions like a new `GatewayClientMode` for smart glasses ARE in scope)
- Replacing the existing Summary/Chat/Diagram systems (they will be enhanced, not replaced)
- Building a new RemoteServiceGateway package (we use Snap's existing package)
- Implementing OpenClaw's full admin/operator UI on glasses
- Offline-first functionality (requires network connection to OpenClaw)

## User Stories & Use Cases
**How will users interact with the solution?**

### Primary User Stories

**US-1: Conversational Personal Assistant** (P0)
> As a user wearing smart glasses, I want to talk to my personal assistant and have it remember our past conversations, my preferences, and my context, so that every interaction builds on what it already knows about me.

Acceptance Criteria:
- AC-1.1: Query from glasses appears in OpenClaw session history
- AC-1.2: OpenClaw response references context from previous turns in the same session
- AC-1.3: Personal context stored in OpenClaw's memory system is reflected in responses (e.g., user preferences, facts shared earlier)

**US-2: Seamless Voice Interaction** (P0)
> As a user, I want to speak naturally and hear voice responses through my glasses with low latency (<2s for first word), so that the conversation feels like talking to a real assistant.

Acceptance Criteria:
- AC-2.1: First response text appears on AR display within 2s of query completion
- AC-2.2: Voice playback begins within 3s of query completion
- AC-2.3: Voice output is clear and audible through Spectacles speakers
- AC-2.4: Conversation feels natural with no pauses >3s between user finish and first response

**US-3: Visual Context Awareness** (P1)
> As a user, I want my assistant to see what I see through the glasses camera when I ask about my surroundings, so that it can help me identify objects, read text, navigate, or understand my environment.

Acceptance Criteria:
- AC-3.1: Camera frame captured as base64 JPEG (matching existing Gemini pattern: 1500px, HighQuality)
- AC-3.2: Camera frame included in `chat.send` request to OpenClaw when spatial intent detected
- AC-3.3: OpenClaw response demonstrates awareness of the visual content in the frame

**US-4: Persistent Memory** (P1)
> As a user, I want my assistant to remember things I told it yesterday, last week, or last month, so I don't have to repeat myself or re-explain context.

Acceptance Criteria:
- AC-4.1: Information shared in session A is retrievable by OpenClaw in session B (different day)
- AC-4.2: OpenClaw uses its embedding-based memory + session history for context retrieval
- AC-4.3: User can ask "what do you remember about X?" and get accurate recall

**US-5: Session Continuity** (P0)
> As a user, I want to pick up a conversation where I left off, even after taking off my glasses and putting them back on later, so that context is never lost.

Acceptance Criteria:
- AC-5.1: Session key persisted in Spectacles PersistentStorage across app restarts
- AC-5.2: Reconnection resumes the same OpenClaw session (verified by session key match)
- AC-5.3: Last 10 conversation turns retrievable via `chat.history` after reconnection

### Edge Cases
- Network disconnection mid-conversation (graceful degradation with local fallback)
- OpenClaw server unreachable (fallback to direct AI provider mode)
- High latency connections (>5s) — timeout handling and user feedback
- Multiple glasses paired to same OpenClaw instance
- Large camera frame payloads over constrained bandwidth
- OpenClaw agent processing long-running tool chains (>15s)

## Success Criteria
**How will we know when we're done?**

1. **Connection**: Smart glasses can establish and maintain a WebSocket connection to OpenClaw gateway via `InternetModule.createWebSocket()` (dev) or `createAPIWebSocket` (production)
2. **Authentication**: Glasses complete device pairing and token-based authentication with OpenClaw
3. **Text Query**: User can speak a query → ASR transcribes → sent to OpenClaw via `chat.send` → response displayed on glasses
4. **Voice Response**: OpenClaw text responses are converted to voice output on glasses with <2s first-word latency
5. **Context Persistence**: A conversation on OpenClaw retains context — asking "what did we talk about?" returns accurate history
6. **Camera Input**: Spatial queries forward camera frames to OpenClaw and receive context-aware responses
7. **Reconnection**: After disconnection, glasses automatically reconnect and resume the active session
8. **Fallback**: If OpenClaw is unreachable, the app falls back to direct AI provider mode (current behavior)

## Constraints & Assumptions
**What limitations do we need to work within?**

### Technical Constraints — Platform Transport Limitation (CRITICAL)

The Spectacles platform has a fundamental constraint that shapes the entire architecture:

1. **Privacy-sensitive data (camera, audio, location)** is disabled when a Lens accesses the internet via standard `InternetModule.createWebSocket()`.
2. **RemoteServiceGateway (RSG)** is the ONLY exception — it allows internet + privacy data simultaneously, but ONLY to pre-registered services (OpenAI, Gemini, DeepSeek, Snap3D).
3. **`createAPIWebSocket` with allowlisted specification ID** is a second exception path — custom WebSocket endpoints can be allowlisted by Snap to work alongside privacy data.
4. **Extended Permissions** mode allows both internet + privacy data for ANY endpoint, but lenses with Extended Permissions **cannot be published**.

**Implication**: We cannot connect to an arbitrary OpenClaw server AND use camera/audio simultaneously in a published lens — unless we get OpenClaw's endpoint allowlisted by Snap via `createAPIWebSocket`.

### Two-Phase Transport Strategy

| Phase | Transport | Camera+Audio | Publishable | OpenClaw Location |
|-------|-----------|-------------|-------------|-------------------|
| **Dev (Phase 1)** | `InternetModule.createWebSocket('ws://local-ip:18789')` with Extended Permissions | YES | NO | Local machine (same WiFi) |
| **Production (Phase 2)** | `createAPIWebSocket` with Snap-allowlisted spec ID OR RSG proxy integration | YES | YES | Cloud server |

### Other Technical Constraints
- **Character Limits**: AR display is constrained (150-785 chars depending on component) — responses from OpenClaw must respect these limits
- **Device Storage**: 10MB persistent storage limit on Spectacles
- **TypeScript ES2021**: Lens Studio scripting environment with limited Node.js APIs
- **Audio Format**: OpenAI Realtime uses 24kHz PCM, Gemini uses 16kHz — TTS handled client-side via RSG providers
- **Network Latency**: On local network, latency is minimal (<50ms). Cloud deployment adds hop latency.
- **WebSocket Security**: `ws://` (insecure) allowed with Extended Permissions for dev. `wss://` required for production.

### Assumptions
- **Phase 1**: OpenClaw runs on the user's local machine, accessible on the same WiFi network as Spectacles
- **Phase 2**: OpenClaw deployed on cloud server; Snap allowlists the endpoint via `createAPIWebSocket` OR a proxy pattern is used through RSG
- ASR transcription happens on-device (no change) — only text is sent to OpenClaw
- TTS is handled client-side via existing OpenAI/Gemini voice synthesis through RSG
- OpenClaw's existing `chat.send` RPC method can handle the query format needed by the glasses
- The existing device pairing flow (`device.pair.*`, `device.token.*`) can be adapted for smart glass authentication

## Questions & Open Items
**What do we still need to clarify?**

1. **~~WebSocket Endpoint~~** (**RESOLVED**): RSG does NOT support arbitrary endpoints. Using `InternetModule.createWebSocket()` with Extended Permissions for dev phase. `createAPIWebSocket` allowlisting for production.
2. **~~Audio Streaming~~** (**RESOLVED**): ASR happens on-device, text sent to OpenClaw. TTS handled client-side via RSG.
3. **~~TTS Strategy~~** (**RESOLVED**): Text → client-side TTS via existing OpenAI/Gemini pipeline through RSG.
4. **~~OpenClaw Deployment~~** (**RESOLVED**): Local machine first (dev), cloud server later (production).
5. **Camera Frame Format**: What format/resolution should camera frames be in when forwarded to OpenClaw? Base64 JPEG (current Gemini pattern) or raw bytes?
6. **Rate Limiting**: Does OpenClaw's gateway rate-limit device connections differently than CLI/browser clients?
7. **Protocol Extension**: Do we need a new `GatewayClientMode` for smart glasses in OpenClaw's protocol schema, or can we use an existing mode?
8. **Concurrent Connections**: Can multiple glasses connect to the same OpenClaw session simultaneously?
9. **`createAPIWebSocket` Process**: What is the process to get a custom WebSocket endpoint allowlisted by Snap? Timeline and requirements?
10. **Local Network Discovery**: How does the glasses app discover the local machine's IP address for dev mode? Manual config, mDNS, or QR code?

# Jarvis Voice Bridge

[![SIK](https://img.shields.io/badge/SIK-Light%20Gray?color=D3D3D3)](https://developers.snap.com/spectacles/spectacles-frameworks/spectacles-interaction-kit/features/overview) [![Text To Speech](https://img.shields.io/badge/Text%20To%20Speech-Light%20Gray?color=D3D3D3)](https://developers.snap.com/spectacles/about-spectacles-features/compatibility-list) [![Speech To Text](https://img.shields.io/badge/Speech%20To%20Text-Light%20Gray?color=D3D3D3)](https://developers.snap.com/spectacles/about-spectacles-features/compatibility-list) [![Camera Access](https://img.shields.io/badge/Camera%20Access-Light%20Gray?color=D3D3D3)](https://developers.snap.com/spectacles/about-spectacles-features/apis/camera-module) [![WebSocket](https://img.shields.io/badge/WebSocket-Light%20Gray?color=D3D3D3)](https://developers.snap.com/spectacles/about-spectacles-features/compatibility-list)

**A thin voice I/O bridge for Snap Spectacles connecting to an OpenClaw AI gateway.**

Spectacles act as a lightweight voice interface — all AI reasoning, tools, storage, and memory are handled server-side by OpenClaw.

> **NOTE:**
> This project only works on the **Spectacles platform**. Set simulation mode in Lens Studio Preview to `Spectacles (2024)`.

## Architecture

```
Voice In (ASR) ──> JarvisController ──> OpenClawBridge ──> OpenClaw Server
                        |                     |
                        +-- Native TTS <------+ (streaming response)
                        +-- Chat UI <---------+ (text display)
                        +-- Camera Capture -->   (visual queries as attachments)
```

### Components

| Component | Purpose |
|-----------|---------|
| **JarvisController** | Central coordinator: query processing, TTS, camera capture, event routing |
| **ChatASRController** | Voice input via ASR with always-on mode and barge-in support |
| **ChatBridge** | Connects JarvisController events to ChatComponent for UI display |
| **ChatComponent** | Card-based chat UI (user + bot messages) |
| **OpenClawBridge** | WebSocket client for OpenClaw gateway protocol v3 |
| **OpenClawProtocol** | Frame serialization, correlation, validation |
| **OpenClawAuth** | Token management, ConnectParams builder |
| **OpenClawConfig** | Default config + PersistentStorage persistence |
| **OpenClawTypes** | Protocol type interfaces |

### File Structure

```
Scripts/
+-- ASR/
|   +-- ChatASRController.ts     # Voice input, always-on mode, barge-in
+-- Bridge/
|   +-- OpenClawTypes.ts         # Protocol type definitions
|   +-- OpenClawProtocol.ts      # Frame serialization
|   +-- OpenClawAuth.ts          # Token management
|   +-- OpenClawConfig.ts        # Configuration persistence
|   +-- OpenClawBridge.ts        # WebSocket client, handshake, streaming
+-- Components/
|   +-- ChatComponent.ts         # Card-based chat UI
|   +-- ChatBridge.ts            # JarvisController -> ChatComponent bridge
+-- JarvisController.ts          # Central coordinator (~300 lines)
+-- Utils/
    +-- ChatExtensions.ts        # Chat UI helpers
    +-- TextLimiter.ts           # Character limit enforcement
```

## Data Flow

### Voice Query Flow

```
1. User speaks
2. ChatASRController transcribes via ASR
3. JarvisController.processQueryNonBlocking(query)
   a. Detect visual keywords -> optionally capture camera frame
   b. OpenClawBridge.sendQuery({text, imageData})
   c. OpenClaw server processes and responds
   d. Streaming deltas update ChatComponent progressively
   e. Final response spoken via native TTS
4. ASR restarts immediately (always-on mode)
```

### Barge-in Flow

```
1. TTS is playing response audio
2. User starts speaking (ASR detects partial text > 3 chars)
3. ChatASRController calls jarvisController.abortCurrentQuery()
4. TTS stops, OpenClaw query aborted
5. New query dispatched
```

## Prerequisites

- **Lens Studio**: v5.15.0+
- **Spectacles OS**: v5.64+
- **OpenClaw Server**: Running and accessible on the network
- **Git LFS**: Required for project assets

## Setup

### 1. OpenClaw Server

Ensure your OpenClaw gateway is running:

```bash
openclaw gateway --bind lan
```

Note the server's IP address and auth token from `~/.openclaw/openclaw.json`.

### 2. JarvisController Configuration

In the Lens Studio Inspector, configure the JarvisController component:

```
serverUrl: ws://<your-server-ip>:18789
authToken: <your-gateway-auth-token>
enableVoiceOutput: true
remoteServiceModule: (assign RemoteServiceModule)
ttsAudioComponent: (assign AudioComponent)
```

### 3. Testing

1. Set **Device Type Override** to "Spectacles" in Preview
2. Enable **Experimental APIs** in Project Settings (for ws:// WebSocket)
3. Use headphones to prevent audio feedback
4. Speak to trigger voice queries

## OpenClaw Protocol

The bridge implements OpenClaw Gateway Protocol v3:

- **Handshake**: Server sends `connect.challenge` with nonce -> client sends ConnectParams -> server responds with HelloOk
- **Authentication**: Token-only auth (`gateway.auth.token`)
- **Queries**: `chat.send` with async response via `chat`/`agent` broadcast events
- **Streaming**: `agent` events for token-by-token streaming, `chat` events for final response
- **Heartbeat**: Server `tick` events, client monitors for 3 missed heartbeats
- **Reconnection**: Exponential backoff (1s-30s) with jitter

## License

This project is developed as part of the Snap Spectacles ecosystem. Please refer to [Snap's Developer Terms](https://www.snap.com/terms/spectacles) for usage guidelines.

---
phase: implementation
title: "Feature: Gateway Bridge - Implementation Guide"
description: Technical implementation notes for bridging AgenticMinder to OpenClaw
---

# Implementation Guide

## Development Setup
**How do we get started?**

### Prerequisites
- Lens Studio v5.15.0+ installed
- Spectacles device or emulator with OS v5.64+
- OpenClaw server running and accessible via `wss://` endpoint
- RemoteServiceGateway.lspkg v1.x (already included in project)
- TypeScript ES2021 environment (already configured via tsconfig.json)

### Environment Setup
1. Ensure OpenClaw server is running: `cd openclaw && npm start` (or deployed server URL)
2. Configure server URL in `OpenClawConfig.ts` or via persistent storage setting
3. Verify WebSocket connectivity: test `wss://` endpoint from Lens Studio preview
4. Generate device pairing token via OpenClaw CLI: `openclaw device pair --label "spectacles-dev"`

### Configuration
```typescript
// Default configuration values
const OPENCLAW_DEFAULTS = {
    serverUrl: 'wss://localhost:18789',   // Override for production
    connectTimeout: 5000,                  // 5s connection timeout
    requestTimeout: 15000,                 // 15s per RPC request
    heartbeatInterval: 30000,              // 30s heartbeat expected
    maxReconnectAttempts: 10,              // Give up after 10 tries
    maxReconnectDelay: 30000,              // Max 30s between retries
    maxConcurrentRequests: 3,              // In-flight request limit
    enableCamera: true,                    // Forward camera frames
    enableVoice: true,                     // Client-side TTS
    enableStreaming: true,                 // Progressive response display
};
```

## Code Structure
**How is the code organized?**

### New Files (in `Assets/AgenticPlayground/Scripts/`)
```
Scripts/
├── Bridge/                          # New directory for OpenClaw bridge
│   ├── OpenClawBridge.ts            # Main bridge — connection + RPC
│   ├── OpenClawProtocol.ts          # Frame serialization & correlation
│   ├── OpenClawAuth.ts              # Device pairing & token management
│   ├── OpenClawConfig.ts            # Configuration & feature flags
│   └── OpenClawTypes.ts             # All TypeScript interfaces
```

### Modified Files
```
Scripts/
├── Agents/
│   ├── AgentOrchestrator.ts         # Add OpenClaw routing mode
│   └── AgentLanguageInterface.ts    # Add OpenClaw voice fallback
├── Components/
│   └── ChatBridge.ts                # Subscribe to streaming events
```

### Naming Conventions
- All OpenClaw-related files prefixed with `OpenClaw`
- Events follow existing pattern: `onEventName: Event<PayloadType>`
- Storage keys prefixed: `openclaw_*`
- Log messages prefixed: `[OpenClaw]`

## Implementation Notes
**Key technical details to remember:**

### Core Features

#### Feature 1: WebSocket Connection to OpenClaw

**RESOLVED**: `RemoteServiceGateway` does NOT support arbitrary WebSocket endpoints. We use `InternetModule.createWebSocket()` instead.

**Dev Mode** (Extended Permissions enabled — allows camera+audio+internet simultaneously):
```typescript
// InternetModule approach — connects to ANY endpoint
// Requires Extended Permissions enabled in Lens Studio for camera+audio access
@input
remoteServiceModule: RemoteServiceModule;  // Still needed for InternetModule access

private socket!: WebSocket;

// Create WebSocket to local OpenClaw server
this.socket = this.remoteServiceModule.createWebSocket('ws://192.168.1.100:18789');

this.socket.onopen = (event: WebSocketEvent) => {
    // Send ConnectParams handshake
    this.sendConnectParams();
};

this.socket.onmessage = async (event: WebSocketMessageEvent) => {
    if (typeof event.data === 'string') {
        this.handleFrame(JSON.parse(event.data));
    }
};

this.socket.onclose = (event: WebSocketCloseEvent) => {
    if (!event.wasClean) {
        this.scheduleReconnect();
    }
};

this.socket.onerror = (event: WebSocketEvent) => {
    print('[OpenClaw] Socket error');
};
```

**Production Mode** (future — requires Snap allowlisting):
```typescript
// createAPIWebSocket with allowlisted specification ID
// Allows camera+audio+internet simultaneously AND publishing
// this.socket = this.remoteServiceModule.createAPIWebSocket(specId, 'wss://openclaw.example.com:18789');
```

**Important**: The transport layer is abstracted in `OpenClawBridge.ts` so switching between dev and production transport requires changing only the socket creation call.

#### Feature 2: Protocol v3 Client Implementation
Frame handling based on OpenClaw's protocol:

```typescript
// Sending a request
function sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = String(++this.messageCounter);
    const frame: RequestFrame = { type: 'req', id, method, params };

    return new Promise((resolve, reject) => {
        this.pendingRequests.set(id, { resolve, reject, timeout: Date.now() + 15000 });
        this.ws.send(JSON.stringify(frame));
    });
}

// Receiving frames
function handleMessage(data: string): void {
    const frame = JSON.parse(data);
    switch (frame.type) {
        case 'res':
            const pending = this.pendingRequests.get(frame.id);
            if (pending) {
                this.pendingRequests.delete(frame.id);
                frame.ok ? pending.resolve(frame.payload) : pending.reject(frame.error);
            }
            break;
        case 'event':
            this.handleEvent(frame.event, frame.payload);
            break;
        case 'tick':
            this.lastHeartbeat = Date.now();
            break;
        case 'shutdown':
            this.handleShutdown(frame.payload);
            break;
    }
}
```

#### Feature 3: AgentOrchestrator Dual-Mode Routing
The orchestrator modification is minimal — add a mode check before tool routing:

```typescript
// In AgentOrchestrator.processUserQuery():
if (this.openClawBridge?.isConnected()) {
    // Route through OpenClaw
    const glassQuery: GlassQuery = {
        text: query,
        imageData: context?.cameraFrame,
        displayMode: this.getActiveDisplayMode(),
        maxResponseLength: TextLimiter.getLimit(this.getActiveDisplayMode()),
    };
    response = await this.openClawBridge.sendQuery(glassQuery);
} else {
    // Existing direct AI provider path
    response = await this.toolExecutor.executeTool('intelligent_conversation', toolArgs);
}
```

### Patterns & Best Practices

#### Event-Driven Architecture
Follow the existing codebase pattern for all OpenClaw events:
```typescript
// Event declaration (matches AgenticMinder convention)
public readonly onConnectionStateChanged = new Event<OpenClawConnectionState>();
public readonly onStreamingResponse = new Event<{ text: string; done: boolean }>();
public readonly onError = new Event<{ code: number; message: string }>();
```

#### Singleton Pattern
Match the existing pattern used by `GenerationQueue`, `ModelGenerationScheduler`:
```typescript
private static _instance: OpenClawBridge;
public static getInstance(): OpenClawBridge {
    if (!OpenClawBridge._instance) {
        OpenClawBridge._instance = new OpenClawBridge();
    }
    return OpenClawBridge._instance;
}
```

#### PersistentStorage Pattern
Match `AgentMemorySystem` storage pattern:
```typescript
const STORAGE_KEYS = {
    deviceToken: 'openclaw_device_token',
    sessionKey: 'openclaw_session_key',
    serverUrl: 'openclaw_server_url',
    config: 'openclaw_config',
} as const;
```

## Integration Points
**How do pieces connect?**

### AgentOrchestrator ↔ OpenClawBridge
- Orchestrator calls `bridge.sendQuery()` for text queries
- Orchestrator subscribes to `bridge.onStreamingResponse` for progressive display
- Orchestrator checks `bridge.isConnected()` for routing decisions
- Bridge fires `bridge.onConnectionStateChanged` for fallback logic

### ChatASRController ↔ AgentOrchestrator (unchanged)
- ASR still delivers transcribed text to `orchestrator.processUserQuery()`
- The orchestrator internally decides whether to route to OpenClaw or direct AI
- No changes needed in ASR controllers

### OpenClawBridge ↔ RemoteServiceGateway
- Bridge creates WebSocket via `remoteServiceModule.createWebSocket()`
- All data flows through Snap's proxy (transparent to our code)
- Connection lifecycle managed by bridge, transport managed by RSG

### ChatBridge ↔ OpenClawBridge (streaming)
- ChatBridge subscribes to `OpenClawBridge.onStreamingResponse`
- On each token event, updates ChatComponent display
- On completion (`done: true`), finalizes display and triggers voice output

### OpenClawAuth ↔ PersistentStorage
- Auth module stores/retrieves device token via `global.persistentStorageSystem`
- Token persists across app sessions (60-day expiry on Spectacles)
- First-time pairing requires user interaction (display pairing code on AR)

## Error Handling
**How do we handle failures?**

### Connection Errors
| Error | Handling |
|-------|---------|
| WebSocket open fails | Retry with exponential backoff. After max retries, switch to fallback mode |
| HelloOk not received within 5s | Close connection, retry. May indicate server overloaded |
| Auth token rejected | Clear stored token, trigger re-pairing flow |
| Protocol version mismatch | Log error, display "update required" message, use fallback |

### Request Errors
| Error | Handling |
|-------|---------|
| RPC timeout (15s) | Reject promise, log timeout, allow next request |
| Server error response (`ok: false`) | Map error code to user message, display on AR |
| Malformed response frame | Log parse error, reject pending request, do not disconnect |
| Rate limited | Back off for indicated duration, queue subsequent requests |

### Reconnection Strategy
```
disconnect detected
  → attempt 1: wait 1s → connect
  → attempt 2: wait 2s → connect
  → attempt 3: wait 4s → connect
  → attempt 4: wait 8s → connect
  → attempt 5-10: wait 30s → connect
  → give up → switch to fallback mode
  → background retry every 60s
```

## Performance Considerations
**How do we keep it fast?**

### Latency Optimization
- **Pre-connect**: Establish WebSocket connection during app initialization, before first user query
- **Keep-alive**: Maintain persistent connection (don't connect/disconnect per query)
- **Parallel operations**: Start voice output as soon as first streaming token arrives (don't wait for full response)
- **Lean payloads**: Only include camera frame when spatial query detected
- **Message correlation**: Use simple incrementing counter (not UUID) for message IDs to minimize overhead

### Memory Management
- **Pending request map**: Max 3 entries (concurrent request limit)
- **Event buffer**: Circular buffer of 50 events max
- **Frame parsing**: Parse JSON lazily — extract `type` field first, then full parse only if needed
- **Camera frames**: Don't retain base64 string after sending — let GC collect immediately

### Bandwidth Optimization
- **Camera frames**: JPEG quality 0.7 (not HighQuality 1.0) when forwarding to OpenClaw, max 1500px
- **Text responses**: Server-side character limit hint via `displayConstraints` in Connect params
- **Streaming**: Token batching if tokens arrive faster than UI can render (16ms frame budget)

## Security Notes
**What security measures are in place?**

### Transport Security
- All communication over `wss://` (TLS 1.2+)
- RemoteServiceGateway adds Snap's security layer (token-based proxy auth)
- No plain `ws://` in production builds

### Authentication
- Device token stored in Spectacles PersistentStorage (encrypted by Spectacles OS)
- Token scoped to `operator.read` + `operator.write` (no admin access)
- Pairing code displayed on AR display — requires physical proximity to approve
- Token revocable from OpenClaw admin interface

### Input Validation
- All incoming frames validated for expected structure before processing
- JSON parse errors caught and logged (don't crash on malformed data)
- Response payload size limit: reject frames > 1MB
- No `eval()` or dynamic code execution from server responses

---
phase: testing
title: "Feature: Gateway Bridge - Testing Strategy"
description: Testing approach for OpenClaw gateway bridge integration
---

# Testing Strategy

## Test Coverage Goals
**What level of testing do we aim for?**

- Unit test coverage target: 100% of new bridge modules (`OpenClawProtocol`, `OpenClawAuth`, `OpenClawConfig`, `OpenClawTypes`)
- Integration test scope: Connection lifecycle, query routing, streaming response handling, fallback mode switching
- End-to-end test scenarios: Full voice query → OpenClaw → AR display pipeline on Spectacles hardware
- Key acceptance criteria from requirements: connection <3s, first-word latency <2s, auto-reconnect <5s, fallback works

## Unit Tests
**What individual components need testing?**

### OpenClawProtocol
- [ ] Test: Serialize RequestFrame to valid JSON string
- [ ] Test: Deserialize valid ResponseFrame from JSON
- [ ] Test: Deserialize valid EventFrame from JSON
- [ ] Test: Handle malformed JSON input (should not throw, returns error)
- [ ] Test: Message ID generation is unique and incrementing
- [ ] Test: Request-response correlation matches correct pending request
- [ ] Test: Pending request timeout after 15s fires reject
- [ ] Test: Multiple concurrent requests tracked independently
- [ ] Test: Cleanup expired pending requests
- [ ] Test: Frame type discriminator correctly identifies res/event/tick/shutdown

### OpenClawAuth
- [ ] Test: Store device token to PersistentStorage
- [ ] Test: Retrieve device token from PersistentStorage
- [ ] Test: Return null when no token stored
- [ ] Test: Clear token on auth rejection
- [ ] Test: Build ConnectParams with stored token
- [ ] Test: Build ConnectParams without token (pairing mode)
- [ ] Test: Device info includes correct platform and capabilities

### OpenClawConfig
- [ ] Test: Default configuration values are correct
- [ ] Test: Override configuration values from PersistentStorage
- [ ] Test: Feature flag toggling (enableCamera, enableVoice, enableStreaming)
- [ ] Test: Server URL validation (must be wss:// in production)
- [ ] Test: Timeout values within acceptable ranges

### OpenClawTypes
- [ ] Test: GlassQuery interface accepts all valid field combinations
- [ ] Test: SmartGlassDeviceInfo includes required fields
- [ ] Test: ConnectionState enum covers all states

### OpenClawBridge (unit-level, with mocked WebSocket)
- [ ] Test: Connection state transitions: disconnected → connecting → authenticating → connected
- [ ] Test: Connection state on WebSocket error: → reconnecting
- [ ] Test: Connection state after max retries: → disconnected (fallback)
- [ ] Test: `sendQuery()` returns response text on success
- [ ] Test: `sendQuery()` rejects on server error response
- [ ] Test: `sendQuery()` rejects on timeout
- [ ] Test: `abortQuery()` sends `chat.abort` frame
- [ ] Test: `isConnected()` returns true only in 'connected' state
- [ ] Test: Streaming events emitted for `agent` event frames
- [ ] Test: Heartbeat monitoring triggers reconnect after 3 missed ticks
- [ ] Test: Exponential backoff timing: 1s, 2s, 4s, 8s, 30s, 30s...
- [ ] Test: `shutdown` event triggers graceful close and scheduled reconnect
- [ ] Test: Max concurrent requests (3) enforced — 4th request queued

## Integration Tests
**How do we test component interactions?**

### Connection & Handshake (requires mock OpenClaw server)
- [ ] Full Connect → HelloOk handshake with valid device token
- [ ] Connect with invalid token → auth rejection → re-pairing triggered
- [ ] Connect without token → pairing flow initiated → code displayed
- [ ] Protocol version mismatch handling
- [ ] Server closes connection → auto-reconnect with backoff

### Query Routing (requires mock OpenClaw server)
- [ ] Text query through AgentOrchestrator → OpenClawBridge → mock server → response displayed
- [ ] Query with camera frame → image data included in `chat.send` params
- [ ] Streaming response tokens → progressive ChatComponent update
- [ ] OpenClaw disconnected → query falls back to direct AI provider
- [ ] OpenClaw reconnects → next query routes through OpenClaw again

### Voice Pipeline Integration
- [ ] ASR transcription → OpenClaw query → text response → client-side TTS
- [ ] Verify voice output uses existing DynamicAudioOutput pipeline
- [ ] Verify response text is within character limits before TTS

### Session Management
- [ ] Session key stored after successful connection
- [ ] Session resumed on reconnection with stored key
- [ ] Session expired on server → new session created transparently
- [ ] Chat history fetched on reconnection and displayed

### Error Recovery
- [ ] Network loss mid-query → timeout → reconnect → user notified
- [ ] Server crash → reconnect sequence → fallback if unrecoverable
- [ ] Malformed server response → logged, connection maintained
- [ ] Rate limited → backoff applied, user notified of delay

## End-to-End Tests
**What user flows need validation?**

### E2E-1: First-Time Setup Flow
1. Launch app with no stored OpenClaw token
2. Verify pairing code displayed on AR
3. Approve pairing on OpenClaw server
4. Verify connection established (green indicator)
5. Speak a query → verify response on AR + voice

### E2E-2: Standard Conversation Flow
1. Launch app (auto-connect to OpenClaw)
2. Speak: "What's the weather like?"
3. Verify response displayed within 2s of query end
4. Verify voice response plays
5. Speak follow-up: "What about tomorrow?"
6. Verify OpenClaw uses conversation context (not a fresh query)

### E2E-3: Spatial Query Flow
1. Point glasses at an object
2. Speak: "What am I looking at?"
3. Verify camera frame captured and sent to OpenClaw
4. Verify context-aware response displayed

### E2E-4: Reconnection Flow
1. Establish connection to OpenClaw
2. Simulate network loss (disable WiFi)
3. Verify reconnecting indicator shown
4. Re-enable network
5. Verify connection re-established within 5s
6. Speak a query → verify it works

### E2E-5: Fallback Flow
1. Start with OpenClaw unreachable
2. Verify fallback to direct AI mode
3. Speak a query → verify direct AI response works
4. Start OpenClaw server
5. Verify background reconnect succeeds
6. Next query routes through OpenClaw

### E2E-6: Session Continuity
1. Have a conversation with OpenClaw ("My name is Alice")
2. Close and reopen the app
3. Speak: "What's my name?"
4. Verify OpenClaw remembers ("Alice")

## Test Data
**What data do we use for testing?**

### Mock OpenClaw Server
- Implement lightweight WebSocket server that speaks Protocol v3
- Supports Connect → HelloOk → req/res/event flow
- Configurable response delays for latency testing
- Configurable error injection (auth failure, timeout, malformed frames)

### Test Fixtures
```typescript
// Valid ConnectParams fixture
const MOCK_CONNECT_PARAMS = {
    clientId: 'test-spectacles-001',
    clientMode: 'smart-glass',
    platform: 'spectacles',
    osVersion: '5.64',
    appVersion: '1.0.0',
    capabilities: ['voice', 'camera', 'display'],
    auth: { type: 'token', token: 'test-device-token-abc123' },
};

// Valid HelloOk fixture
const MOCK_HELLO_OK = {
    version: 3,
    methods: ['chat.send', 'chat.abort', 'chat.history', 'sessions.list'],
    events: ['agent', 'tick', 'shutdown'],
};

// Valid chat.send response
const MOCK_CHAT_RESPONSE = {
    type: 'res',
    id: '1',
    ok: true,
    payload: { text: 'The weather is sunny and 72°F today.' },
};

// Streaming agent event sequence
const MOCK_STREAMING_EVENTS = [
    { type: 'event', event: 'agent', payload: { text: 'The ', done: false } },
    { type: 'event', event: 'agent', payload: { text: 'weather ', done: false } },
    { type: 'event', event: 'agent', payload: { text: 'is sunny.', done: true } },
];
```

### Test Database
- No database needed — OpenClaw manages all persistent state
- PersistentStorage mocked for unit tests

## Test Reporting & Coverage
**How do we verify and communicate test results?**

- Run unit tests via Lens Studio's built-in test runner (if available) or separate TypeScript test harness
- Coverage target: 100% of new files, 90%+ of modified code paths
- Document coverage gaps with rationale (e.g., "RemoteServiceGateway WebSocket creation cannot be unit tested — requires device")
- Manual test results documented in this file after each test cycle

### Coverage Gaps (Expected)
- `remoteServiceModule.createWebSocket()` — cannot be mocked in unit tests, requires integration test on device
- `DynamicAudioOutput.play()` — audio output verification requires human listener
- AR display rendering — visual verification requires Spectacles hardware

## Manual Testing
**What requires human validation?**

### Voice Quality Checklist
- [ ] Voice response is clear and audible on Spectacles speakers
- [ ] Latency from query end to first voice output is acceptable (<2s)
- [ ] No audio artifacts or cutoffs in TTS playback
- [ ] Voice volume is appropriate for ambient environments

### AR Display Checklist
- [ ] Response text fits within AR display bounds
- [ ] Streaming text updates are smooth (no flickering)
- [ ] Connection status indicator is visible but not distracting
- [ ] Pairing code is readable on AR display
- [ ] Character limits enforced (no text overflow)

### Interaction Checklist
- [ ] Natural conversation flow (no awkward pauses >3s)
- [ ] Follow-up questions use context from previous messages
- [ ] Camera queries respond to what's actually in view
- [ ] Abort command stops response generation immediately

### Network Resilience Checklist
- [ ] Reconnection works after WiFi toggle
- [ ] Reconnection works after walking out of and back into WiFi range
- [ ] Fallback mode activates when server is down
- [ ] No app crash on sudden disconnect
- [ ] No orphaned audio playback after disconnect

## Performance Testing
**How do we validate performance?**

### Latency Benchmarks
| Metric | Target | Method |
|--------|--------|--------|
| Connection establishment | <3s | Timestamp from `connect()` call to 'connected' state |
| First streaming token | <2s | Timestamp from `sendQuery()` to first `onStreamingResponse` |
| Full response | <5s | Timestamp from `sendQuery()` to `done: true` |
| Reconnection | <5s | Timestamp from disconnect detection to 'connected' state |
| Camera frame encoding | <200ms | Timestamp around base64 JPEG encoding |

### Stress Testing
- Rapid-fire 10 queries in 30 seconds → verify all responses received, no frame corruption
- 1-hour continuous session → verify no memory leaks, connection stable
- Alternate between OpenClaw and fallback mode 20 times → verify clean switching

### Resource Monitoring
- Memory usage before/after bridge initialization (target: <2MB overhead)
- WebSocket message throughput (target: handle 100 messages/second)
- Battery impact of persistent WebSocket connection (measure over 30 minutes)

## Bug Tracking
**How do we manage issues?**

### Issue Categories
1. **P0 - Blocker**: Connection cannot be established, queries don't work
2. **P1 - Critical**: Voice output broken, fallback doesn't work, data loss
3. **P2 - Major**: Reconnection slow, streaming flickers, wrong character limits
4. **P3 - Minor**: Log messages incorrect, config edge cases, cosmetic issues

### Regression Testing
- After any bridge code change, run full unit test suite
- After any AgentOrchestrator change, run integration test for both OpenClaw and direct mode
- Before release, complete full E2E test suite on Spectacles hardware

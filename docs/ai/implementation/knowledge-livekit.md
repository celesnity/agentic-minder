# LiveKit Server - Deep Architecture Knowledge

> Source: LiveKit Server v1.9.11 (`github.com/livekit/livekit-server`)
> Location: `/livekit/` in this repository
> Language: Go 1.24+ | WebRTC SFU using Pion stack

---

## 1. What Is LiveKit Server?

An open-source, production-grade **WebRTC Selective Forwarding Unit (SFU)** server. It routes real-time audio/video/data between participants without decoding or re-encoding media — only selectively forwarding RTP packets with header munging.

Key capabilities:
- JWT-authenticated room management
- Simulcast and SVC (VP9/AV1) codec support
- Speaker detection and adaptive streaming
- End-to-end encryption
- Distributed/multi-region deployment via Redis
- Embedded TURN server
- Webhooks, Egress/Ingress integration
- AI Agent framework (backend participants)
- SIP integration, WHIP ingress

---

## 2. Package Structure (`pkg/`)

| Package | Role |
|---|---|
| `sfu/` | Media routing core — receivers, downtracks, forwarders, BWE, pacers |
| `rtc/` | WebRTC session mgmt — rooms, participants, transport, subscriptions |
| `service/` | HTTP/WS layer — server init (Wire DI), room manager, signal relay |
| `routing/` | Node routing — local (single-node) or Redis (multi-node) |
| `agent/` | AI agent worker protocol — job dispatch, availability, assignment |
| `config/` | YAML/CLI configuration with reflection-based flag generation |
| `telemetry/` | Prometheus metrics, analytics, webhooks |
| `clientconfiguration/` | Per-client feature config (codec overrides by browser/OS) |
| `metric/` | Per-participant metrics collection |
| `utils/` | Shared utilities |
| `testutils/` | Test helpers |

### SFU Sub-packages
| Sub-package | Role |
|---|---|
| `sfu/buffer/` | RTP packet ring buffer, NACK history, video layer types |
| `sfu/bwe/` | Bandwidth estimation: `remotebwe/` (REMB), `sendsidebwe/` (TWCC) |
| `sfu/streamallocator/` | Allocates bandwidth across all DownTracks per subscriber PC |
| `sfu/streamtracker/` | Detects active simulcast layers |
| `sfu/connectionquality/` | Scores connection quality |
| `sfu/pacer/` | Paces outgoing RTP (LeakyBucket, PassThrough, NoQueue) |
| `sfu/codecmunger/` | Per-codec RTP header rewriting (VP8, VP9, H264, AV1) |
| `sfu/rtpstats/` | Per-track RTP statistics |
| `sfu/rtpextension/` | RTP header extension parsing |
| `sfu/videolayerselector/` | Temporal/spatial layer selection |
| `sfu/audio/` | Audio level detection |
| `sfu/ccutils/` | Congestion control utilities, prober |

---

## 3. HTTP Routes & Entry Points

| Route | Handler | Purpose |
|---|---|---|
| `GET /rtc` | RTCService.v0() | WebSocket signaling (v0) |
| `GET /rtc/v1` | RTCService.v1() | WebSocket signaling (v1, protobuf join_request) |
| `GET /rtc/validate` | RTCService.v0Validate() | Token validation |
| `POST /twirp/livekit.RoomService/*` | RoomService | Twirp room management APIs |
| `POST /twirp/livekit.AgentDispatchService/*` | AgentService | Agent dispatch |
| `POST /twirp/livekit.Egress/*` | EgressService | Egress control |
| `POST /twirp/livekit.Ingress/*` | IngressService | Ingress control |
| `POST /twirp/livekit.SIP/*` | SIPService | SIP management |
| `GET /agent` | AgentService | Agent worker WebSocket |
| `/whip/*` | WHIPService | WHIP ingress |
| `GET /` | health check | Returns OK if node stats are fresh |

---

## 4. Complete Data Flow: User Device → Server → Other Devices

### Phase 1: Connection (User Device → Server)

```
User Device
  │
  │ HTTP GET /rtc?access_token=<JWT>
  ▼
APIKeyAuthMiddleware
  ├── Extract token from Authorization header or ?access_token= query param
  ├── auth.ParseAPIToken() → extract API key from JWT header
  ├── provider.GetSecret(apiKey) → look up HMAC secret
  └── v.Verify(secret) → verify JWT, extract ClaimGrants
  │
  ▼
RTCService.serve()
  ├── websocket.IsWebSocketUpgrade() check
  ├── validateInternal() → parse params → ParticipantInit
  │    └── EnsureJoinPermission(), ValidateCreateRoom(), LimitsReached()
  │
  ├── [retry loop] startConnection()
  │    ├── roomAllocator.SelectRoomNode()
  │    │    ├── router.GetNodeForRoom() → check existing assignment
  │    │    ├── router.ListNodes() + selector.SelectNode()
  │    │    └── router.SetNodeForRoom() → persist mapping
  │    │
  │    ├── router.StartParticipantSignal()
  │    │    ├── connectionID = guid.New("CO_")
  │    │    ├── Open psrpc bidirectional stream to RTC node
  │    │    ├── Send StartSession as first frame
  │    │    └── Return (RequestSink, ResponseSource)
  │    │
  │    └── readInitialResponse() ← BLOCKS until JoinResponse
  │         (timeout: 3s × attempt#)
  │
  ├── upgrader.Upgrade() → HTTP 101 WebSocket handshake
  ├── NewWSSignalConnection() → proto/JSON codec wrapper
  ├── WriteResponse(JoinResponse) → first WS frame
  │
  ├── goroutine: ResponseSource → sigConn.WriteResponse()
  └── main loop: sigConn.ReadRequest() → RequestSink
```

**Key design**: WebSocket is NOT upgraded until the RTC node confirms the session is ready. No zombie connections.

### Phase 2: Room & Participant Creation (on RTC node)

```
SignalServer.RelaySignal() ← receives psrpc stream
  │
  ▼
RoomManager.StartSession()
  ├── getOrCreateRoom()
  │    ├── Check in-memory r.rooms map
  │    ├── If new: roomAllocator.CreateRoom() → store
  │    └── rtc.NewRoom() → starts 4 goroutines:
  │         ├── audioUpdateWorker (active speaker detection)
  │         ├── connectionQualityWorker
  │         ├── changeUpdateWorker (batched participant updates)
  │         └── simulationCleanupWorker
  │
  ├── rtc.NewParticipant(ParticipantParams{Sink: responseSink})
  │    ├── setupSignalling()
  │    │    ├── Signalling → proto serializer
  │    │    ├── SignalHandler → incoming message dispatcher
  │    │    └── SignallerAsync → outgoing WebSocket writer
  │    ├── setupTransportManager()
  │    │    └── NewTransportManager()
  │    │         ├── Publisher PCTransport (client→server, server=answerer)
  │    │         └── Subscriber PCTransport (server→client, server=offerer)
  │    ├── setupUpTrackManager() → published track registry
  │    └── setupSubscriptionManager() → subscription lifecycle
  │
  ├── room.Join(participant)
  │    ├── participants[identity] = participant
  │    ├── createJoinResponseLocked()
  │    │    → {Room, Participant, OtherParticipants, IceServers,
  │    │       SubscriberPrimary, PingInterval, ServerInfo, EnabledCodecs}
  │    ├── participant.SendJoinResponse() → state: JOINING → JOINED
  │    │    └── writes to responseSink → psrpc → RTCService → WebSocket → CLIENT
  │    └── participant.Negotiate(true) [if SubscriberAsPrimary]
  │         └── subscriber.createAndSendOffer() → SDP offer → client
  │
  └── go rtcSessionWorker() [goroutine per participant]
       └── loop: requestSource.ReadChan() → participant.HandleSignalMessage()
```

### Phase 3: SDP Negotiation (Bidirectional)

```
═══ Subscriber PC (server is offerer) ═══
Server: pc.CreateOffer() → SetLocalDescription() → send SDP offer to client
Client: receives offer → creates answer → sends SignalRequest_Answer
Server: HandleAnswer() → subscriber.SetRemoteDescription() → ICE/DTLS begins

═══ Publisher PC (client is offerer) ═══
Client: creates offer (with tracks) → sends SignalRequest_Offer
Server: HandleOffer() → publisher.SetRemoteDescription() → pc.CreateAnswer()
→ send SDP answer → ICE/DTLS begins

═══ ICE Trickle (both directions, both PCs) ═══
Server candidate → OnICECandidate → SignalResponse_Trickle → client
Client candidate → SignalRequest_Trickle → AddICECandidate(publisher|subscriber)

ICE timeouts: 10s disconnect, 5s failed, 2s keepalive
DTLS: X25519/P384/P256, 100ms retransmit
ICE Lite: enabled for most clients, disabled for Firefox
```

### Phase 4: Media Publish (Device → Server)

```
Publisher Device
  │ (microphone/camera → WebRTC encoder → RTP)
  │ ICE/DTLS/SRTP
  ▼
pion PeerConnection.OnTrack()
  │
  ▼
MediaTrack.AddReceiver(receiver, track, mid)
  ├── buffer.Factory.GetBufferPair(ssrc) → Buffer + RTCPReader
  ├── sfu.NewWebRTCReceiver(receiver, track, ...)
  ├── WebRTCReceiver.AddUpTrack(track, buff)
  │    ├── Assign spatial layer from RID (low=0, mid=1, high=2)
  │    ├── buff.OnRtcpFeedback(sendRTCP) → wire PLI/NACK feedback
  │    └── StartBuffer() → launches forwardRTP() goroutine ← THE PUMP
  └── buff.Bind(params, codec, bitrate) → activate buffer
```

**Per-packet flow inside server:**

```
Buffer.Write(rawPkt)
  ├── RTP unmarshal
  ├── TWCC: push transport-wide SN (for sender-side BWE)
  ├── BufferBase.HandleIncomingPacketLocked()
  │    ├── bucket.Store(extSN, rawPkt)     ← ring buffer for NACK retransmit
  │    ├── rtpStats.Update()               ← jitter, loss, RTT tracking
  │    ├── DependencyDescriptorParser()    ← SVC spatial/temporal layer metadata
  │    ├── audioLevel.Observe()            ← VAD for active speaker detection
  │    └── extPackets.PushBack(ExtPacket)  ← enqueue decoded packet
  └── readCond.Signal()                    ← wake forwardRTP()

forwardRTP() goroutine:
  extPkt = buff.ReadExtended()             ← dequeue (blocks when empty)
  │
  └── downTrackSpreader.Broadcast() ──────── fan out to ALL subscribers
       │                                     (parallelized if ≥20 subscribers)
       ▼
       dt.WriteRTP(extPkt, spatialLayer)   ← called per DownTrack
```

### Phase 5: Media Subscribe (Server → Device)

```
SubscriptionManager.reconcileWorker() [every 3s or on-demand]
  └── subscribe(trackID)
       └── track.AddSubscriber(participant)
            ├── NewSubscribedTrack() → creates DownTrack
            ├── sub.AddTrackLocal(downTrack) → adds to subscriber PC
            │    └── triggers SDP renegotiation (new offer to client)
            └── receiver.AddDownTrack(downTrack) → now in broadcast list
```

**Per-packet forwarding (DownTrack.WriteRTP):**

```
DownTrack.WriteRTP(extPkt, layer)
  │
  ├── Forwarder.GetTranslationParams(extPkt, layer)
  │    ├── VideoLayerSelector.Select()
  │    │    └── Check: is this from target spatial layer?
  │    │         If switching: wait for keyframe
  │    │         If muted/paused: shouldDrop=true → return 0
  │    ├── RTPMunger.UpdateAndGetSnTs()
  │    │    └── Rewrite SN: continuous [0,1,2,3...] despite layer switches
  │    │    └── Rewrite TS: smooth timestamps using RTCP SR bridging
  │    └── CodecMunger.UpdateAndGet()
  │         └── VP8: rewrite TID/KeyIdx in codec header
  │
  ├── Build new RTP header:
  │    SSRC = subscriber's SSRC (NOT publisher's)
  │    SN   = munged sequence number
  │    TS   = munged timestamp
  │    PT   = translated payload type
  │    + DependencyDescriptor, PlayoutDelay, AbsCaptureTime extensions
  │
  ├── sequencer.push() → record SN mapping for NACK retransmission
  │
  └── pacer.Enqueue(pacerPacket)
       │
       ▼ (rate-controlled by LeakyBucket pacer)
       writeStream.WriteRTP(hdr, payload)
       │
       ▼ pion SRTP → DTLS → ICE → UDP
       │
       ▼
    Subscriber Device
```

### Phase 6: Congestion Control & Layer Switching

```
StreamAllocator (per subscriber PC)
  │
  ├── Inputs:
  │    ├── REMB (receiver-side BWE from subscriber)
  │    ├── TWCC feedback → send-side BWE
  │    └── Track bitrate reports
  │
  ├── States:
  │    ├── STABLE → all tracks get max requested layer
  │    └── DEFICIENT → iterative allocation:
  │         1. Sort by priority (screenshare=255 > video=1)
  │         2. Allocate layers within bandwidth budget
  │         3. Pause lowest-priority tracks if needed
  │         4. Probe with padding packets to discover more bandwidth
  │
  └── Output: DownTrack.Allocate(targetLayer)
       → Forwarder.SetTargetLayers()
       → On next keyframe from target layer → switch
```

### Phase 7: Data Channels

```
Three named channels per PeerConnection:

"_lossy"       (unreliable, max-retransmits=0)  → low-latency user data
"_reliable"    (reliable, ordered)               → guaranteed delivery
"_data_track"  (unreliable)                      → multiplexed data tracks

Publisher sends on DC → rawDC.ReadDataChannel()
  → Handler.OnDataMessage()
  → Room.OnParticipantDataPacket()
  → Fan out to all subscribers' DC writers
  → Subscriber Device receives
```

---

## 5. Key Interfaces

### Participant
```go
type LocalParticipant interface {
    Participant
    HandleOffer(sd *livekit.SessionDescription) error
    HandleAnswer(sd *livekit.SessionDescription)
    HandleICETrickle(trickleRequest *livekit.TrickleRequest)
    AddTrack(req *livekit.AddTrackRequest)
    SubscribeToTrack(trackID livekit.TrackID, isSync bool)
    SendJoinResponse(joinResponse *livekit.JoinResponse) error
    SendParticipantUpdate(participants []*livekit.ParticipantInfo) error
    MoveToRoom(params MoveToRoomParams)
    // ... 100+ methods
}
```

### Room
```go
type Room interface {
    Name() livekit.RoomName
    ID() livekit.RoomID
    RemoveParticipant(identity, pID, reason)
    UpdateSubscriptions(participant, trackIDs, ...)
    ResolveMediaTrackForSubscriber(sub, trackID) MediaResolverResult
    GetLocalParticipants() []LocalParticipant
}
```

### Track
```go
type MediaTrack interface {
    ID() livekit.TrackID
    Kind() livekit.TrackType
    Source() livekit.TrackSource
    PublisherID() livekit.ParticipantID
    IsMuted() bool
    AddSubscriber(participant LocalParticipant) (SubscribedTrack, error)
    RemoveSubscriber(participantID, isExpectedToResume)
    Receivers() []sfu.TrackReceiver
}
```

### SFU Core
```go
type TrackSender interface {
    WriteRTP(p *buffer.ExtPacket, layer int32) int32
    UpTrackLayersChange()
    HandleRTCPSenderReportData(...)
    Resync()
    SetReceiver(TrackReceiver)
}

type TrackReceiver interface {
    TrackID() livekit.TrackID
    Codec() webrtc.RTPCodecParameters
    AddDownTrack(track TrackSender) error
    DeleteDownTrack(participantID livekit.ParticipantID)
    ReadRTP(buf []byte, layer uint8, sn uint16) (int, error)
}
```

---

## 6. WebSocket Signaling Protocol

Uses protobuf (binary WS frames) or JSON (text WS frames). Auto-detects based on first client message.

### Client → Server (`SignalRequest`)
| Message | Purpose |
|---|---|
| `Offer` | SDP offer from publisher PC |
| `Answer` | SDP answer to subscriber offer |
| `Trickle` | ICE candidate trickle |
| `AddTrack` | Announce track before publishing |
| `UpdateSubscription` | Subscribe/unsubscribe tracks |
| `UpdateTrackSettings` | Video quality, enabled state |
| `Leave` | Graceful disconnect |
| `Ping` / `PingReq` | Keepalive |
| `SyncState` | Reconnect state sync |
| `UpdateMetadata` | Participant metadata |

### Server → Client (`SignalResponse`)
| Message | Purpose |
|---|---|
| `Join` | Join response with room/participant state |
| `Answer` | SDP answer to publisher offer |
| `Offer` | SDP offer for subscriber PC |
| `Trickle` | ICE candidate from server |
| `Update` | Participant updates in room |
| `SpeakerUpdate` | Active speaker changes |
| `RoomUpdate` | Room metadata changes |
| `ConnectionQuality` | Connection quality info |
| `Pong` / `PongResp` | Ping response |
| `RefreshToken` | New JWT (token rotation) |
| `RoomMoved` | Participant moved to another room |
| `ReconnectResponse` | Reconnect state |

Ping interval: 10s, timeout: 2s.

---

## 7. Agent Framework

AI agent workers connect via WebSocket to `/agent`:

```
Agent SDK → GET /agent?access_token=<JWT with Agent claim>
  → AgentService.ServeHTTP()
  → HandshakeAgentWorker(): Register → RegisterResponse
  → Worker added to AgentHandler
  → Room event → agentClient dispatches job
  → Worker.AssignJob(): AvailabilityRequest → AvailabilityResponse
  → Agent responds Available + participantIdentity
  → Server builds agent JWT, sends JobAssignment
  → Agent joins room as normal participant
```

Job types: `JT_ROOM` (one per room), `JT_PUBLISHER` (one per publisher), `JT_PARTICIPANT` (one per participant).

---

## 8. Configuration

Default ports: **7880** (HTTP/WS), **7881** (RTC/TCP), **50000-60000** (UDP ICE range).

Key config sections:
- `keys` — API key:secret pairs
- `rtc` — UDP/TCP ports, ICE, STUN/TURN, congestion control, batch I/O
- `redis` — for distributed multi-node mode
- `room` — auto_create, timeouts, max participants, enabled codecs
- `turn` — embedded TURN server
- `audio` — active level, percentile, update interval, RED encoding
- `limit` — max tracks (400×CPUs, max 8000), bandwidth (1 GB/s), subscription limits
- `node_selector` — `any`, `cpuload`, `sysload`, `regionaware`

Dev mode: `livekit-server --dev` → uses `devkey`/`secret`, binds localhost, enables pprof.

---

## 9. Distributed Architecture (Multi-Node)

```
Signal Node (receives WS) ──psrpc──► RTC Node (hosts room)
                                        │
                              Redis (room→node mapping,
                                     node keepalive,
                                     pub/sub for psrpc)
```

- `LocalRouter` — single-node, in-process
- `RedisRouter` — multi-node, Redis hashes: `nodes` (nodeID→Node), `room_node_map` (room→nodeID)
- PSRPC (`github.com/livekit/psrpc`) — pub/sub RPC over Redis or NATS
- Node selection strategies: `any`, `cpuload`, `sysload`, `regionaware`

---

## 10. Build System

- **Mage** (Go-based Make alternative)
- **Google Wire** for dependency injection in `pkg/service/wire_gen.go`
- **GoReleaser** for releases (linux/amd64, linux/arm64, linux/arm, windows)
- **Docker**: `golang:1.25-alpine` builder → `alpine` runtime, `CGO_ENABLED=0`

Key commands:
```bash
./bootstrap.sh          # install mage + go mod download
mage build              # build bin/livekit-server
mage test               # unit tests (short)
mage testAll            # all tests including integration
mage generate           # go generate (wire, counterfeiter)
```

---

## 11. Key File Paths

| File | Purpose |
|---|---|
| `cmd/server/main.go` | Entry point, CLI, startServer() |
| `pkg/service/server.go` | LivekitServer, HTTP routes, Start/Stop |
| `pkg/service/rtcservice.go` | WebSocket /rtc endpoint, connection flow |
| `pkg/service/roommanager.go` | Room/participant lifecycle, StartSession() |
| `pkg/service/signal.go` | PSRPC signal relay server |
| `pkg/service/wsprotocol.go` | WebSocket proto/JSON codec |
| `pkg/service/auth.go` | JWT auth middleware |
| `pkg/service/agentservice.go` | Agent worker WebSocket handler |
| `pkg/rtc/room.go` | Room struct, Join(), participant management |
| `pkg/rtc/participant.go` | ParticipantImpl, signal handling, transport setup |
| `pkg/rtc/transport.go` | PCTransport, PeerConnection wrapper, data channels |
| `pkg/rtc/transportmanager.go` | Publisher + subscriber PC management |
| `pkg/rtc/mediatrack.go` | Published track, AddReceiver() |
| `pkg/rtc/uptrackmanager.go` | Published track registry |
| `pkg/rtc/subscriptionmanager.go` | Subscription lifecycle, reconciliation |
| `pkg/rtc/types/interfaces.go` | Core interfaces (Participant, Room, MediaTrack) |
| `pkg/sfu/receiver.go` | WebRTCReceiver, RTP reception |
| `pkg/sfu/receiver_base.go` | ReceiverBase, forwardRTP() pump loop |
| `pkg/sfu/downtrack.go` | DownTrack, WriteRTP(), Bind() |
| `pkg/sfu/forwarder.go` | Layer selection, SN/TS munging |
| `pkg/sfu/buffer/buffer.go` | RTP buffer, NACK, TWCC |
| `pkg/sfu/streamallocator/streamallocator.go` | BWE-driven stream allocation |
| `pkg/routing/localrouter.go` | Single-node router |
| `pkg/routing/redisrouter.go` | Multi-node Redis router |
| `pkg/routing/signal.go` | Signal relay client |
| `pkg/config/config.go` | Configuration structs |
| `config-sample.yaml` | Sample YAML config |

---

## 12. Dependencies (Key)

| Package | Role |
|---|---|
| `pion/webrtc/v4` v4.2.7 | Full WebRTC implementation |
| `pion/ice/v4` v4.2.0 | ICE connectivity |
| `pion/turn/v4` v4.1.4 | Embedded TURN server |
| `livekit/protocol` v1.44.1 | Shared protobuf types, auth, logger |
| `livekit/psrpc` v0.7.1 | Internal pub/sub RPC (Redis/NATS) |
| `redis/go-redis/v9` v9.17.3 | Redis client |
| `gorilla/websocket` v1.5.3 | WebSocket server |
| `twitchtv/twirp` v8.1.3 | Twirp RPC framework |
| `google/wire` | Compile-time dependency injection |
| `urfave/cli/v3` | CLI framework |
| `go.uber.org/zap` | Structured logging |
| `prometheus/client_golang` | Prometheus metrics |

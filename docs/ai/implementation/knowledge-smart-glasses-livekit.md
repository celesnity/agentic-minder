# Smart Glasses as LiveKit Clients — Research & Trade-Off Analysis

> Date: 2026-03-04
> Context: Can smart glasses (Spectacles, Meta Ray-Ban, XREAL) replace laptops/phones as LiveKit WebRTC clients?
> Short answer: Conceptually yes (device is just I/O), practically no (WebRTC stack requirements are the blocker).
> **CORRECTION (same date)**: Spectacles DO have raw audio APIs (`MicrophoneAudioProvider`, `AudioOutputProvider`) and binary WebSocket support. Workaround architectures are viable. See `knowledge-spectacles-workarounds.md` for full analysis.

---

## 1. LiveKit Client Requirements (Non-Negotiable)

Every LiveKit participant MUST support the full WebRTC stack. There is no WebSocket-only media path in the server.

### Absolute Minimum Requirements

| Requirement | Details |
|---|---|
| **WebSocket** | HTTP/1.1 upgrade (RFC 6455) for signaling on `/rtc` |
| **JWT Bearer token** | In `Authorization` header or `access_token` query param |
| **Protobuf** | Encode/decode `SignalRequest` / `SignalResponse` messages |
| **ICE** | RFC 8445 — UDP default, TCP fallback optional |
| **DTLS** | 1.2 or 1.3 with X25519/P384/P256 curve support |
| **SRTP** | RFC 3711 — server disables replay protection |
| **SCTP over DTLS** | For data channels (`_lossy` and `_reliable`) |
| **At least one codec** | Opus (audio) or VP8/H.264 (video) minimum |
| **Ping/keepalive** | Every 5 seconds, timeout 15 seconds |

### Participation Modes

- **Audio-only**: Supported. Client offers only audio codecs in SDP.
- **Video-only**: Supported. Data channels still required (SCTP).
- **Data-only**: Possible but still requires full WebRTC handshake (ICE + DTLS + SCTP).
- **Subscribe-only**: Supported. No requirement to publish.
- **Non-WebRTC**: **NOT POSSIBLE.** No code path exists for WebSocket-only media participation.

### Server-Side Client Adaptation

The server adapts behavior per client (`pkg/clientconfiguration/conf.go`):

| Client | Adaptation |
|---|---|
| Safari | AV1 disabled; VP9 publish disabled > v18.3 |
| Firefox | Audio RED disabled; ICE-Lite disabled; SRTP replay protection disabled |
| Firefox on Linux/Android | H.264 publish disabled |
| Go SDK | No ICE/TCP active; codec change NOT supported |
| Unknown SDK | Conservative behavior, SCTP zero checksum disabled |

---

## 2. Smart Glasses Platform Capabilities

### Capability Comparison Matrix

| Capability | Laptop/Phone | Snap Spectacles | Meta Ray-Ban | XREAL Air 2 Ultra |
|---|---|---|---|---|
| **WebRTC PeerConnection** | Native | **NO** | Via phone companion | Via host phone/laptop |
| **WebSocket** | Native | Yes | Via phone | Via host |
| **Raw audio stream (PCM/Opus)** | Full access | **NO** (ASR text only) | Via phone SDK | Full (Android APIs) |
| **Raw video stream** | Full access | **NO** (JPEG snapshots) | 720p/30fps via BT | Full (host device) |
| **Standalone compute** | Yes | Yes (limited, 45 min) | **No** (phone required) | **No** (host required) |
| **WiFi direct** | Yes | Yes | Gen 1/2: No; Display: Yes | Via host |
| **Battery (streaming)** | Hours | **~20-30 min** | ~1-2 hr (camera active) | Host-dependent |
| **UDP sockets** | Yes | **No** | Via phone | Via host |
| **Can be LiveKit client?** | Yes, directly | **No, needs proxy** | Yes, phone is the client | Yes, host is the client |

---

## 3. Platform Deep Dives

### 3.1 Snap Spectacles (5th Gen Developer Edition, 2024)

**Hardware:**
- Dual Snapdragon XR2-class SoC (standalone, no phone tether)
- 226g, 46° FOV stereo waveguide, LCoS projectors
- 6-mic array with beamforming, echo cancellation, bystander rejection
- 2x color + 2x IR cameras
- ~45 min battery (20-30 min under streaming load)
- WiFi standalone, USB-C power passthrough

**Networking APIs (Lens Studio TypeScript):**
- `InternetModule.createWebSocket(url)` — WebSocket only
- `InternetModule.performHttpRequest()` / `fetch()` — HTTP/HTTPS
- **No WebRTC PeerConnection API**
- **No raw UDP socket API**
- **No `RTCPeerConnection`, `MediaStream`, `getUserMedia`, `DataChannel`**

**Audio/Video I/O:**
- **Microphone → ASR text only**: `AsrModule` provides text transcriptions, NOT raw PCM/Opus bytes
- **Camera → JPEG snapshots only**: `VideoController` captures periodic base64 JPEG frames, NOT a continuous video track
- **Audio output → TTS only**: `TextToSpeechModule` synthesizes text → `AudioTrackAsset` → speaker playback. No raw PCM output access.

**The Privacy Wall:**
- Camera + mic + internet simultaneously requires "Extended Permissions / Experimental APIs"
- With Experimental APIs: lens cannot be published publicly, shows watermark
- With "Permission Alerts": can publish but requires per-launch consent + blinking privacy LED
- Allowlisted `createAPIWebSocket()` bypasses restrictions (Snap's own integrations only)

**LiveKit Verdict: CANNOT be a direct LiveKit client.**
Three blockers: no WebRTC API, no raw audio stream, no live video stream.

### 3.2 Meta Ray-Ban Smart Glasses

**Hardware (Ray-Ban Meta Display, Sept 2025):**
- Snapdragon AR1 Gen 1, 2GB RAM, 32GB storage
- 600×600 monocular display, 20° FOV, 5000 nits
- 12 MP ultra-wide camera, 5-mic array with beamforming
- Wi-Fi 6, Bluetooth 5.3
- ~6 hours mixed use, 69g
- $799 + Meta Neural Band (sEMG wristband)

**Architecture: Apps run on companion phone, NOT on glasses.**
- Glasses are sensors + output (camera, mic, speakers, display)
- Phone processes everything via Bluetooth
- Meta Wearables Device Access Toolkit (developer preview, Sept 2025)

**Networking:**
- WebRTC supported on companion phone (standard iOS/Android)
- Bluetooth bottleneck: **720p/30fps max video, ~2.5 Mbps**
- Dynamic resolution/framerate downgrade under BT bandwidth pressure
- +20-50ms latency from BT transport

**Key Limitations:**
- No display output from third-party apps (SDK v1)
- No neural wristband access (SDK v1)
- Developer preview only — public publishing planned 2026
- All compute on phone

**LiveKit Verdict: Works, but the phone is the LiveKit client.** Glasses are Bluetooth peripherals.

### 3.3 XREAL Air 2 Ultra / XREAL One

**Hardware:**
- Display-only glasses — no standalone compute, no WiFi
- USB-C tethered to host Android phone/laptop
- Micro-OLED: 1080p per eye, 52° FOV (Ultra) / 50° (One), 120 Hz
- 6DoF tracking (Air 2 Ultra), 3DoF (One with X1 chip)

**Architecture: Host device does everything.**
- Standard Android phone runs the app
- Full Android API access: WebRTC, networking, codecs, audio/video
- Glasses render AR overlay + provide head tracking
- No proprietary networking restrictions

**XREAL Project Aura (upcoming 2026):**
- First XREAL with Android XR OS
- Tethered compute puck (Snapdragon XR2+ Gen 2)
- 70° FOV, Google Play Store apps, Gemini native
- Full WebRTC capability expected

**LiveKit Verdict: Fully supported — host device is a standard Android client.** Most capable but least "glass-like" (phone + cable + glasses).

---

## 4. The Core Question Answered

### "Is the device just an I/O endpoint?"

**Conceptually: YES.** At the application layer, all devices do the same thing — capture audio/video, send to server, receive and render output.

**Practically: NO.** LiveKit requires a full WebRTC stack (ICE + DTLS + SRTP + SCTP + codec pipelines), which most smart glasses cannot provide natively. The device is NOT "just I/O" — it must also be a WebRTC endpoint.

| Level | Is device just I/O? | Why |
|---|---|---|
| Application logic | Yes | Capture input, display output — same everywhere |
| Transport protocol | **No** | WebRTC requires full ICE/DTLS/SRTP stack |
| Media pipeline | **No** | Need raw codec encode/decode (Opus, VP8, H.264) |
| Compute budget | **No** | WebRTC is CPU-intensive (encryption, NACK, BWE) |
| Battery budget | **No** | Real-time streaming drains glasses in 20-45 min |

---

## 5. What Changes: Laptop/Phone vs Smart Glasses

| Dimension | Laptop/Phone | Smart Glasses |
|---|---|---|
| **Media fidelity** | Full HD+ video, hi-fi audio | Degraded (720p BT, JPEG snapshots, or text-only) |
| **Latency** | Direct WebRTC (~50-150ms) | +20-50ms BT (Meta), or +200ms+ text proxy (Spectacles) |
| **Session duration** | Hours | 20-45 min (Spectacles), 1-2 hr (Meta) |
| **Hands-free** | No | **Yes — killer advantage** |
| **Context awareness** | Static camera angle | **First-person POV — killer advantage** |
| **Privacy** | Camera is obvious | Camera is subtle (ethical/legal concerns) |
| **Compute budget** | Generous | Severely limited |
| **Codec flexibility** | All codecs | Limited or proxied |
| **Multi-party rooms** | Standard | Requires proxy architecture (Spectacles) |

### The Two Killer Advantages of Smart Glasses

1. **Hands-free, always-on**: LiveKit session while doing surgery, repairs, cooking, fieldwork
2. **First-person perspective**: Camera sees what you see — transformative for AI agents that need spatial context

These are the reasons to accept all the trade-offs.

---

## 6. Viable Architecture Patterns

### Pattern A: Text + Snapshot Proxy (Current AgenticMinder Approach)

```
Spectacles ──WS──► OpenClaw/Proxy ──► AI Backend
  (ASR text + JPEG)     (no LiveKit needed)
```

- **Best for**: Snap Spectacles
- **Latency**: ~500ms-2s round trip
- **Fidelity**: Text + periodic images (not real-time audio/video)
- **Advantage**: Works today with Spectacles' limited APIs
- **Limitation**: No real-time audio/video, no multi-party rooms
- **Use case**: Voice assistant + visual Q&A

### Pattern B: Phone as LiveKit Client, Glasses as Peripheral

```
Glasses ──BT/USB──► Phone App ──WebRTC──► LiveKit Server
  (cam+mic)           (LiveKit SDK)          (SFU)
```

- **Best for**: Meta Ray-Ban, XREAL
- **Latency**: ~70-200ms (WebRTC + BT overhead)
- **Fidelity**: 720p/30fps (Meta BT cap), full HD (XREAL wired)
- **Advantage**: Real WebRTC, multi-party rooms, standard LiveKit features
- **Limitation**: Phone dependency, BT bandwidth cap (Meta), USB cable (XREAL)
- **Use case**: Real-time collaboration, telehealth, remote assistance

### Pattern C: Server-Side Agent Bridge

```
Glasses ──WS──► Bridge Server ──LiveKit Agent──► LiveKit Room
  (text+JPEG)      converts to         (joins as AI participant)
                   audio/video
```

- **Best for**: Enabling Spectacles users in multi-party LiveKit sessions
- **Latency**: ~500ms-2s (text/image conversion adds latency)
- **Fidelity**: Synthetic (TTS audio for glass user's text, JPEG snapshots as video)
- **Advantage**: Glass users can participate in LiveKit rooms with phone/laptop users
- **Limitation**: Most complex architecture, non-real-time feel, high server cost
- **Use case**: Mixed-device collaboration rooms
- **How it works**:
  1. Bridge server connects to glasses via WebSocket
  2. Bridge server joins LiveKit room as an Agent participant (full WebRTC)
  3. Glass user's ASR text → TTS → Opus audio → published to LiveKit room
  4. Glass user's JPEG snapshots → video frames → published to LiveKit room
  5. Other participants' audio → STT → text → WebSocket → glasses display
  6. Other participants' video → snapshot extraction → WebSocket → glasses

---

## 7. Decision Framework

```
Q: Does the target glass platform have WebRTC PeerConnection API?
│
├── YES (XREAL via host, Meta via phone)
│   └── Use Pattern B: Phone/host as LiveKit client
│       └── Q: Is BT bandwidth sufficient?
│           ├── YES (XREAL wired) → Full HD, standard LiveKit
│           └── NO (Meta BT) → 720p cap, accept quality trade-off
│
└── NO (Snap Spectacles)
    └── Q: Do you need multi-party LiveKit rooms?
        ├── YES → Use Pattern C: Server-side agent bridge
        └── NO → Use Pattern A: Text + snapshot proxy (current approach)
```

---

## 8. Summary Table

| Platform | Can Join LiveKit Room? | How? | Max Video | Max Audio | Battery | Hands-Free |
|---|---|---|---|---|---|---|
| Laptop/Phone | Yes, directly | Native WebRTC | 1080p+ | Full Opus | Hours | No |
| Snap Spectacles | No (proxy only) | Pattern A or C | JPEG snapshots | Text (ASR) | 20-30 min | Yes |
| Meta Ray-Ban | Yes, via phone | Pattern B | 720p/30fps | Full (phone) | 1-2 hr | Yes |
| XREAL Air 2 Ultra | Yes, via host | Pattern B | 1080p+ | Full (phone) | Host-dependent | Yes (with cable) |
| XREAL Project Aura (2026) | Yes, native expected | Pattern B (puck) | TBD | TBD | TBD | Yes |

---

## 9. References

### LiveKit Server (In-Repo)
- `livekit/pkg/service/rtcservice.go` — WebSocket handshake, client requirements
- `livekit/pkg/rtc/transport.go` — PeerConnection, ICE/DTLS/SRTP config
- `livekit/pkg/rtc/clientinfo.go` — Per-SDK capability flags
- `livekit/pkg/clientconfiguration/conf.go` — Per-browser/OS codec restrictions
- `livekit/pkg/config/config.go` — Default enabled codecs
- Full architecture doc: `docs/ai/implementation/knowledge-livekit.md`

### Snap Spectacles
- [Spectacles Developer Docs](https://developers.snap.com/spectacles/home)
- [WebSocket API](https://developers.snap.com/spectacles/about-spectacles-features/apis/web-socket)
- [Internet Access API](https://developers.snap.com/spectacles/about-spectacles-features/apis/internet-access)
- [Experimental APIs](https://developers.snap.com/spectacles/permission-privacy/experimental-apis)
- [Audio in Spectacles](https://developers.snap.com/spectacles/about-spectacles-features/audio)

### Meta Ray-Ban
- [Wearables Device Access Toolkit](https://developers.meta.com/blog/introducing-meta-wearables-device-access-toolkit/)
- [Wearables Developer FAQ](https://developers.meta.com/wearables/faq/)
- [Ray-Ban Meta Display Launch](https://www.meta.com/blog/meta-ray-ban-display-ai-glasses-connect-2025/)
- [VisionClaw (WebRTC on Ray-Ban)](https://github.com/sseanliu/VisionClaw)

### XREAL
- [XREAL Developer Docs](https://developer.xreal.com/)
- [XREAL SDK Getting Started](https://docs.xreal.com/Getting%20Started%20with%20XREAL%20SDK)
- [Project Aura (Android XR)](https://www.xreal.com/us/blog/aura-25-tas-release-en)

### Project Context
- Current Spectacles integration: `Assets/AgenticPlayground/Scripts/Bridge/OpenClawBridge.ts`
- Current architecture: `CLAUDE.md` (Jarvis Voice Bridge)
- OpenClaw protocol knowledge: `docs/ai/implementation/knowledge-openclaw.md`

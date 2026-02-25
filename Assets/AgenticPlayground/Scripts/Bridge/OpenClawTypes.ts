/**
 * OpenClaw Gateway Protocol v3 - Type Definitions
 *
 * Client-side TypeScript interfaces for the OpenClaw gateway protocol.
 * Aligned with OpenClaw's TypeBox schemas in:
 *   - openclaw/src/gateway/protocol/schema/frames.ts (ConnectParams, HelloOk)
 *   - openclaw/src/gateway/protocol/schema/logs-chat.ts (ChatSendParams)
 *   - openclaw/src/gateway/protocol/client-info.ts (ClientModes, ClientIds)
 *   - openclaw/src/infra/device-pairing.ts (DeviceAuthToken)
 */

// ================================
// Protocol Frame Types
// ================================

interface RequestFrame {
  type: "req"
  id: string
  method: string
  params: Record<string, unknown>
}

interface ResponseFrame {
  type: "res"
  id: string
  ok: boolean
  payload?: unknown
  error?: { code: number; message: string }
}

interface EventFrame {
  type: "event"
  event: string
  payload: unknown
}

interface TickFrame {
  type: "tick"
}

interface ShutdownFrame {
  type: "shutdown"
  payload?: { restartInMs?: number }
}

type IncomingFrame = ResponseFrame | EventFrame | TickFrame | ShutdownFrame

// ================================
// Connection Handshake Types
// ================================

/**
 * ConnectParams sent to OpenClaw gateway on WebSocket open.
 * Matches ConnectParamsSchema in openclaw/src/gateway/protocol/schema/frames.ts
 */
interface OpenClawConnectParams {
  minProtocol: number
  maxProtocol: number
  client: {
    id: string
    displayName?: string
    version: string
    platform: string
    deviceFamily?: string
    modelIdentifier?: string
    mode: OpenClawClientMode
    instanceId?: string
  }
  device?: {
    id: string
    publicKey: string
    signature: string
    signedAt: number
    nonce?: string
  }
  auth?: {
    token?: string
    password?: string
  }
  role?: string
  scopes?: string[]
  caps?: string[]
  locale?: string
  userAgent?: string
}

/**
 * HelloOk response from OpenClaw gateway after successful Connect.
 * Matches HelloOkSchema in openclaw/src/gateway/protocol/schema/frames.ts
 */
interface OpenClawHelloOk {
  protocol: number
  type?: string
  server?: {
    version?: string
    host?: string
    connId: string
  }
  features: {
    methods: string[]
    events: string[]
  }
  auth?: {
    deviceToken: string
    role: string
    scopes: string[]
    issuedAtMs?: number
  }
  policy?: {
    tickIntervalMs?: number
  }
  snapshot?: unknown
}

// ================================
// Client Identity Types
// ================================

/**
 * Valid client modes from OpenClaw's GATEWAY_CLIENT_MODES.
 * Smart glasses use 'node' mode until a dedicated mode is added.
 */
type OpenClawClientMode = "webchat" | "cli" | "ui" | "backend" | "node" | "probe" | "test"

// ================================
// Connection State Types
// ================================

type OpenClawConnectionStatus =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting"

interface OpenClawConnectionState {
  status: OpenClawConnectionStatus
  serverUrl: string
  deviceToken: string | null
  sessionKey: string | null
  connId: string | null
  protocolVersion: number
  lastHeartbeat: number
  reconnectAttempts: number
  availableMethods: string[]
  availableEvents: string[]
}

// ================================
// Chat / Query Types
// ================================

/**
 * Attachment for chat.send requests (camera frames, files, etc.)
 * Matches the attachments array in ChatSendParamsSchema.
 */
interface OpenClawAttachment {
  type?: string
  mimeType?: string
  fileName?: string
  content?: unknown
}

/**
 * Parameters for the chat.send RPC method.
 * Matches ChatSendParamsSchema in openclaw/src/gateway/protocol/schema/logs-chat.ts
 */
interface OpenClawChatSendParams {
  sessionKey: string
  message: string
  thinking?: string
  deliver?: boolean
  attachments?: OpenClawAttachment[]
  timeoutMs?: number
  idempotencyKey: string
}

/**
 * High-level query from the glass app, mapped to OpenClawChatSendParams before sending.
 */
interface GlassQuery {
  text: string
  imageData?: string
  sessionKey?: string
  displayMode: "chat" | "summary" | "diagram"
  maxResponseLength: number
}

// ================================
// Streaming Response Types
// ================================

interface OpenClawStreamingToken {
  text: string
  done: boolean
}

interface OpenClawStreamingDelta {
  delta: string
  accumulated: string
  done: boolean
}

// ================================
// Device Pairing Types
// ================================

/**
 * Event payload for device.pair.requested broadcast.
 */
interface DevicePairRequestedEvent {
  requestId: string
  deviceId: string
  displayName?: string
  platform: string
  clientId: string
  clientMode: string
}

/**
 * Event payload for device.pair.resolved broadcast.
 */
interface DevicePairResolvedEvent {
  requestId: string
  deviceId: string
  decision: "approved" | "rejected"
  ts: number
}

// ================================
// Configuration Types
// ================================

interface OpenClawBridgeConfig {
  serverUrl: string
  authToken: string
  connectTimeout: number
  requestTimeout: number
  heartbeatInterval: number
  maxReconnectAttempts: number
  maxReconnectDelay: number
  maxConcurrentRequests: number
  enableCamera: boolean
  enableVoice: boolean
  enableStreaming: boolean
}

// ================================
// Error Types
// ================================

interface OpenClawError {
  code: number
  message: string
}

// ================================
// Pending Request Tracking
// ================================

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: OpenClawError) => void
  timeoutId: any
  sentAt: number
}

// ================================
// Export Types
// ================================

export type {
  RequestFrame,
  ResponseFrame,
  EventFrame,
  TickFrame,
  ShutdownFrame,
  IncomingFrame,
  OpenClawConnectParams,
  OpenClawHelloOk,
  OpenClawClientMode,
  OpenClawConnectionStatus,
  OpenClawConnectionState,
  OpenClawAttachment,
  OpenClawChatSendParams,
  GlassQuery,
  OpenClawStreamingToken,
  OpenClawStreamingDelta,
  DevicePairRequestedEvent,
  DevicePairResolvedEvent,
  OpenClawBridgeConfig,
  OpenClawError,
  PendingRequest
}

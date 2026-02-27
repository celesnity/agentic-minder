import Event from "SpectaclesInteractionKit.lspkg/Utils/Event"
import { clearTimeout, setTimeout } from "SpectaclesInteractionKit.lspkg/Utils/FunctionTimingUtils"
import { OpenClawProtocol } from "./OpenClawProtocol"
import { OpenClawAuth } from "./OpenClawAuth"
import {
  OpenClawConnectionState,
  OpenClawConnectionStatus,
  OpenClawHelloOk,
  OpenClawChatSendParams,
  OpenClawAttachment,
  GlassQuery,
  OpenClawStreamingToken,
  OpenClawStreamingDelta,
  OpenClawError,
  EventFrame,
  ResponseFrame,
  DevicePairResolvedEvent,
  OpenClawBridgeConfig
} from "./OpenClawTypes"

/**
 * OpenClawBridge - Main bridge between AgenticMinder and OpenClaw gateway
 *
 * Manages the WebSocket connection to an OpenClaw server, handling:
 * - Connection lifecycle (connect, disconnect, reconnect)
 * - Protocol v3 handshake (Connect → HelloOk)
 * - RPC calls (chat.send, chat.abort, sessions.list, etc.)
 * - Event handling (agent streaming, device pairing, heartbeat)
 * - Auto-reconnection with exponential backoff
 *
 * Transport:
 * - Dev mode: InternetModule.createWebSocket() with Extended Permissions
 * - Prod mode: createAPIWebSocket with Snap-allowlisted spec ID (future)
 */
export class OpenClawBridge {
  // ================================
  // Singleton
  // ================================

  private static _instance: OpenClawBridge
  public static getInstance(): OpenClawBridge {
    if (!OpenClawBridge._instance) {
      OpenClawBridge._instance = new OpenClawBridge()
    }
    return OpenClawBridge._instance
  }

  // ================================
  // Dependencies
  // ================================

  private protocol: OpenClawProtocol
  private auth: OpenClawAuth
  private socket: WebSocket | null = null
  private internetModule: InternetModule | null = null

  // ================================
  // State
  // ================================

  private connectionState: OpenClawConnectionState = {
    status: "disconnected",
    serverUrl: "",
    deviceToken: null,
    sessionKey: null,
    connId: null,
    protocolVersion: 3,
    lastHeartbeat: 0,
    reconnectAttempts: 0,
    availableMethods: [],
    availableEvents: []
  }

  // ================================
  // Configuration
  // ================================

  private config: OpenClawBridgeConfig = {
    serverUrl: "ws://172.16.0.93:18789",
    authToken: "",
    connectTimeout: 5000,
    requestTimeout: 60000,
    heartbeatInterval: 30000,
    maxReconnectAttempts: 10,
    maxReconnectDelay: 30000,
    maxConcurrentRequests: 3,
    enableCamera: true,
    enableVoice: true,
    enableStreaming: true
  }

  // ================================
  // Timers
  // ================================

  private connectTimeoutId: any = null
  private connectFallbackTimerId: any = null
  private heartbeatCheckId: any = null
  private reconnectTimeoutId: any = null
  private missedHeartbeats: number = 0
  private intentionalDisconnect: boolean = false

  // ================================
  // Connect Handshake State
  // ================================

  private connectNonce: string | null = null
  private connectSent: boolean = false

  // ================================
  // Streaming State
  // ================================

  private streamingText: string = ""
  private isStreaming: boolean = false
  private streamResolve: ((text: string) => void) | null = null
  private currentRunId: string | null = null

  // ================================
  // Query Queue (enforce max concurrent)
  // ================================

  private queryIdCounter: number = 0

  // ================================
  // Events
  // ================================

  public readonly onConnectionStateChanged = new Event<OpenClawConnectionState>()
  public readonly onStreamingResponse = new Event<OpenClawStreamingToken>()
  public readonly onStreamingDelta = new Event<OpenClawStreamingDelta>()
  public readonly onAgentEvent = new Event<EventFrame>()
  public readonly onError = new Event<OpenClawError>()

  // ================================
  // Constructor
  // ================================

  private constructor() {
    this.protocol = new OpenClawProtocol(this.config.requestTimeout)
    this.auth = new OpenClawAuth()
    print("[OpenClaw] Bridge initialized")
  }

  // ================================
  // Public API - Lifecycle
  // ================================

  /**
   * Set the RemoteServiceModule reference (used as fallback for WebSocket creation).
   */
  public setRemoteServiceModule(rsm: RemoteServiceModule): void {
    // Try to get InternetModule first (Lens Studio 5.9+), fall back to RSM
    try {
      this.internetModule = require("LensStudio:InternetModule") as InternetModule
      print("[OpenClaw] Using InternetModule for WebSocket")
    } catch (_e) {
      print("[OpenClaw] InternetModule not available, falling back to RemoteServiceModule")
      this.internetModule = null
    }
  }

  /**
   * Update bridge configuration.
   */
  public configure(config: Partial<OpenClawBridgeConfig>): void {
    this.config = { ...this.config, ...config }
    this.protocol = new OpenClawProtocol(this.config.requestTimeout)
    if (this.config.authToken) {
      this.auth.setGatewayAuthToken(this.config.authToken)
    }
    print("[OpenClaw] Configuration updated: " + this.config.serverUrl)
  }

  /**
   * Connect to an OpenClaw server.
   */
  public async connect(serverUrl?: string): Promise<void> {
    if (serverUrl) {
      this.config.serverUrl = serverUrl
    }

    if (this.connectionState.status === "connected" || this.connectionState.status === "connecting") {
      print("[OpenClaw] Already connected or connecting")
      return
    }

    this.intentionalDisconnect = false
    this.setStatus("connecting")
    this.connectionState.serverUrl = this.config.serverUrl

    try {
      this.createWebSocket()
    } catch (e) {
      print("[OpenClaw] Failed to create WebSocket: " + e)
      this.setStatus("disconnected")
      this.scheduleReconnect()
    }
  }

  /**
   * Disconnect from the OpenClaw server.
   */
  public async disconnect(): Promise<void> {
    this.intentionalDisconnect = true
    this.clearTimers()
    this.protocol.rejectAllPending("Disconnecting")

    if (this.socket) {
      try {
        this.socket.close()
      } catch (e) {
        print("[OpenClaw] Error closing socket: " + e)
      }
      this.socket = null
    }

    this.setStatus("disconnected")
    print("[OpenClaw] Disconnected")
  }

  /**
   * Check if connected and ready to send queries.
   */
  public isConnected(): boolean {
    return this.connectionState.status === "connected"
  }

  /**
   * Get current connection state.
   */
  public getConnectionState(): OpenClawConnectionState {
    return { ...this.connectionState }
  }

  /**
   * Get the auth manager for external access.
   */
  public getAuth(): OpenClawAuth {
    return this.auth
  }

  /**
   * Get the current run ID for the in-progress query.
   */
  public getCurrentRunId(): string | null {
    return this.currentRunId
  }

  // ================================
  // Public API - Queries
  // ================================

  /**
   * Send a query to OpenClaw via chat.send.
   * Returns the full response text.
   */
  public async sendQuery(query: GlassQuery): Promise<string> {
    if (!this.isConnected()) {
      throw { code: -2, message: "Not connected to OpenClaw" } as OpenClawError
    }

    if (this.protocol.getPendingRequestCount() >= this.config.maxConcurrentRequests) {
      throw { code: 429, message: "Too many concurrent requests" } as OpenClawError
    }

    // Resolve session key
    const sessionKey = query.sessionKey || this.connectionState.sessionKey
    print("[OpenClaw] sendQuery: sessionKey=" + sessionKey + ", text=" + (query.text || "").substring(0, 60))
    if (!sessionKey) {
      throw { code: -1, message: "No active session" } as OpenClawError
    }

    // Build attachments for camera frames
    const attachments: OpenClawAttachment[] = []
    if (query.imageData) {
      attachments.push({
        type: "image",
        mimeType: "image/jpeg",
        content: query.imageData
      })
    }

    // Build chat.send params
    this.queryIdCounter += 1
    const params: OpenClawChatSendParams = {
      sessionKey,
      message: query.text,
      idempotencyKey: "glass-" + Date.now() + "-" + this.queryIdCounter
    }
    if (attachments.length > 0) {
      params.attachments = attachments
    }

    // Reset streaming state
    this.streamingText = ""
    this.isStreaming = true
    this.streamResolve = null
    this.currentRunId = null

    // Create a promise that resolves when chat/agent events deliver the final response
    const streamPromise = new Promise<string>((resolve) => {
      this.streamResolve = resolve

      // Timeout: if no response arrives within requestTimeout, resolve with whatever we have
      setTimeout(() => {
        if (this.streamResolve === resolve) {
          this.streamResolve = null
          this.isStreaming = false
          this.currentRunId = null
          resolve(this.streamingText || "(No response received)")
        }
      }, this.config.requestTimeout)
    })

    // Send chat.send request (returns {status: "started", runId: "..."} immediately)
    const { id, data } = this.protocol.serializeRequest("chat.send", params as unknown as Record<string, unknown>)
    const ackPromise = this.protocol.trackRequest(id)

    try {
      print("[OpenClaw] chat.send frame (" + data.length + " chars): " + data.substring(0, 300))
      this.socket!.send(data)
      print("[OpenClaw] chat.send dispatched, waiting for response events...")

      // Process the ack to extract runId
      ackPromise.then((ack: unknown) => {
        const a = ack as any
        if (a?.runId) {
          this.currentRunId = a.runId
          print("[OpenClaw] runId: " + a.runId)
        }
      }).catch(() => {
        // Ack failure doesn't block streaming — events may still arrive
      })

      // Wait for the streaming response to complete
      const text = await streamPromise
      this.currentRunId = null
      return text
    } catch (e) {
      this.isStreaming = false
      this.streamResolve = null
      this.currentRunId = null
      const error = e as OpenClawError
      this.onError.invoke(error)
      throw error
    }
  }

  /**
   * Abort the current in-progress query.
   * Resolves the stream promise with partial text accumulated so far.
   */
  public async abortQuery(): Promise<void> {
    if (!this.isConnected() || !this.connectionState.sessionKey) return

    const params: Record<string, unknown> = {
      sessionKey: this.connectionState.sessionKey
    }
    if (this.currentRunId) {
      params.runId = this.currentRunId
    }

    const { id, data } = this.protocol.serializeRequest("chat.abort", params)

    try {
      this.socket!.send(data)
      print("[OpenClaw] Abort sent" + (this.currentRunId ? " (runId=" + this.currentRunId + ")" : ""))
    } catch (e) {
      print("[OpenClaw] Failed to send abort: " + e)
    }

    // Immediately resolve streaming with partial text
    const partialText = this.streamingText || ""
    if (this.streamResolve) {
      this.streamResolve(partialText)
      this.streamResolve = null
    }
    this.isStreaming = false
    this.currentRunId = null

    // Emit final delta so UI can finalize
    this.onStreamingDelta.invoke({
      delta: "",
      accumulated: partialText,
      done: true
    })
  }

  // ================================
  // Public API - Sessions
  // ================================

  public async listSessions(): Promise<unknown> {
    return this.sendRPC("sessions.list", {})
  }

  /**
   * Auto-fetch session key after connecting.
   * Tries sessions.list first, falls back to "default".
   */
  private fetchSessionKey(): void {
    this.listSessions().then((result: unknown) => {
      const r = result as any
      const sessions = r?.sessions || []
      if (sessions.length > 0) {
        const key = sessions[0].key || sessions[0].sessionKey
        this.connectionState.sessionKey = key
        this.auth.saveSessionKey(key)
        print("[OpenClaw] Session key: " + key)
      } else {
        this.connectionState.sessionKey = "default"
        print("[OpenClaw] No sessions found, using 'default'")
      }
    }).catch((e: unknown) => {
      print("[OpenClaw] sessions.list failed: " + e + ", using 'default'")
      this.connectionState.sessionKey = "default"
    })
  }

  public async getSessionHistory(limit?: number): Promise<unknown> {
    if (!this.connectionState.sessionKey) return null
    return this.sendRPC("chat.history", {
      sessionKey: this.connectionState.sessionKey,
      limit: limit || 20
    })
  }

  // ================================
  // WebSocket Creation
  // ================================

  private createWebSocket(): void {
    if (!this.internetModule) {
      // Try to acquire InternetModule if not already set
      try {
        this.internetModule = require("LensStudio:InternetModule") as InternetModule
      } catch (_e) {
        throw new Error("InternetModule not available. Call setRemoteServiceModule() first.")
      }
    }

    print("[OpenClaw] Connecting to " + this.config.serverUrl)
    this.socket = this.internetModule.createWebSocket(this.config.serverUrl)

    this.socket.onopen = (_event: WebSocketEvent) => {
      this.onSocketOpen()
    }

    this.socket.onmessage = async (event: WebSocketMessageEvent) => {
      if (typeof event.data === "string") {
        this.onSocketMessage(event.data)
      } else if (event.data instanceof Blob) {
        const text = await event.data.text()
        this.onSocketMessage(text)
      }
    }

    this.socket.onclose = (event: WebSocketCloseEvent) => {
      this.onSocketClose(event.code, event.wasClean)
    }

    this.socket.onerror = (_event: WebSocketEvent) => {
      this.onSocketError()
    }

    // Connection timeout
    this.connectTimeoutId = setTimeout(() => {
      if (this.connectionState.status === "connecting" || this.connectionState.status === "authenticating") {
        print("[OpenClaw] Connection timeout")
        this.socket?.close()
        this.socket = null
        this.setStatus("disconnected")
        this.scheduleReconnect()
      }
    }, this.config.connectTimeout)
  }

  // ================================
  // WebSocket Event Handlers
  // ================================

  private onSocketOpen(): void {
    print("[OpenClaw] WebSocket opened — waiting for challenge")
    this.clearTimer("connectTimeoutId")
    this.setStatus("authenticating")
    this.queueConnect()
  }

  /**
   * Wait for connect.challenge from the server, then send ConnectParams.
   * The challenge typically arrives within ~50ms of WebSocket open.
   * Fallback: if no challenge in 300ms, send anyway (token-only auth).
   */
  private queueConnect(): void {
    this.connectNonce = null
    this.connectSent = false
    // Wait for challenge event (handleConnectChallenge will call sendConnectHandshake)
    // Fallback: send after 300ms if no challenge arrives
    this.connectFallbackTimerId = setTimeout(() => {
      if (!this.connectSent) {
        print("[OpenClaw] No challenge in 300ms — sending ConnectParams without nonce")
        this.sendConnectHandshake()
      }
    }, 300)
  }

  /**
   * Send ConnectParams as a proper request frame (method: "connect").
   * If a connect.challenge nonce was received, it's included.
   */
  private sendConnectHandshake(): void {
    if (this.connectSent) return
    this.connectSent = true
    this.clearTimer("connectFallbackTimerId")

    print("[OpenClaw] Building ConnectParams...")
    const connectParams = this.auth.buildConnectParams(this.connectNonce || undefined)
    const { id, data } = this.protocol.serializeRequest(
      "connect",
      connectParams as unknown as Record<string, unknown>
    )
    print("[OpenClaw] Connect frame ready (" + data.length + " chars), sending...")
    const responsePromise = this.protocol.trackRequest(id)

    try {
      this.socket!.send(data)
      print("[OpenClaw] ConnectParams sent OK (nonce=" + (this.connectNonce ? "yes" : "none") + ", frame=" + data.substring(0, 120) + "...)")
    } catch (e) {
      print("[OpenClaw] Failed to send ConnectParams: " + e)
      this.disconnect()
      return
    }

    // Process the HelloOk response
    responsePromise.then((result: unknown) => {
      this.processHelloOk(result)
    }).catch((e: unknown) => {
      print("[OpenClaw] Connect handshake failed: " + e)
      this.onError.invoke({ code: -5, message: "Handshake failed: " + e })
      this.socket?.close()
    })
  }

  private onSocketMessage(data: string): void {
    // Validate frame size
    if (!this.protocol.validateFrameSize(data)) return

    // Parse as standard frame — all messages use the same frame format
    const frame = this.protocol.deserializeFrame(data)
    if (!frame) return

    switch (frame.type) {
      case "res":
        this.protocol.resolveResponse(frame as ResponseFrame)
        break
      case "event":
        this.handleEvent(frame as EventFrame)
        break
      case "tick":
        this.handleTick()
        break
      case "shutdown":
        this.handleShutdown(frame.payload)
        break
    }
  }

  private onSocketClose(code: number, wasClean: boolean): void {
    print("[OpenClaw] WebSocket closed: code=" + code + " clean=" + wasClean)
    this.clearTimers()
    this.protocol.rejectAllPending("Connection closed")
    this.socket = null

    if (!this.intentionalDisconnect) {
      this.setStatus("reconnecting")
      this.scheduleReconnect()
    } else {
      this.setStatus("disconnected")
    }
  }

  private onSocketError(): void {
    print("[OpenClaw] WebSocket error")
    this.onError.invoke({ code: -3, message: "WebSocket connection error" })
  }

  // ================================
  // Handshake Handling
  // ================================

  /**
   * Process the HelloOk payload from the connect response frame.
   * Called when the "connect" request resolves successfully.
   */
  private processHelloOk(payload: unknown): void {
    if (!payload || typeof payload !== "object") {
      print("[OpenClaw] Invalid HelloOk payload")
      this.disconnect()
      return
    }

    const helloOk = payload as OpenClawHelloOk

    if (!helloOk.protocol || !helloOk.features) {
      print("[OpenClaw] HelloOk missing: protocol=" + helloOk.protocol + " features=" + !!helloOk.features)
      this.disconnect()
      return
    }

    print("[OpenClaw] HelloOk received: v" + helloOk.protocol +
      " methods=" + helloOk.features.methods.length +
      " events=" + helloOk.features.events.length)

    // Store connection info
    this.connectionState.protocolVersion = helloOk.protocol
    this.connectionState.availableMethods = helloOk.features.methods
    this.connectionState.availableEvents = helloOk.features.events
    if (helloOk.server?.connId) {
      this.connectionState.connId = helloOk.server.connId
    }

    // Process auth (save token if provided)
    this.auth.processHelloOk(helloOk)
    if (helloOk.auth?.deviceToken) {
      this.connectionState.deviceToken = helloOk.auth.deviceToken
    }

    // Use tick interval from server policy if provided
    if (helloOk.policy?.tickIntervalMs) {
      this.config.heartbeatInterval = helloOk.policy.tickIntervalMs
    }

    // Restore or init session key
    const savedSessionKey = this.auth.getSessionKey()
    if (savedSessionKey) {
      this.connectionState.sessionKey = savedSessionKey
    }

    // Mark connected
    this.connectionState.reconnectAttempts = 0
    this.setStatus("connected")
    this.startHeartbeatMonitor()

    print("[OpenClaw] Connected successfully")

    // Auto-fetch sessions to get a valid session key
    if (!this.connectionState.sessionKey) {
      this.fetchSessionKey()
    }
  }

  // ================================
  // Event Handling
  // ================================

  private handleEvent(frame: EventFrame): void {
    switch (frame.event) {
      case "connect.challenge":
        this.handleConnectChallenge(frame.payload)
        break
      case "agent":
        this.handleAgentEvent(frame.payload)
        break
      case "chat":
        this.handleChatEvent(frame.payload)
        break
      case "tick":
        this.handleTick()
        break
      case "device.pair.requested":
        this.auth.onPairingRequired.invoke({ message: "Device pairing requested — approve on OpenClaw" })
        break
      case "device.pair.resolved":
        this.auth.handlePairResolved(frame.payload as DevicePairResolvedEvent)
        break
      default:
        this.onAgentEvent.invoke(frame)
        break
    }
  }

  /**
   * Handle the connect.challenge event from the server.
   * Stores the nonce and immediately triggers the connect handshake.
   */
  private handleConnectChallenge(payload: unknown): void {
    if (!payload || typeof payload !== "object") return
    const p = payload as Record<string, unknown>
    if (typeof p.nonce === "string") {
      this.connectNonce = p.nonce
      print("[OpenClaw] Challenge received, nonce=" + p.nonce.substring(0, 8) + "...")
      this.sendConnectHandshake()
    }
  }

  private handleAgentEvent(payload: unknown): void {
    if (!payload || typeof payload !== "object") return

    const p = payload as any
    const delta = p.text || p.content || ""
    const done = !!p.done

    if (delta && this.isStreaming) {
      this.streamingText += delta
    }

    this.onStreamingResponse.invoke({ text: delta, done })
    this.onStreamingDelta.invoke({
      delta,
      accumulated: this.streamingText,
      done
    })

    if (done && this.streamResolve) {
      this.isStreaming = false
      this.streamResolve(this.streamingText)
      this.streamResolve = null
    }
  }

  /**
   * Handle "chat" broadcast events from the server.
   * The final response arrives as {state: "final", message: {content: [{type: "text", text: "..."}]}}
   */
  private handleChatEvent(payload: unknown): void {
    if (!payload || typeof payload !== "object") return
    const p = payload as any

    if (p.state === "final" && p.message) {
      let text = ""
      const content = p.message.content
      if (Array.isArray(content)) {
        text = content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text || "")
          .join("\n")
      } else if (typeof content === "string") {
        text = content
      }

      if (text && this.isStreaming) {
        this.streamingText += text
      }

      this.onStreamingResponse.invoke({ text, done: true })
      this.onStreamingDelta.invoke({
        delta: text,
        accumulated: this.streamingText,
        done: true
      })

      // Resolve the stream promise with final text
      if (this.streamResolve) {
        this.isStreaming = false
        this.streamResolve(this.streamingText)
        this.streamResolve = null
      }
    } else if (p.state === "aborted") {
      print("[OpenClaw] Chat aborted")
      const partialText = this.streamingText || ""

      this.onStreamingResponse.invoke({ text: partialText, done: true })
      this.onStreamingDelta.invoke({
        delta: "",
        accumulated: partialText,
        done: true
      })

      if (this.streamResolve) {
        this.isStreaming = false
        this.streamResolve(partialText)
        this.streamResolve = null
      }
    } else if (p.state === "error") {
      print("[OpenClaw] Chat error: " + (p.errorMessage || "unknown"))
      this.onError.invoke({ code: 500, message: p.errorMessage || "Agent error" })

      this.onStreamingDelta.invoke({
        delta: "",
        accumulated: this.streamingText || "",
        done: true
      })

      // Resolve stream promise with error
      if (this.streamResolve) {
        this.isStreaming = false
        this.streamResolve(this.streamingText || "Error: " + (p.errorMessage || "unknown"))
        this.streamResolve = null
      }
    }
  }

  private handleTick(): void {
    this.connectionState.lastHeartbeat = Date.now()
    this.missedHeartbeats = 0
  }

  private handleShutdown(payload: any): void {
    print("[OpenClaw] Server shutting down")
    const restartInMs = payload?.restartInMs || 5000
    this.protocol.rejectAllPending("Server shutdown")

    // Schedule reconnect after restart window
    this.reconnectTimeoutId = setTimeout(() => {
      this.connect()
    }, restartInMs)
  }

  // ================================
  // Heartbeat Monitor
  // ================================

  private startHeartbeatMonitor(): void {
    this.connectionState.lastHeartbeat = Date.now()
    this.missedHeartbeats = 0

    this.heartbeatCheckId = setTimeout(() => {
      this.checkHeartbeat()
    }, this.config.heartbeatInterval + 5000) // 5s grace period
  }

  private checkHeartbeat(): void {
    if (this.connectionState.status !== "connected") return

    const elapsed = Date.now() - this.connectionState.lastHeartbeat
    if (elapsed > this.config.heartbeatInterval + 5000) {
      this.missedHeartbeats += 1
      print("[OpenClaw] Missed heartbeat #" + this.missedHeartbeats)

      if (this.missedHeartbeats >= 3) {
        print("[OpenClaw] 3 missed heartbeats — reconnecting")
        this.socket?.close()
        return
      }
    } else {
      this.missedHeartbeats = 0
    }

    // Schedule next check
    this.heartbeatCheckId = setTimeout(() => {
      this.checkHeartbeat()
    }, this.config.heartbeatInterval)
  }

  // ================================
  // Auto-Reconnection
  // ================================

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) return

    this.connectionState.reconnectAttempts += 1
    if (this.connectionState.reconnectAttempts > this.config.maxReconnectAttempts) {
      print("[OpenClaw] Max reconnect attempts reached — giving up")
      this.setStatus("disconnected")
      this.onError.invoke({ code: -4, message: "Failed to reconnect after " + this.config.maxReconnectAttempts + " attempts" })
      return
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ...
    const baseDelay = Math.min(
      Math.pow(2, this.connectionState.reconnectAttempts - 1) * 1000,
      this.config.maxReconnectDelay
    )
    // Add jitter (0-500ms) to avoid thundering herd
    const delay = baseDelay + Math.random() * 500

    print("[OpenClaw] Reconnecting in " + Math.round(delay) + "ms (attempt " + this.connectionState.reconnectAttempts + ")")

    this.reconnectTimeoutId = setTimeout(() => {
      this.protocol.reset()
      this.connect()
    }, delay)
  }

  // ================================
  // Generic RPC Helper
  // ================================

  private async sendRPC(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.isConnected()) {
      throw { code: -2, message: "Not connected to OpenClaw" } as OpenClawError
    }

    const { id, data } = this.protocol.serializeRequest(method, params)
    const responsePromise = this.protocol.trackRequest(id)

    try {
      this.socket!.send(data)
      return await responsePromise
    } catch (e) {
      const error = e as OpenClawError
      this.onError.invoke(error)
      throw error
    }
  }

  // ================================
  // State Management
  // ================================

  private setStatus(status: OpenClawConnectionStatus): void {
    this.connectionState.status = status
    this.onConnectionStateChanged.invoke({ ...this.connectionState })
  }

  // ================================
  // Timer Cleanup
  // ================================

  private clearTimer(name: string): void {
    const id = (this as any)[name]
    if (id !== null && id !== undefined) {
      clearTimeout(id);
      (this as any)[name] = null
    }
  }

  private clearTimers(): void {
    this.clearTimer("connectTimeoutId")
    this.clearTimer("connectFallbackTimerId")
    this.clearTimer("heartbeatCheckId")
    this.clearTimer("reconnectTimeoutId")
  }
}

import {clearTimeout, setTimeout} from "SpectaclesInteractionKit.lspkg/Utils/FunctionTimingUtils"
import {
  RequestFrame,
  ResponseFrame,
  EventFrame,
  IncomingFrame,
  OpenClawError,
  PendingRequest
} from "./OpenClawTypes"

/**
 * OpenClawProtocol - Frame serialization, deserialization, and request-response correlation
 *
 * Handles the OpenClaw Gateway Protocol v3 wire format:
 * - Serializes outgoing RequestFrames to JSON
 * - Deserializes incoming frames (res, event, tick, shutdown)
 * - Tracks pending requests with timeout-based correlation
 * - Generates unique message IDs
 */
export class OpenClawProtocol {
  private messageCounter: number = 0
  private pendingRequests: Map<string, PendingRequest> = new Map()
  private requestTimeout: number

  constructor(requestTimeout: number = 15000) {
    this.requestTimeout = requestTimeout
    print("[OpenClaw] Protocol handler initialized")
  }

  // ================================
  // Message ID Generation
  // ================================

  public generateMessageId(): string {
    this.messageCounter += 1
    return String(this.messageCounter)
  }

  // ================================
  // Frame Serialization (Outgoing)
  // ================================

  public serializeRequest(method: string, params: Record<string, unknown>): { id: string; data: string } {
    const id = this.generateMessageId()
    const frame: RequestFrame = { type: "req", id, method, params }
    return { id, data: JSON.stringify(frame) }
  }

  // Note: Connect is sent as a normal request frame via serializeRequest("connect", params)

  // ================================
  // Frame Deserialization (Incoming)
  // ================================

  public deserializeFrame(data: string): IncomingFrame | null {
    let parsed: any
    try {
      parsed = JSON.parse(data)
    } catch (e) {
      print("[OpenClaw] Failed to parse incoming frame: " + e)
      return null
    }

    if (!parsed || typeof parsed !== "object" || !parsed.type) {
      print("[OpenClaw] Invalid frame: missing 'type' field")
      return null
    }

    switch (parsed.type) {
      case "res":
        return this.parseResponseFrame(parsed)
      case "event":
        return this.parseEventFrame(parsed)
      case "tick":
        return { type: "tick" }
      case "shutdown":
        return { type: "shutdown", payload: parsed.payload }
      default:
        print("[OpenClaw] Unknown frame type: " + parsed.type)
        return null
    }
  }

  private parseResponseFrame(parsed: any): ResponseFrame | null {
    if (typeof parsed.id !== "string") {
      print("[OpenClaw] Response frame missing 'id'")
      return null
    }
    return {
      type: "res",
      id: parsed.id,
      ok: !!parsed.ok,
      payload: parsed.payload,
      error: parsed.error
    }
  }

  private parseEventFrame(parsed: any): EventFrame | null {
    if (typeof parsed.event !== "string") {
      print("[OpenClaw] Event frame missing 'event' name")
      return null
    }
    return {
      type: "event",
      event: parsed.event,
      payload: parsed.payload
    }
  }

  // ================================
  // Request-Response Correlation
  // ================================

  /**
   * Register a pending request and return a promise that resolves when the response arrives.
   * Automatically rejects after the configured timeout.
   */
  public trackRequest(id: string): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject({ code: -1, message: "Request timed out after " + this.requestTimeout + "ms" } as OpenClawError)
      }, this.requestTimeout)

      this.pendingRequests.set(id, {
        resolve,
        reject,
        timeoutId,
        sentAt: Date.now()
      })
    })
  }

  /**
   * Resolve or reject a pending request based on the response frame.
   * Returns true if a matching request was found.
   */
  public resolveResponse(frame: ResponseFrame): boolean {
    const pending = this.pendingRequests.get(frame.id)
    if (!pending) {
      print("[OpenClaw] No pending request for response id=" + frame.id)
      return false
    }

    clearTimeout(pending.timeoutId)
    this.pendingRequests.delete(frame.id)

    if (frame.ok) {
      pending.resolve(frame.payload)
    } else {
      const error: OpenClawError = frame.error || { code: -1, message: "Unknown server error" }
      pending.reject(error)
    }

    return true
  }

  // ================================
  // State Management
  // ================================

  public getPendingRequestCount(): number {
    return this.pendingRequests.size
  }

  /**
   * Reject all pending requests (used on disconnect).
   */
  public rejectAllPending(reason: string): void {
    const error: OpenClawError = { code: -2, message: reason }
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId)
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }

  /**
   * Reset protocol state (message counter, pending requests).
   */
  public reset(): void {
    this.rejectAllPending("Protocol reset")
    this.messageCounter = 0
    print("[OpenClaw] Protocol state reset")
  }

  // ================================
  // Frame Validation
  // ================================

  /**
   * Validate a ResponseFrame has all required fields.
   */
  public validateResponseFrame(frame: any): frame is ResponseFrame {
    if (!frame || typeof frame !== "object") return false
    if (frame.type !== "res") return false
    if (typeof frame.id !== "string" || frame.id.length === 0) return false
    if (typeof frame.ok !== "boolean") return false
    if (!frame.ok && frame.error) {
      if (typeof frame.error.code !== "number") return false
      if (typeof frame.error.message !== "string") return false
    }
    return true
  }

  /**
   * Validate an EventFrame has all required fields.
   */
  public validateEventFrame(frame: any): frame is EventFrame {
    if (!frame || typeof frame !== "object") return false
    if (frame.type !== "event") return false
    if (typeof frame.event !== "string" || frame.event.length === 0) return false
    return true
  }

  /**
   * Validate incoming data is within acceptable size (1MB max).
   */
  public validateFrameSize(data: string): boolean {
    const MAX_FRAME_SIZE = 1024 * 1024 // 1MB
    if (data.length > MAX_FRAME_SIZE) {
      print("[OpenClaw] Frame exceeds max size: " + data.length + " bytes")
      return false
    }
    return true
  }

  // ================================
  // Error Code Mapping
  // ================================

  /**
   * Map OpenClaw error codes to user-friendly messages.
   */
  public static getErrorMessage(error: OpenClawError): string {
    switch (error.code) {
      case -1:
        return "Request timed out. Please try again."
      case -2:
        return "Connection lost. Reconnecting..."
      case 401:
        return "Authentication failed. Please re-pair your device."
      case 403:
        return "Access denied. Insufficient permissions."
      case 404:
        return "Requested resource not found."
      case 429:
        return "Too many requests. Please wait a moment."
      case 500:
        return "Server error. Please try again later."
      case 503:
        return "Server is temporarily unavailable."
      default:
        return error.message || "An unexpected error occurred."
    }
  }
}

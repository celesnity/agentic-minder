import Event from "SpectaclesInteractionKit.lspkg/Utils/Event"
import {
  OpenClawConnectParams,
  OpenClawHelloOk,
  DevicePairResolvedEvent
} from "./OpenClawTypes"

/**
 * OpenClawAuth - Device authentication and token management
 *
 * Manages:
 * - Device token storage/retrieval from PersistentStorage
 * - Building ConnectParams for the handshake
 * - Handling pairing approval/rejection events
 * - Device identity (stable device ID + instance ID)
 */
export class OpenClawAuth {
  // Storage keys
  private static readonly TOKEN_KEY = "openclaw_device_token"
  private static readonly DEVICE_ID_KEY = "openclaw_device_id"
  private static readonly SESSION_KEY = "openclaw_session_key"
  private static readonly ROLE_KEY = "openclaw_device_role"

  // Protocol version
  private static readonly MIN_PROTOCOL = 3
  private static readonly MAX_PROTOCOL = 3

  // Client identity
  // Must match GATEWAY_CLIENT_IDS in OpenClaw
  private static readonly CLIENT_ID = "gateway-client"
  private static readonly CLIENT_VERSION = "1.0.0"
  private static readonly CLIENT_PLATFORM = "spectacles"
  private static readonly CLIENT_MODE = "node" as const

  // Events
  public readonly onPairingRequired = new Event<{ message: string }>()
  public readonly onPairingResolved = new Event<DevicePairResolvedEvent>()

  // ================================
  // Token Management
  // ================================

  public getDeviceToken(): string | null {
    try {
      const token = global.persistentStorageSystem.store.getString(OpenClawAuth.TOKEN_KEY)
      return token && token.length > 0 ? token : null
    } catch (e) {
      print("[OpenClaw] Failed to read device token: " + e)
      return null
    }
  }

  public saveDeviceToken(token: string, role?: string): void {
    try {
      global.persistentStorageSystem.store.putString(OpenClawAuth.TOKEN_KEY, token)
      if (role) {
        global.persistentStorageSystem.store.putString(OpenClawAuth.ROLE_KEY, role)
      }
      print("[OpenClaw] Device token saved")
    } catch (e) {
      print("[OpenClaw] Failed to save device token: " + e)
    }
  }

  public clearDeviceToken(): void {
    try {
      global.persistentStorageSystem.store.putString(OpenClawAuth.TOKEN_KEY, "")
      global.persistentStorageSystem.store.putString(OpenClawAuth.ROLE_KEY, "")
      print("[OpenClaw] Device token cleared")
    } catch (e) {
      print("[OpenClaw] Failed to clear device token: " + e)
    }
  }

  // ================================
  // Session Key Management
  // ================================

  public getSessionKey(): string | null {
    try {
      const key = global.persistentStorageSystem.store.getString(OpenClawAuth.SESSION_KEY)
      return key && key.length > 0 ? key : null
    } catch (e) {
      return null
    }
  }

  public saveSessionKey(sessionKey: string): void {
    try {
      global.persistentStorageSystem.store.putString(OpenClawAuth.SESSION_KEY, sessionKey)
    } catch (e) {
      print("[OpenClaw] Failed to save session key: " + e)
    }
  }

  // ================================
  // Device Identity
  // ================================

  public getDeviceId(): string {
    try {
      let deviceId = global.persistentStorageSystem.store.getString(OpenClawAuth.DEVICE_ID_KEY)
      if (!deviceId || deviceId.length === 0) {
        deviceId = this.generateDeviceId()
        global.persistentStorageSystem.store.putString(OpenClawAuth.DEVICE_ID_KEY, deviceId)
        print("[OpenClaw] Generated new device ID: " + deviceId)
      }
      return deviceId
    } catch (e) {
      return this.generateDeviceId()
    }
  }

  private generateDeviceId(): string {
    // Generate a simple unique ID from timestamp + random
    const ts = Date.now().toString(36)
    const rand = Math.random().toString(36).substring(2, 8)
    return "spectacles-" + ts + "-" + rand
  }

  // ================================
  // ConnectParams Builder
  // ================================

  /**
   * Build ConnectParams for the OpenClaw handshake.
   * If a device token exists, includes it in auth.
   * Device crypto (publicKey/signature) is omitted for dev mode
   * since local connections are auto-approved by OpenClaw.
   */
  /**
   * Set the gateway auth token (shared secret from openclaw.json gateway.auth.token).
   * This allows password-free, device-free auth for dev mode.
   */
  public setGatewayAuthToken(token: string): void {
    this.gatewayAuthToken = token
  }

  private gatewayAuthToken: string | null = null

  public buildConnectParams(nonce?: string): OpenClawConnectParams {
    const deviceToken = this.getDeviceToken()

    const params: OpenClawConnectParams = {
      minProtocol: OpenClawAuth.MIN_PROTOCOL,
      maxProtocol: OpenClawAuth.MAX_PROTOCOL,
      client: {
        id: OpenClawAuth.CLIENT_ID,
        displayName: "Spectacles Smart Glasses",
        version: OpenClawAuth.CLIENT_VERSION,
        platform: OpenClawAuth.CLIENT_PLATFORM,
        deviceFamily: "smart-glass",
        mode: OpenClawAuth.CLIENT_MODE,
        instanceId: this.getDeviceId()
      },
      role: "operator",
      scopes: ["operator.admin"],
      caps: []
    }

    // Auth priority: device token > gateway shared token
    // Device token is obtained after first successful pairing.
    // Gateway auth token allows connecting without device signing (dev mode).
    if (deviceToken) {
      params.auth = { token: deviceToken }
    } else if (this.gatewayAuthToken) {
      params.auth = { token: this.gatewayAuthToken }
    }

    // Note: Device crypto (publicKey/signature) is omitted for dev mode.
    // Spectacles doesn't have Node.js crypto for ED25519 signing.
    // Token-only auth skips device identity requirement on the server.

    return params
  }

  // ================================
  // Pairing Event Handling
  // ================================

  /**
   * Process a HelloOk response and extract/save auth info.
   */
  public processHelloOk(helloOk: OpenClawHelloOk): void {
    if (helloOk.auth) {
      this.saveDeviceToken(helloOk.auth.deviceToken, helloOk.auth.role)
      print("[OpenClaw] Authenticated as role=" + helloOk.auth.role +
        " scopes=" + (helloOk.auth.scopes || []).join(","))
    }
  }

  /**
   * Handle a device.pair.resolved event.
   */
  public handlePairResolved(event: DevicePairResolvedEvent): void {
    this.onPairingResolved.invoke(event)
    if (event.decision === "approved") {
      print("[OpenClaw] Device pairing approved")
    } else {
      print("[OpenClaw] Device pairing rejected")
      this.clearDeviceToken()
    }
  }
}

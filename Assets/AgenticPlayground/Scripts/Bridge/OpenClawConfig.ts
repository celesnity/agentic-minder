import { OpenClawBridgeConfig } from "./OpenClawTypes"

/**
 * OpenClawConfig - Configuration management for the OpenClaw bridge
 *
 * Provides default configuration values and persistence to PersistentStorage.
 * Configuration can be overridden via JarvisController inspector inputs.
 */

// Storage key prefix
const CONFIG_PREFIX = "openclaw_config_"

/**
 * Default configuration values.
 */
export const OPENCLAW_DEFAULTS: OpenClawBridgeConfig = {
  serverUrl: "ws://192.168.1.66:18789",
  authToken: "",
  connectTimeout: 5000,
  requestTimeout: 15000,
  heartbeatInterval: 30000,
  maxReconnectAttempts: 10,
  maxReconnectDelay: 30000,
  maxConcurrentRequests: 3,
  enableCamera: true,
  enableVoice: true,
  enableStreaming: true
}

/**
 * Load configuration from PersistentStorage, merging with defaults.
 */
export function loadConfig(): OpenClawBridgeConfig {
  const config = { ...OPENCLAW_DEFAULTS }

  try {
    const storedUrl = global.persistentStorageSystem.store.getString(CONFIG_PREFIX + "serverUrl")
    if (storedUrl && storedUrl.length > 0) {
      config.serverUrl = storedUrl
    }
  } catch (e) {
    // Use defaults
  }

  return config
}

/**
 * Save server URL to PersistentStorage.
 */
export function saveServerUrl(url: string): void {
  try {
    global.persistentStorageSystem.store.putString(CONFIG_PREFIX + "serverUrl", url)
  } catch (e) {
    print("[OpenClaw] Failed to save server URL: " + e)
  }
}

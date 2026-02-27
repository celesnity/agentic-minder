/**
 * Test script: Full OpenClaw gateway handshake
 *
 * Tests the challenge-response flow:
 * 1. Connect WebSocket to server
 * 2. Wait for connect.challenge event
 * 3. Send ConnectParams as a request frame (method: "connect")
 * 4. Receive HelloOk response
 *
 * Usage: node tests/test-handshake.mjs [host:port]
 * Default: 127.0.0.1:18789
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { WebSocket } = require("../openclaw/node_modules/ws");

const target = process.argv[2] || "127.0.0.1:18789";
const url = `ws://${target}`;

console.log(`\n=== OpenClaw Handshake Test ===`);
console.log(`Target: ${url}\n`);

let messageId = 0;
let connectNonce = null;
let connectSent = false;
let connectTimer = null;

const ws = new WebSocket(url, { maxPayload: 25 * 1024 * 1024 });

// Timeout for entire test
const testTimeout = setTimeout(() => {
  console.log("\n[FAIL] Test timed out after 10s");
  ws.close();
  process.exit(1);
}, 10000);

ws.on("open", () => {
  console.log("[1/4] WebSocket CONNECTED");

  // Queue connect with 750ms fallback (matching GatewayClient behavior)
  connectTimer = setTimeout(() => {
    console.log("[WARN] No challenge received within 750ms, sending connect anyway");
    sendConnect();
  }, 750);
});

ws.on("message", (raw) => {
  const data = raw.toString();
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    console.log("[WARN] Non-JSON message:", data.substring(0, 100));
    return;
  }

  // Check for event frames
  if (parsed.type === "event") {
    if (parsed.event === "connect.challenge") {
      const nonce = parsed.payload?.nonce;
      console.log(`[2/4] Challenge received: nonce=${nonce?.substring(0, 8)}...`);
      connectNonce = nonce;
      sendConnect();
      return;
    }
    if (parsed.event === "tick") {
      console.log("[INFO] Tick received");
      return;
    }
    console.log("[INFO] Event:", parsed.event, JSON.stringify(parsed.payload)?.substring(0, 200));
    return;
  }

  // Check for response frames
  if (parsed.type === "res") {
    if (parsed.ok) {
      const payload = parsed.payload;
      console.log(`[4/4] HelloOk received!`);
      console.log(`  Protocol version: ${payload?.version}`);
      console.log(`  Server connId: ${payload?.server?.connId}`);
      console.log(`  Methods: [${payload?.features?.methods?.join(", ")}]`);
      console.log(`  Events: [${payload?.features?.events?.join(", ")}]`);
      console.log(`  Auth token: ${payload?.auth?.deviceToken ? "YES" : "NO"}`);
      console.log(`  Auth role: ${payload?.auth?.role || "none"}`);
      console.log(`  Auth scopes: [${payload?.auth?.scopes?.join(", ") || ""}]`);
      console.log(`  Tick interval: ${payload?.policy?.tickIntervalMs || "default"}ms`);
      console.log(`\n[PASS] Handshake successful!`);

      // Keep alive for a bit to see if ticks arrive
      console.log("\nWaiting 5s for tick events...");
      setTimeout(() => {
        ws.close(1000, "test complete");
      }, 5000);
    } else {
      console.log(`[FAIL] Connect rejected: ${JSON.stringify(parsed.error)}`);
      ws.close();
    }
    return;
  }

  console.log("[INFO] Unknown frame:", JSON.stringify(parsed).substring(0, 200));
});

ws.on("close", (code, reason) => {
  clearTimeout(testTimeout);
  console.log(`\nWebSocket closed: code=${code} reason=${reason.toString()}`);
  process.exit(code === 1000 ? 0 : 1);
});

ws.on("error", (err) => {
  clearTimeout(testTimeout);
  console.log(`[FAIL] WebSocket error: ${err.message}`);
  process.exit(1);
});

function sendConnect() {
  if (connectSent) return;
  connectSent = true;
  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }

  messageId += 1;
  const frame = {
    type: "req",
    id: String(messageId),
    method: "connect",
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "gateway-client",
        displayName: "Spectacles Smart Glasses (Test)",
        version: "1.0.0-test",
        platform: "spectacles",
        mode: "node",
        instanceId: "test-" + Date.now()
      },
      auth: {
        token: "celesnity-minder"
      },
      role: "operator",
      scopes: ["operator.admin"],
      caps: []
    }
  };

  console.log(`[3/4] Sending ConnectParams (nonce=${connectNonce ? "yes" : "none"})...`);
  ws.send(JSON.stringify(frame));
}

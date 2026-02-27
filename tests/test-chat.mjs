/**
 * Test script: Full OpenClaw handshake + chat.send query
 *
 * Tests:
 * 1. Connect + authenticate with token
 * 2. List sessions to get a session key
 * 3. Send a chat.send query
 * 4. Collect streaming agent events and final response
 *
 * Usage: node tests/test-chat.mjs [host:port] [token]
 * Default: 127.0.0.1:18789, celesnity-minder
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { WebSocket } = require("../openclaw/node_modules/ws");

const target = process.argv[2] || "127.0.0.1:18789";
const authToken = process.argv[3] || "celesnity-minder";
const url = `ws://${target}`;

console.log(`\n=== OpenClaw Chat Test ===`);
console.log(`Target: ${url}`);
console.log(`Auth token: ${authToken}\n`);

let messageId = 0;
let connectNonce = null;
let connectSent = false;
let connectTimer = null;
let sessionKey = null;
let streamingText = "";
const pending = new Map();

const ws = new WebSocket(url, { maxPayload: 25 * 1024 * 1024 });

const testTimeout = setTimeout(() => {
  console.log("\n[FAIL] Test timed out after 60s");
  ws.close();
  process.exit(1);
}, 60000);

function sendRequest(method, params, opts = {}) {
  messageId += 1;
  const id = String(messageId);
  const frame = { type: "req", id, method, params };
  ws.send(JSON.stringify(frame));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, opts.timeout || 30000);
    pending.set(id, { resolve, reject, timer, expectFinal: opts.expectFinal });
  });
}

ws.on("open", () => {
  console.log("[OK] WebSocket connected");
  connectTimer = setTimeout(() => sendConnect(), 750);
});

ws.on("message", (raw) => {
  const data = raw.toString();
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }

  // Event frames
  if (parsed.type === "event") {
    if (parsed.event === "connect.challenge") {
      connectNonce = parsed.payload?.nonce;
      console.log(`[OK] Challenge received`);
      sendConnect();
      return;
    }
    if (parsed.event === "agent") {
      const p = parsed.payload;
      const text = p?.text || p?.content || "";
      const done = !!p?.done;
      if (text) {
        streamingText += text;
        process.stdout.write(text);
      }
      if (done) {
        console.log("\n[OK] Agent stream complete");
      }
      return;
    }
    if (parsed.event === "tick") return;
    if (parsed.event === "health") return;
    // Log all other events to debug
    console.log(`[EVENT] ${parsed.event}: ${JSON.stringify(parsed.payload)?.substring(0, 300)}`);
    return;
  }

  // Response frames
  if (parsed.type === "res") {
    const entry = pending.get(parsed.id);
    if (!entry) return;

    // Skip "accepted" ack — wait for final response
    const status = parsed.payload?.status;
    if (entry.expectFinal && status === "accepted") {
      console.log("[OK] chat.send accepted, waiting for agent response...");
      return;
    }

    clearTimeout(entry.timer);
    pending.delete(parsed.id);
    if (parsed.ok) {
      entry.resolve(parsed.payload);
    } else {
      entry.reject(new Error(parsed.error?.message || "unknown error"));
    }
  }
});

ws.on("close", (code, reason) => {
  clearTimeout(testTimeout);
  console.log(`\nWebSocket closed: code=${code}`);
  process.exit(code === 1000 ? 0 : 1);
});

ws.on("error", (err) => {
  clearTimeout(testTimeout);
  console.log(`[FAIL] Error: ${err.message}`);
  process.exit(1);
});

function sendConnect() {
  if (connectSent) return;
  connectSent = true;
  if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }

  messageId += 1;
  const id = String(messageId);
  const frame = {
    type: "req", id, method: "connect",
    params: {
      minProtocol: 3, maxProtocol: 3,
      client: {
        id: "gateway-client",
        displayName: "Spectacles Test",
        version: "1.0.0-test",
        platform: "spectacles",
        mode: "node",
        instanceId: "test-" + Date.now()
      },
      auth: { token: authToken },
      role: "operator",
      scopes: ["operator.admin"],
      caps: []
    }
  };

  ws.send(JSON.stringify(frame));

  const timer = setTimeout(() => {
    pending.delete(id);
    console.log("[FAIL] Connect timed out");
    ws.close();
  }, 10000);

  pending.set(id, {
    resolve: async (helloOk) => {
      console.log(`[OK] Authenticated (connId=${helloOk?.server?.connId?.substring(0, 8)}...)`);
      console.log(`[OK] ${helloOk?.features?.methods?.length} methods available`);
      await runChatTest();
    },
    reject: (err) => {
      console.log(`[FAIL] Connect: ${err.message}`);
      ws.close();
    },
    timer
  });
}

async function runChatTest() {
  try {
    // Step 1: List sessions
    console.log("\n--- Listing sessions ---");
    const sessions = await sendRequest("sessions.list", {});
    const sessionList = sessions?.sessions || [];
    console.log(`[OK] Found ${sessionList.length} sessions`);

    if (sessionList.length > 0) {
      sessionKey = sessionList[0].key || sessionList[0].sessionKey;
      console.log(`[OK] Using session: ${sessionKey?.substring(0, 12)}...`);
    } else {
      console.log("[INFO] No sessions exist yet. chat.send may create one automatically.");
      sessionKey = "default";
    }

    // Step 2: Send a test query
    console.log("\n--- Sending chat.send ---");
    console.log("Query: \"Hello, what is 2+2?\"");
    console.log("\n--- Agent response ---");
    streamingText = "";

    const chatResult = await sendRequest("chat.send", {
      sessionKey,
      message: "Hello, what is 2+2?",
      idempotencyKey: "test-" + Date.now()
    }, { timeout: 30000 });

    console.log("\n--- chat.send acknowledged ---");
    console.log("Status:", chatResult?.status, "runId:", chatResult?.runId);

    // Wait for agent streaming events (response comes async)
    console.log("\n--- Waiting for agent response (up to 30s) ---");
    await new Promise((resolve) => {
      const maxWait = setTimeout(() => {
        console.log("\n[WARN] Timed out waiting for agent events");
        resolve();
      }, 30000);

      // Check periodically if we got a response
      const check = setInterval(() => {
        if (streamingText.length > 0) {
          // Wait a bit more for streaming to finish
          clearInterval(check);
          setTimeout(() => {
            clearTimeout(maxWait);
            resolve();
          }, 3000);
        }
      }, 500);
    });

    if (streamingText) {
      console.log("\n\n--- Full response ---");
      console.log(streamingText);
      console.log("\n[PASS] Streaming response received!");
    } else {
      console.log("\n[INFO] No streaming events received. Agent may not have responded.");
    }

    ws.close(1000, "test complete");
  } catch (err) {
    console.log(`\n[FAIL] ${err.message}`);
    ws.close();
  }
}

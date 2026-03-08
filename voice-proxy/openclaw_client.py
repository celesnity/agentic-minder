"""
OpenClaw Protocol v3 Python Client.

Implements the OpenClaw gateway WebSocket protocol:
- Connect handshake (challenge-response, token auth)
- chat.send with streaming token events
- chat.abort for barge-in cancellation
- Heartbeat/tick handling

Protocol reference: tests/test-full-e2e.mjs
"""

import asyncio
import json
import logging
import time
from typing import AsyncGenerator

import websockets

import config

logger = logging.getLogger("openclaw")


class OpenClawClient:
    def __init__(self, url: str, token: str):
        self.url = url
        self.token = token
        self.ws = None
        self.connected = False
        self.session_key = None

        # Request tracking
        self._message_id = 0
        self._pending: dict[str, asyncio.Future] = {}
        self._receive_task: asyncio.Task | None = None

        # Streaming
        self._stream_queue: asyncio.Queue | None = None
        self._current_run_id: str | None = None
        self._abort_requested = False
        self._last_delta_text = ""  # Track accumulated text to extract deltas

    async def connect(self):
        """Connect to OpenClaw and perform handshake."""
        logger.info(f"Connecting to OpenClaw: {self.url}")

        self.ws = await websockets.connect(
            self.url,
            max_size=25 * 1024 * 1024,  # 25MB max frame
            ping_interval=None,  # We handle heartbeat via protocol ticks
        )

        # Start message receiver
        self._receive_task = asyncio.create_task(self._receive_loop())

        # Wait for challenge (750ms) then send connect
        challenge_nonce = None
        try:
            challenge_nonce = await asyncio.wait_for(
                self._wait_for_challenge(), timeout=0.75
            )
            logger.info(f"Challenge received: {challenge_nonce[:8]}...")
        except asyncio.TimeoutError:
            logger.info("No challenge in 750ms — connecting without nonce")

        # Send connect handshake
        hello_ok = await self._send_connect(challenge_nonce)
        logger.info(f"Connected: protocol v{hello_ok.get('protocol', '?')}")

        # Fetch session key
        await self._fetch_session_key()

        self.connected = True

    async def disconnect(self):
        """Disconnect from OpenClaw."""
        self.connected = False

        if self._receive_task:
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass

        if self.ws:
            await self.ws.close()
            self.ws = None

        logger.info("Disconnected from OpenClaw")

    async def chat_send_streaming(
        self, message: str, attachments: list | None = None
    ) -> AsyncGenerator[str, None]:
        """
        Send a chat message and yield streaming tokens.

        Yields str tokens as they arrive from the agent.
        """
        if not self.connected or not self.ws:
            raise RuntimeError("Not connected to OpenClaw")

        if not self.session_key:
            raise RuntimeError("No session key")

        self._abort_requested = False
        self._last_delta_text = ""
        self._stream_queue = asyncio.Queue()

        # Send chat.send
        params = {
            "sessionKey": self.session_key,
            "message": message,
            "idempotencyKey": f"proxy-{int(time.time() * 1000)}",
        }
        if attachments:
            params["attachments"] = attachments

        try:
            ack = await self._send_request("chat.send", params)
            self._current_run_id = ack.get("runId") if isinstance(ack, dict) else None
            logger.info(f"chat.send ack: runId={self._current_run_id}")
        except Exception as e:
            logger.error(f"chat.send failed: {e}")
            return

        # Yield streaming tokens from queue
        while True:
            try:
                item = await asyncio.wait_for(self._stream_queue.get(), timeout=60.0)
            except asyncio.TimeoutError:
                logger.warning("Stream timeout")
                break

            if item is None:
                # Stream complete
                break

            if self._abort_requested:
                break

            yield item

        self._stream_queue = None
        self._current_run_id = None

    async def abort(self):
        """Abort the current chat query (barge-in)."""
        if not self.connected or not self.ws or not self.session_key:
            return

        self._abort_requested = True

        params: dict = {"sessionKey": self.session_key}
        if self._current_run_id:
            params["runId"] = self._current_run_id

        try:
            self._message_id += 1
            msg_id = str(self._message_id)
            frame = json.dumps({
                "type": "req",
                "id": msg_id,
                "method": "chat.abort",
                "params": params,
            })
            await self.ws.send(frame)
            logger.info(f"Abort sent (runId={self._current_run_id})")
        except Exception as e:
            logger.error(f"Failed to send abort: {e}")

        # Signal stream to stop
        if self._stream_queue:
            await self._stream_queue.put(None)

    async def _receive_loop(self):
        """Background loop receiving all messages from OpenClaw."""
        try:
            async for raw in self.ws:
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8")

                try:
                    frame = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                frame_type = frame.get("type")

                if frame_type == "res":
                    self._handle_response(frame)
                elif frame_type == "event":
                    self._handle_event(frame)
                elif frame_type == "tick":
                    pass  # Heartbeat — we're alive
                elif frame_type == "shutdown":
                    logger.warning("Server shutting down")
                    self.connected = False

        except websockets.ConnectionClosed:
            logger.warning("OpenClaw connection closed")
            self.connected = False
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Receive loop error: {e}")
            self.connected = False

    def _handle_response(self, frame: dict):
        """Handle response frames (matched to pending requests)."""
        msg_id = frame.get("id")
        if not msg_id or msg_id not in self._pending:
            return

        future = self._pending.pop(msg_id)

        if frame.get("ok"):
            future.set_result(frame.get("payload"))
        else:
            error = frame.get("error", {})
            future.set_exception(
                RuntimeError(error.get("message", "Unknown error"))
            )

    def _handle_event(self, frame: dict):
        """Handle event frames (streaming tokens, chat events, etc.)."""
        event_name = frame.get("event")
        payload = frame.get("payload", {})

        # Log non-routine events (skip tick/health)
        if event_name not in ("tick", "health", "connect.challenge"):
            logger.debug(f"Event: {event_name}, keys={list(payload.keys()) if isinstance(payload, dict) else type(payload)}")

        if event_name == "connect.challenge":
            # Handled separately during connect
            if hasattr(self, "_challenge_future") and not self._challenge_future.done():
                self._challenge_future.set_result(payload.get("nonce"))
            return

        if event_name == "agent":
            # Streaming token — agent events carry incremental text
            # Note: agent.data contains accumulated state, NOT incremental tokens.
            # Use chat delta events as the primary text source instead.
            text = payload.get("text", "") or payload.get("content", "")
            done = payload.get("done", False)

            if text and self._stream_queue:
                asyncio.ensure_future(self._stream_queue.put(text))

            if done and self._stream_queue:
                asyncio.ensure_future(self._stream_queue.put(None))

        elif event_name == "chat":
            state = payload.get("state")
            logger.debug(f"Chat event: state={state}")

            if state == "delta":
                # Streaming delta — message contains full accumulated text
                # Extract only the new portion since last delta
                message = payload.get("message", {})
                full_text = self._extract_text(message)
                logger.debug(f"Chat delta: extracted_len={len(full_text)}")
                if full_text and len(full_text) > len(self._last_delta_text):
                    new_text = full_text[len(self._last_delta_text):]
                    self._last_delta_text = full_text
                    if new_text and self._stream_queue:
                        asyncio.ensure_future(self._stream_queue.put(new_text))

            elif state == "final":
                # Extract final text — only send portion not yet received via deltas
                message = payload.get("message", {})
                full_text = self._extract_text(message)
                if full_text and len(full_text) > len(self._last_delta_text):
                    remaining = full_text[len(self._last_delta_text):]
                    if remaining and self._stream_queue:
                        asyncio.ensure_future(self._stream_queue.put(remaining))
                if self._stream_queue:
                    asyncio.ensure_future(self._stream_queue.put(None))

            elif state == "aborted":
                logger.info("Chat aborted by server")
                if self._stream_queue:
                    asyncio.ensure_future(self._stream_queue.put(None))

            elif state == "error":
                logger.error(f"Chat error: {payload.get('errorMessage', 'unknown')}")
                if self._stream_queue:
                    asyncio.ensure_future(self._stream_queue.put(None))

            else:
                logger.info(f"Unhandled chat state: {state}, payload: {json.dumps(payload)[:200]}")

    @staticmethod
    def _extract_text(message: dict) -> str:
        """Extract text from an OpenClaw message object."""
        if not message:
            return ""
        content = message.get("content", [])
        if isinstance(content, list):
            return " ".join(
                c.get("text", "")
                for c in content
                if isinstance(c, dict) and c.get("type") == "text"
            )
        elif isinstance(content, str):
            return content
        return ""

    async def _wait_for_challenge(self) -> str:
        """Wait for connect.challenge event, return nonce."""
        self._challenge_future = asyncio.get_event_loop().create_future()
        return await self._challenge_future

    async def _send_connect(self, nonce: str | None = None) -> dict:
        """Send connect handshake and return HelloOk."""
        params = {
            "minProtocol": 3,
            "maxProtocol": 3,
            "client": {
                "id": config.OPENCLAW_CLIENT_ID,
                "displayName": "Voice Proxy",
                "version": "1.0.0",
                "platform": "server",
                "mode": "node",
                "instanceId": f"proxy-{int(time.time() * 1000)}",
            },
            "auth": {"token": self.token},
            "role": "operator",
            "scopes": ["operator.admin"],
            "caps": [],
        }

        return await self._send_request("connect", params, timeout=15.0)

    async def _fetch_session_key(self):
        """Fetch session key from sessions.list."""
        try:
            result = await self._send_request("sessions.list", {})
            sessions = result.get("sessions", []) if isinstance(result, dict) else []

            if sessions:
                self.session_key = sessions[0].get("key") or sessions[0].get("sessionKey")
                logger.info(f"Session key: {self.session_key}")
            else:
                self.session_key = "default"
                logger.info("No sessions found, using 'default'")
        except Exception as e:
            logger.warning(f"sessions.list failed: {e}, using 'default'")
            self.session_key = "default"

    async def _send_request(
        self, method: str, params: dict, timeout: float = 30.0
    ) -> dict:
        """Send a request and wait for response."""
        self._message_id += 1
        msg_id = str(self._message_id)

        frame = json.dumps({
            "type": "req",
            "id": msg_id,
            "method": method,
            "params": params,
        })

        future = asyncio.get_event_loop().create_future()
        self._pending[msg_id] = future

        await self.ws.send(frame)

        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(msg_id, None)
            raise RuntimeError(f"{method} timeout after {timeout}s")

"""
Streaming TTS client using Cartesia WebSocket API.

Uses a persistent WebSocket connection for low-latency streaming synthesis.
Each sentence gets its own context — send() returns immediately, receive()
yields PCM16 audio chunks as they arrive.

Supports cancellation for barge-in.
"""

import logging
import os

import certifi
from cartesia import AsyncCartesia

import config

# Ensure websockets library uses certifi CA bundle
os.environ.setdefault("SSL_CERT_FILE", certifi.where())

logger = logging.getLogger("tts")


class CartesiaTTS:
    def __init__(self):
        if not config.CARTESIA_API_KEY:
            raise ValueError("CARTESIA_API_KEY not set")

        self.client = AsyncCartesia(api_key=config.CARTESIA_API_KEY)
        self.voice_id = config.CARTESIA_VOICE_ID
        self.cancelled = False
        self._ws_conn = None

        logger.info(f"TTS initialized: voice={self.voice_id}")

    async def warmup(self):
        """Pre-connect WebSocket during session startup to eliminate first-request latency."""
        await self._ensure_ws()

    async def _ensure_ws(self):
        """Ensure persistent WebSocket connection is open and healthy."""
        if self._ws_conn is not None:
            # Check if the connection is still alive
            try:
                # Try creating a context — if WebSocket is dead, this will fail
                ctx = self._ws_conn.context()
                # Context creation succeeded, connection is alive
                del ctx
            except Exception as e:
                logger.warning(f"TTS WebSocket stale, reconnecting: {e}")
                self._ws_conn = None

        if self._ws_conn is None:
            manager = self.client.tts.websocket_connect()
            self._ws_conn = await manager.enter()
            logger.info("TTS WebSocket connected")

    async def synthesize_streaming(self, text: str):
        """
        Synthesize text to PCM16 audio chunks via persistent WebSocket.

        Yields bytes chunks of PCM16 audio at 16kHz mono.
        """
        if not text.strip():
            return

        self.cancelled = False
        logger.info(f"TTS synthesizing: '{text[:60]}...'")

        for attempt in range(2):
            try:
                await self._ensure_ws()

                ctx = self._ws_conn.context()
                await ctx.send(
                    model_id="sonic-2",
                    transcript=text,
                    voice={"mode": "id", "id": self.voice_id},
                    output_format={
                        "container": "raw",
                        "encoding": "pcm_s16le",
                        "sample_rate": config.SAMPLE_RATE,
                    },
                    continue_=False,
                )
                await ctx.no_more_inputs()

                async for event in ctx.receive():
                    if self.cancelled:
                        logger.info("TTS cancelled during synthesis")
                        break

                    if hasattr(event, "audio") and event.audio:
                        yield event.audio
                    elif hasattr(event, "data") and event.data:
                        yield event.data

                # Success — break retry loop
                break

            except Exception as e:
                if self.cancelled:
                    break
                logger.error(f"TTS error (attempt {attempt + 1}): {e}")
                # Reset WebSocket so next attempt reconnects
                self._ws_conn = None
                if attempt == 0:
                    logger.info("TTS retrying with fresh connection...")
                    continue
                # Second attempt failed — give up

        if self.cancelled:
            # Force reconnect after cancellation to avoid corrupted context state
            logger.info("TTS resetting WebSocket after cancellation")
            self._ws_conn = None

    def cancel(self):
        """Cancel ongoing TTS synthesis."""
        self.cancelled = True
        logger.info("TTS cancellation requested")

    def close(self):
        """Close TTS resources."""
        self.cancelled = True
        self._ws_conn = None

"""
Simple echo WebSocket server for audio loopback testing.

Receives binary PCM16 frames from Spectacles and echoes them back.
Used for Task 1.4: End-to-end audio loopback test.

Usage:
    python echo_server.py [port]
"""

import asyncio
import json
import logging
import sys

import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s [echo] %(message)s")
logger = logging.getLogger("echo")

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
frames_received = 0
bytes_total = 0


async def handler(websocket):
    global frames_received, bytes_total
    frames_received = 0
    bytes_total = 0

    logger.info(f"Client connected from {websocket.remote_address}")

    try:
        async for message in websocket:
            if isinstance(message, bytes):
                # Binary frame → echo back
                frames_received += 1
                bytes_total += len(message)
                await websocket.send(message)

                if frames_received % 50 == 0:  # Log every ~1 second
                    logger.info(
                        f"Echoed {frames_received} frames "
                        f"({bytes_total / 1024:.1f} KB)"
                    )

            elif isinstance(message, str):
                # Text frame → parse and respond
                try:
                    msg = json.loads(message)
                    if msg.get("type") == "session.start":
                        logger.info(f"Session started: {msg.get('config', {})}")
                        await websocket.send(json.dumps({
                            "type": "session.started",
                            "config": msg.get("config", {}),
                        }))
                    else:
                        logger.info(f"Control: {msg.get('type', 'unknown')}")
                except json.JSONDecodeError:
                    logger.warning(f"Invalid JSON: {message[:100]}")

    except websockets.ConnectionClosed:
        logger.info("Client disconnected")
    finally:
        logger.info(
            f"Session stats: {frames_received} frames, "
            f"{bytes_total / 1024:.1f} KB total"
        )


async def main():
    logger.info(f"Echo server starting on ws://0.0.0.0:{PORT}")
    async with websockets.serve(handler, "0.0.0.0", PORT):
        await asyncio.Future()  # Run forever


if __name__ == "__main__":
    asyncio.run(main())

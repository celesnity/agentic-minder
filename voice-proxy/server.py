"""
Voice Proxy Server — WebSocket server accepting connections from Spectacles.

Handles binary PCM16 audio frames (mic input) and text JSON control messages.
Routes audio through VAD → ASR → OpenClaw → TTS → binary audio output pipeline.

Usage:
    python server.py
    # or with uvicorn:
    uvicorn server:app --host 0.0.0.0 --port 8765
"""

import asyncio
import json
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

import config
from pipeline import VoicePipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
logger = logging.getLogger("voice-proxy")

app = FastAPI(title="Voice Proxy Server")


@app.websocket("/")
async def websocket_endpoint(ws: WebSocket):
    """Handle a single Spectacles client connection."""
    await ws.accept()
    client_id = id(ws)
    logger.info(f"[{client_id}] Client connected")

    pipeline = VoicePipeline(ws)

    try:
        while True:
            message = await ws.receive()

            if "bytes" in message and message["bytes"]:
                # Binary frame → PCM16 audio from mic
                await pipeline.handle_audio_frame(message["bytes"])

            elif "text" in message and message["text"]:
                # Text frame → JSON control message
                try:
                    msg = json.loads(message["text"])
                    await pipeline.handle_control_message(msg)
                except json.JSONDecodeError:
                    logger.warning(f"[{client_id}] Invalid JSON: {message['text'][:100]}")

    except WebSocketDisconnect:
        logger.info(f"[{client_id}] Client disconnected")
    except Exception as e:
        logger.error(f"[{client_id}] Error: {e}")
    finally:
        await pipeline.cleanup()
        logger.info(f"[{client_id}] Pipeline cleaned up")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "voice-proxy"}


if __name__ == "__main__":
    import uvicorn
    logger.info(f"Starting voice proxy on {config.HOST}:{config.PORT}")
    uvicorn.run(app, host=config.HOST, port=config.PORT)

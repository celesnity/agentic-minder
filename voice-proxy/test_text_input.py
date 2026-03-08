"""
End-to-end test for the voice proxy TEXT INPUT mode (hybrid voice bridge).

Tests the flow: WebSocket connect → session.start(inputMode="text")
→ query.text → OpenClaw response → parallel TTS streaming → audio output.

No audio is sent to the proxy — only JSON text messages.

Usage:
    # Start OpenClaw gateway and voice proxy server first
    # Then run: uv run python test_text_input.py
"""

import asyncio
import base64
import json
import logging
import time

import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
logger = logging.getLogger("test_text_input")

SERVER_URL = "ws://127.0.0.1:8765"
SAMPLE_RATE = 16000


async def test_text_input():
    """Test text input mode: send query.text, receive text deltas + audio."""

    logger.info(f"Connecting to {SERVER_URL}...")
    ws = await websockets.connect(SERVER_URL)
    logger.info("Connected")

    events = []
    audio_chunks_received = 0
    audio_bytes_received = 0
    first_audio_time = None
    response_text = ""
    done_event = asyncio.Event()
    session_ready = asyncio.Event()
    start_time = None

    async def receive_messages():
        nonlocal audio_chunks_received, audio_bytes_received, first_audio_time, response_text
        try:
            async for msg in ws:
                if isinstance(msg, bytes):
                    audio_chunks_received += 1
                    audio_bytes_received += len(msg)
                    if first_audio_time is None and start_time:
                        first_audio_time = time.time()
                        elapsed = first_audio_time - start_time
                        logger.info(f"*** FIRST AUDIO at {elapsed:.2f}s ({len(msg)} bytes) ***")
                    if audio_chunks_received % 10 == 0:
                        logger.info(f"Audio chunks: {audio_chunks_received} ({audio_bytes_received} bytes)")
                else:
                    data = json.loads(msg)
                    event_type = data.get("type", "")
                    events.append(data)

                    if event_type == "response.audio.data":
                        pcm = base64.b64decode(data.get("data", ""))
                        audio_chunks_received += 1
                        audio_bytes_received += len(pcm)
                        if first_audio_time is None and start_time:
                            first_audio_time = time.time()
                            elapsed = first_audio_time - start_time
                            logger.info(f"*** FIRST AUDIO at {elapsed:.2f}s ({len(pcm)} bytes) ***")
                        if audio_chunks_received % 10 == 0:
                            logger.info(f"Audio chunks: {audio_chunks_received} ({audio_bytes_received} bytes)")
                    elif event_type == "session.started":
                        cfg = data.get("config", {})
                        logger.info(f"Session started: {cfg}")
                        session_ready.set()
                    elif event_type == "transcript.final":
                        logger.info(f"Transcript echoed: '{data.get('text', '')}'")
                    elif event_type == "response.text.delta":
                        response_text = data.get("accumulated", "")
                    elif event_type == "response.audio.start":
                        elapsed = time.time() - start_time if start_time else 0
                        logger.info(f"Audio stream started at {elapsed:.2f}s")
                    elif event_type == "response.done":
                        elapsed = time.time() - start_time if start_time else 0
                        text = data.get("text", "")
                        logger.info(f"Response done at {elapsed:.2f}s: '{text[:120]}...'")
                        done_event.set()
                    elif event_type == "error":
                        logger.error(f"Error: {data}")
                        done_event.set()
        except websockets.ConnectionClosed:
            pass

    receiver = asyncio.create_task(receive_messages())

    # Step 1: Send session.start with text input mode
    logger.info("--- Sending session.start (inputMode=text) ---")
    await ws.send(json.dumps({
        "type": "session.start",
        "config": {"inputMode": "text"},
    }))

    # Wait for session.started
    try:
        await asyncio.wait_for(session_ready.wait(), timeout=15.0)
    except asyncio.TimeoutError:
        logger.error("FAIL: Timeout waiting for session.started")
        receiver.cancel()
        await ws.close()
        return

    # Verify text input mode in session config
    session_event = next((e for e in events if e.get("type") == "session.started"), None)
    session_config = session_event.get("config", {}) if session_event else {}
    if session_config.get("inputMode") != "text":
        logger.error(f"FAIL: Expected inputMode=text, got {session_config.get('inputMode')}")
    else:
        logger.info("Session confirmed: inputMode=text")

    # Step 2: Send query.text
    query = "Tell me a fun fact about the ocean in two sentences."
    logger.info(f"--- Sending query.text: '{query}' ---")
    start_time = time.time()
    await ws.send(json.dumps({
        "type": "query.text",
        "text": query,
    }))

    # Step 3: Wait for response
    logger.info("--- Waiting for response (timeout 60s) ---")
    try:
        await asyncio.wait_for(done_event.wait(), timeout=60.0)
    except asyncio.TimeoutError:
        logger.warning("Timeout waiting for response.done")

    total_time = time.time() - start_time

    # Summary
    audio_duration = audio_bytes_received / (SAMPLE_RATE * 2) if audio_bytes_received else 0
    event_types = [e.get("type") for e in events]

    logger.info("")
    logger.info("=" * 60)
    logger.info("TEXT INPUT E2E TEST RESULTS")
    logger.info("=" * 60)
    logger.info(f"Total time:            {total_time:.2f}s")
    if first_audio_time:
        logger.info(f"Time to first audio:   {first_audio_time - start_time:.2f}s")
    else:
        logger.info("Time to first audio:   N/A (no audio received)")
    logger.info(f"Audio chunks received: {audio_chunks_received}")
    logger.info(f"Audio bytes received:  {audio_bytes_received}")
    logger.info(f"Audio duration:        {audio_duration:.2f}s")
    logger.info(f"Response text length:  {len(response_text)} chars")
    logger.info(f"Response preview:      '{response_text[:150]}'")
    logger.info(f"Event flow:            {event_types}")
    logger.info("=" * 60)

    # Pass/fail checks
    passed = True

    # Should NOT have VAD events in text mode
    if "vad.speech_start" in event_types:
        logger.error("FAIL: VAD events received in text input mode (should be skipped)")
        passed = False

    if "transcript.final" not in event_types:
        logger.error("FAIL: No transcript.final echo received")
        passed = False

    if "response.text.delta" not in event_types:
        logger.error("FAIL: No response.text.delta received")
        passed = False

    if "response.done" not in event_types:
        logger.error("FAIL: No response.done received")
        passed = False

    if audio_chunks_received == 0:
        logger.error("FAIL: No audio chunks received")
        passed = False

    if passed:
        logger.info("PASS: Text input E2E pipeline working!")
    else:
        logger.info("FAIL: Some checks failed (see above)")

    # Step 4: Test sending a second query (verify pipeline resets to IDLE)
    logger.info("")
    logger.info("--- Testing second query (pipeline reset) ---")
    done_event.clear()
    second_start = time.time()
    second_audio_received = audio_chunks_received

    await ws.send(json.dumps({
        "type": "query.text",
        "text": "What is 2 + 2?",
    }))

    try:
        await asyncio.wait_for(done_event.wait(), timeout=30.0)
        new_audio = audio_chunks_received - second_audio_received
        logger.info(f"Second query completed in {time.time() - second_start:.2f}s, {new_audio} new audio chunks")
        logger.info("PASS: Pipeline correctly reset for second query")
    except asyncio.TimeoutError:
        logger.error("FAIL: Second query timed out (pipeline may not have reset to IDLE)")

    # Cleanup
    receiver.cancel()
    await ws.close()


if __name__ == "__main__":
    asyncio.run(test_text_input())

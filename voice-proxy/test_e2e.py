"""
End-to-end test for the voice proxy pipeline.

Tests the FULL flow: WebSocket connect → session.start → real speech audio
→ VAD detection → ASR transcription → OpenClaw query → parallel TTS streaming → audio output.

Step 1: Uses Cartesia TTS to generate a real speech WAV ("Hello, what is the weather today?")
Step 2: Feeds that PCM16 audio into the voice proxy as mic input
Step 3: VAD detects speech, ASR transcribes, OpenClaw responds, TTS streams back

Measures time-to-first-audio to verify parallel LLM+TTS improvement.

Usage:
    # Start OpenClaw gateway and voice proxy server first
    # Then run: uv run python test_e2e.py
"""

import asyncio
import json
import logging
import struct
import time

import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
logger = logging.getLogger("test_e2e")

SERVER_URL = "ws://127.0.0.1:8765"
SAMPLE_RATE = 16000
FRAME_SIZE = 320  # 20ms at 16kHz
FRAME_BYTES = FRAME_SIZE * 2  # PCM16 = 2 bytes/sample


async def generate_speech_audio() -> bytes:
    """Use Cartesia TTS to generate real speech audio as PCM16 bytes."""
    import config
    from cartesia import AsyncCartesia

    logger.info("Generating speech audio via Cartesia TTS...")
    client = AsyncCartesia(api_key=config.CARTESIA_API_KEY)

    pcm_data = bytearray()
    stream = await client.tts.sse(
        model_id="sonic-2",
        transcript="Tell me a fun fact about the moon.",
        voice={"mode": "id", "id": config.CARTESIA_VOICE_ID},
        output_format={
            "container": "raw",
            "encoding": "pcm_s16le",
            "sample_rate": SAMPLE_RATE,
        },
    )
    async for event in stream:
        if hasattr(event, "audio") and event.audio:
            pcm_data.extend(event.audio)
        elif hasattr(event, "data") and event.data:
            pcm_data.extend(event.data)

    duration = len(pcm_data) / (SAMPLE_RATE * 2)
    logger.info(f"Generated {len(pcm_data)} bytes of speech audio ({duration:.2f}s)")
    return bytes(pcm_data)


def pcm_to_frames(pcm_bytes: bytes) -> list[bytes]:
    """Split PCM16 audio into 20ms frames."""
    frames = []
    for offset in range(0, len(pcm_bytes) - FRAME_BYTES + 1, FRAME_BYTES):
        frames.append(pcm_bytes[offset:offset + FRAME_BYTES])
    return frames


def generate_silence_frames(duration_s: float = 1.0) -> list[bytes]:
    """Generate silence frames."""
    total_frames = int(SAMPLE_RATE * duration_s / FRAME_SIZE)
    return [b"\x00" * FRAME_BYTES for _ in range(total_frames)]


async def test_e2e():
    """Run full E2E test with real speech audio."""

    # Step 1: Generate real speech audio
    speech_pcm = await generate_speech_audio()
    speech_frames = pcm_to_frames(speech_pcm)
    silence_frames = generate_silence_frames(1.5)

    # Step 2: Connect to voice proxy
    logger.info(f"Connecting to {SERVER_URL}...")
    ws = await websockets.connect(SERVER_URL)
    logger.info("Connected")

    # Track events and timing
    events = []
    audio_chunks_received = 0
    audio_bytes_received = 0
    first_audio_time = None
    response_text = ""
    done_event = asyncio.Event()
    start_time = None

    async def receive_messages():
        nonlocal audio_chunks_received, audio_bytes_received, first_audio_time, response_text
        try:
            async for msg in ws:
                if isinstance(msg, bytes):
                    audio_chunks_received += 1
                    audio_bytes_received += len(msg)
                    if first_audio_time is None:
                        first_audio_time = time.time()
                        elapsed = first_audio_time - start_time
                        logger.info(f"*** FIRST AUDIO at {elapsed:.2f}s ({len(msg)} bytes) ***")
                    if audio_chunks_received % 10 == 0:
                        logger.info(f"Audio chunks: {audio_chunks_received} ({audio_bytes_received} bytes)")
                else:
                    data = json.loads(msg)
                    event_type = data.get("type", "")
                    events.append(data)

                    if event_type == "session.started":
                        logger.info(f"Session started: {data.get('config', {})}")
                    elif event_type == "vad.speech_start":
                        elapsed = time.time() - start_time if start_time else 0
                        logger.info(f"VAD: speech_start at {elapsed:.2f}s")
                    elif event_type == "vad.speech_end":
                        elapsed = time.time() - start_time if start_time else 0
                        logger.info(f"VAD: speech_end at {elapsed:.2f}s")
                    elif event_type == "transcript.final":
                        elapsed = time.time() - start_time if start_time else 0
                        logger.info(f"Transcript at {elapsed:.2f}s: '{data.get('text', '')}'")
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

    # Step 3: Send session.start and wait for init
    logger.info("--- Sending session.start ---")
    await ws.send(json.dumps({"type": "session.start", "config": {}}))
    await asyncio.sleep(3)  # Wait for OpenClaw connect, VAD/ASR/TTS init

    # Step 4: Send real speech audio frames at real-time pace
    logger.info(f"--- Sending {len(speech_frames)} speech frames ({len(speech_frames)*20}ms) ---")
    start_time = time.time()

    for frame in speech_frames:
        await ws.send(frame)
        await asyncio.sleep(0.02)  # 20ms real-time pacing

    # Step 5: Send silence to trigger speech_end via VAD
    logger.info(f"--- Sending {len(silence_frames)} silence frames ({len(silence_frames)*20}ms) ---")
    for frame in silence_frames:
        await ws.send(frame)
        await asyncio.sleep(0.02)

    # Step 6: Wait for full response
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
    logger.info("E2E TEST RESULTS")
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
    if "vad.speech_start" not in event_types:
        logger.error("FAIL: VAD never detected speech")
        passed = False
    if "transcript.final" not in event_types:
        logger.error("FAIL: No transcript produced")
        passed = False
    if "response.done" not in event_types:
        logger.error("FAIL: No response.done received")
        passed = False
    if audio_chunks_received == 0:
        logger.error("FAIL: No audio chunks received")
        passed = False
    if passed:
        logger.info("PASS: Full E2E pipeline working!")

    # Cleanup
    receiver.cancel()
    await ws.close()


if __name__ == "__main__":
    asyncio.run(test_e2e())

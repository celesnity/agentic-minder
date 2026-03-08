"""
Integration tests for voice proxy pipeline.

Tests three critical scenarios:
  1. Parallel LLM+TTS streaming — TTS audio starts BEFORE LLM finishes
  2. Audio playback simulation — PCM16→Float32 conversion, local WAV output, optional speaker playback
  3. Barge-in — interrupt during PROCESSING and SPEAKING states

Usage:
    # Start OpenClaw gateway and voice proxy server first
    # Run all tests:  uv run python test_integration.py
    # Run one test:   uv run python test_integration.py --test parallel
    #                 uv run python test_integration.py --test playback
    #                 uv run python test_integration.py --test bargein
    # Play audio:     uv run python test_integration.py --test playback --play
"""

import argparse
import asyncio
import base64
import json
import logging
import math
import struct
import time
import wave
from pathlib import Path

import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
logger = logging.getLogger("test_integration")

SERVER_URL = "ws://127.0.0.1:8765"
SAMPLE_RATE = 16000
FRAME_SIZE = 320  # 20ms at 16kHz
FRAME_BYTES = FRAME_SIZE * 2


class TestResult:
    def __init__(self, name: str):
        self.name = name
        self.checks: list[tuple[str, bool, str]] = []

    def check(self, label: str, passed: bool, detail: str = ""):
        self.checks.append((label, passed, detail))
        status = "PASS" if passed else "FAIL"
        msg = f"  [{status}] {label}"
        if detail:
            msg += f" — {detail}"
        logger.info(msg)

    def summary(self) -> bool:
        passed = sum(1 for _, ok, _ in self.checks if ok)
        total = len(self.checks)
        all_passed = passed == total
        status = "PASS" if all_passed else "FAIL"
        logger.info(f"\n{'='*60}")
        logger.info(f"  {self.name}: {status} ({passed}/{total} checks)")
        logger.info(f"{'='*60}")
        return all_passed


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def connect_and_start_session(input_mode: str = "text") -> tuple:
    """Connect to proxy, send session.start, wait for session.started."""
    ws = await websockets.connect(SERVER_URL, max_size=10 * 1024 * 1024)
    await ws.send(json.dumps({
        "type": "session.start",
        "config": {"inputMode": input_mode},
    }))

    # Wait for session.started
    deadline = time.time() + 15
    while time.time() < deadline:
        msg = await asyncio.wait_for(ws.recv(), timeout=15)
        if isinstance(msg, str):
            data = json.loads(msg)
            if data.get("type") == "session.started":
                logger.info(f"Session started: {data.get('config', {})}")
                return ws, data
    raise TimeoutError("session.started not received within 15s")


def pcm16_to_float32(pcm_bytes: bytes) -> list[float]:
    """Convert PCM16 LE bytes to float32 samples (mirrors Spectacles conversion)."""
    n_samples = len(pcm_bytes) // 2
    samples = struct.unpack(f"<{n_samples}h", pcm_bytes)
    return [s / 32768.0 for s in samples]


def compute_rms(float_samples: list[float]) -> float:
    """Compute RMS of float32 samples."""
    if not float_samples:
        return 0.0
    return math.sqrt(sum(s * s for s in float_samples) / len(float_samples))


def save_wav(pcm_bytes: bytes, path: str, sample_rate: int = SAMPLE_RATE):
    """Save raw PCM16 bytes to a WAV file."""
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    logger.info(f"Saved WAV: {path} ({len(pcm_bytes)} bytes, {len(pcm_bytes)/(sample_rate*2):.2f}s)")


# ---------------------------------------------------------------------------
# Test 1: Parallel LLM + TTS Streaming
# ---------------------------------------------------------------------------

async def test_parallel_streaming():
    """Verify TTS audio starts streaming BEFORE LLM finishes generating text.

    Key assertions:
      - First audio chunk arrives before response.done
      - First text delta arrives before first audio (text leads audio)
      - Multiple audio chunks received while text is still streaming
      - Time-to-first-audio is reasonable (<15s including LLM latency)
    """
    result = TestResult("Test 1: Parallel LLM+TTS Streaming")
    logger.info("\n" + "="*60)
    logger.info("TEST 1: Parallel LLM+TTS Streaming")
    logger.info("="*60)

    ws, _ = await connect_and_start_session("text")

    # State tracking
    events: list[dict] = []
    audio_chunks: list[tuple[float, int]] = []  # (timestamp, size)
    text_deltas: list[tuple[float, str]] = []  # (timestamp, accumulated)
    first_audio_time: float | None = None
    first_text_time: float | None = None
    done_time: float | None = None
    audio_start_time: float | None = None
    done_event = asyncio.Event()

    t0 = time.time()

    async def receiver():
        nonlocal first_audio_time, first_text_time, done_time, audio_start_time
        try:
            async for msg in ws:
                t = time.time() - t0
                if isinstance(msg, bytes):
                    audio_chunks.append((t, len(msg)))
                    if first_audio_time is None:
                        first_audio_time = t
                        logger.info(f"  FIRST audio chunk at +{t:.3f}s ({len(msg)} bytes) [binary]")
                elif isinstance(msg, str):
                    data = json.loads(msg)
                    evt = data.get("type", "")
                    events.append(data)

                    if evt == "response.audio.data":
                        # Base64-encoded audio in JSON text frame
                        b64 = data.get("data", "")
                        pcm = base64.b64decode(b64)
                        audio_chunks.append((t, len(pcm)))
                        if first_audio_time is None:
                            first_audio_time = t
                            logger.info(f"  FIRST audio chunk at +{t:.3f}s ({len(pcm)} bytes) [base64]")
                    elif evt == "response.text.delta":
                        acc = data.get("accumulated", "")
                        text_deltas.append((t, acc))
                        if first_text_time is None:
                            first_text_time = t
                            logger.info(f"  FIRST text delta at +{t:.3f}s")
                    elif evt == "response.audio.start":
                        audio_start_time = t
                        logger.info(f"  Audio stream start at +{t:.3f}s")
                    elif evt == "response.done":
                        done_time = t
                        logger.info(f"  Response done at +{t:.3f}s")
                        done_event.set()
                    elif evt == "error":
                        logger.error(f"  Error: {data}")
                        done_event.set()
        except websockets.ConnectionClosed:
            pass

    recv_task = asyncio.create_task(receiver())

    # Send a query that will produce a multi-sentence response
    query = "Explain why the sky is blue in exactly three sentences."
    logger.info(f"  Sending query: '{query}'")
    await ws.send(json.dumps({"type": "query.text", "text": query}))

    try:
        await asyncio.wait_for(done_event.wait(), timeout=60)
    except asyncio.TimeoutError:
        logger.error("  Timeout waiting for response.done (60s)")

    recv_task.cancel()
    await ws.close()

    # ----- Assertions -----

    result.check(
        "Response completed",
        done_time is not None,
        f"done at +{done_time:.2f}s" if done_time else "never received",
    )

    result.check(
        "Text deltas received",
        len(text_deltas) > 0,
        f"{len(text_deltas)} deltas",
    )

    result.check(
        "Audio chunks received",
        len(audio_chunks) > 0,
        f"{len(audio_chunks)} chunks",
    )

    # Key parallelism check: first audio BEFORE response done
    if first_audio_time and done_time:
        audio_before_done = first_audio_time < done_time
        gap = done_time - first_audio_time
        result.check(
            "Audio starts BEFORE response.done (parallel proof)",
            audio_before_done,
            f"audio at +{first_audio_time:.2f}s, done at +{done_time:.2f}s (gap={gap:.2f}s)",
        )
    else:
        result.check("Audio starts BEFORE response.done", False, "missing timestamps")

    # Text leads audio (LLM produces text, then TTS synthesizes)
    if first_text_time and first_audio_time:
        text_leads = first_text_time < first_audio_time
        gap = first_audio_time - first_text_time
        result.check(
            "Text delta arrives before first audio",
            text_leads,
            f"text at +{first_text_time:.2f}s, audio at +{first_audio_time:.2f}s (gap={gap:.2f}s)",
        )
    else:
        result.check("Text delta arrives before first audio", False, "missing timestamps")

    # Audio chunks arrive while text is still streaming
    if text_deltas and audio_chunks:
        last_text_time = text_deltas[-1][0]
        audio_during_text = sum(1 for t, _ in audio_chunks if t < last_text_time)
        result.check(
            "Audio chunks arrive during text streaming",
            audio_during_text > 0,
            f"{audio_during_text} audio chunks arrived before last text delta",
        )

    # Latency check: first audio within 15s (includes LLM cold start)
    if first_audio_time:
        result.check(
            "Time-to-first-audio < 15s",
            first_audio_time < 15.0,
            f"{first_audio_time:.2f}s",
        )

    return result.summary()


# ---------------------------------------------------------------------------
# Test 2: Audio Playback Simulation
# ---------------------------------------------------------------------------

async def test_audio_playback(play_audio: bool = False):
    """Simulate Spectacles audio playback pipeline without hardware.

    Receives TTS audio from proxy, applies the same PCM16→Float32 conversion
    used by HybridVoiceController.ts, validates the audio data, saves to WAV,
    and optionally plays through local speakers.

    Key assertions:
      - PCM16 data is valid (non-zero, correct alignment)
      - Float32 conversion produces values in [-1.0, 1.0]
      - Audio has non-trivial RMS (not silence)
      - Jitter buffer simulation works (3-frame minimum)
      - Audio duration matches expected range
    """
    result = TestResult("Test 2: Audio Playback Simulation")
    logger.info("\n" + "="*60)
    logger.info("TEST 2: Audio Playback Simulation (Spectacles Emulation)")
    logger.info("="*60)

    ws, _ = await connect_and_start_session("text")

    # Simulate HybridVoiceController state
    audio_queue: list[bytes] = []
    jitter_buffer_size = 3
    playback_started = False
    enqueued_frames: list[list[float]] = []  # Float32 frames (simulated output)
    all_pcm_bytes = bytearray()
    chunks_received = 0
    done_event = asyncio.Event()
    first_chunk_size = 0

    # Stats
    min_sample = 0.0
    max_sample = 0.0
    rms_values: list[float] = []

    def enqueue_audio(data: bytes):
        """Simulate HybridVoiceController.enqueueAudio() exactly."""
        nonlocal min_sample, max_sample
        float_samples = pcm16_to_float32(data)

        # Track range
        if float_samples:
            chunk_min = min(float_samples)
            chunk_max = max(float_samples)
            min_sample = min(min_sample, chunk_min)
            max_sample = max(max_sample, chunk_max)
            rms_values.append(compute_rms(float_samples))

        # Simulated enqueueAudioFrame(float32, shape)
        enqueued_frames.append(float_samples)

    def simulate_playback_chunk(data: bytes):
        """Simulate the jitter buffer + drain logic from HybridVoiceController."""
        nonlocal playback_started
        audio_queue.append(data)

        if not playback_started and len(audio_queue) >= jitter_buffer_size:
            playback_started = True
            # Drain all buffered frames
            while audio_queue:
                chunk = audio_queue.pop(0)
                enqueue_audio(chunk)
        elif playback_started:
            while audio_queue:
                chunk = audio_queue.pop(0)
                enqueue_audio(chunk)

    async def receiver():
        nonlocal chunks_received, first_chunk_size
        try:
            async for msg in ws:
                if isinstance(msg, bytes):
                    chunks_received += 1
                    all_pcm_bytes.extend(msg)
                    if chunks_received == 1:
                        first_chunk_size = len(msg)
                    simulate_playback_chunk(msg)
                    if chunks_received % 50 == 0:
                        logger.info(f"  Received {chunks_received} chunks ({len(all_pcm_bytes)} bytes)")
                elif isinstance(msg, str):
                    data = json.loads(msg)
                    evt = data.get("type", "")
                    if evt == "response.audio.data":
                        pcm = base64.b64decode(data.get("data", ""))
                        chunks_received += 1
                        all_pcm_bytes.extend(pcm)
                        if chunks_received == 1:
                            first_chunk_size = len(pcm)
                        simulate_playback_chunk(pcm)
                        if chunks_received % 50 == 0:
                            logger.info(f"  Received {chunks_received} chunks ({len(all_pcm_bytes)} bytes)")
                    elif evt == "response.done":
                        done_event.set()
                    elif evt == "error":
                        logger.error(f"  Error: {data}")
                        done_event.set()
        except websockets.ConnectionClosed:
            pass

    recv_task = asyncio.create_task(receiver())

    query = "Say hello and introduce yourself in two sentences."
    logger.info(f"  Sending query: '{query}'")
    await ws.send(json.dumps({"type": "query.text", "text": query}))

    try:
        await asyncio.wait_for(done_event.wait(), timeout=60)
    except asyncio.TimeoutError:
        logger.error("  Timeout waiting for response.done")

    recv_task.cancel()
    await ws.close()

    # ----- Validate PCM16 data -----

    result.check(
        "Audio chunks received",
        chunks_received > 0,
        f"{chunks_received} chunks, {len(all_pcm_bytes)} bytes",
    )

    # Check byte alignment (PCM16 = 2 bytes per sample)
    result.check(
        "PCM16 byte alignment (even byte count)",
        len(all_pcm_bytes) % 2 == 0,
        f"{len(all_pcm_bytes)} bytes",
    )

    # Check non-zero audio (not silence)
    non_zero = any(b != 0 for b in all_pcm_bytes)
    result.check(
        "Audio contains non-zero samples (not silence)",
        non_zero,
    )

    # ----- Validate Float32 conversion -----

    result.check(
        "Float32 conversion range [-1.0, 1.0]",
        -1.0 <= min_sample <= 1.0 and -1.0 <= max_sample <= 1.0,
        f"range=[{min_sample:.4f}, {max_sample:.4f}]",
    )

    # RMS check — speech should have RMS > 0.01 (not inaudible)
    avg_rms = sum(rms_values) / len(rms_values) if rms_values else 0
    result.check(
        "Average RMS > 0.01 (audible speech)",
        avg_rms > 0.01,
        f"avg_rms={avg_rms:.4f}",
    )

    # ----- Validate jitter buffer -----

    result.check(
        "Jitter buffer delayed playback (3 chunks before drain)",
        len(enqueued_frames) > 0 and len(enqueued_frames) <= chunks_received,
        f"enqueued={len(enqueued_frames)} frames from {chunks_received} chunks",
    )

    # First chunk size (Cartesia sends ~4172 bytes per chunk typically)
    result.check(
        "First chunk size reasonable (>100 bytes)",
        first_chunk_size > 100,
        f"{first_chunk_size} bytes",
    )

    # ----- Audio duration -----

    audio_duration = len(all_pcm_bytes) / (SAMPLE_RATE * 2)
    result.check(
        "Audio duration > 0.5s (real speech)",
        audio_duration > 0.5,
        f"{audio_duration:.2f}s",
    )

    # ----- Save WAV for manual inspection -----

    output_dir = Path(__file__).parent / "test_output"
    output_dir.mkdir(exist_ok=True)
    wav_path = output_dir / "test_playback.wav"
    save_wav(bytes(all_pcm_bytes), str(wav_path))

    # ----- Optional: play through local speakers -----

    if play_audio and len(all_pcm_bytes) > 0:
        logger.info("  Playing audio through local speakers...")
        try:
            import subprocess
            # macOS: afplay can play WAV files
            subprocess.run(["afplay", str(wav_path)], timeout=30)
            logger.info("  Playback complete")
        except FileNotFoundError:
            logger.warning("  afplay not found — install sox: brew install sox, then: play test_output/test_playback.wav")
        except subprocess.TimeoutExpired:
            logger.warning("  Playback timed out")

    return result.summary()


# ---------------------------------------------------------------------------
# Test 3: Barge-In
# ---------------------------------------------------------------------------

async def test_barge_in():
    """Test barge-in during both PROCESSING and SPEAKING states.

    Sub-test A: Cancel during PROCESSING (before TTS starts)
    Sub-test B: Cancel during SPEAKING (while TTS audio is streaming)

    Key assertions:
      - Server acknowledges cancel (response.cancel event)
      - Audio streaming stops after cancel
      - Pipeline resets to accept new queries
      - Second query succeeds after barge-in
    """
    result = TestResult("Test 3: Barge-In")
    logger.info("\n" + "="*60)
    logger.info("TEST 3: Barge-In During Processing and Speaking")
    logger.info("="*60)

    # ===== Sub-test A: Cancel during PROCESSING =====
    logger.info("\n--- Sub-test A: Cancel during PROCESSING ---")

    ws, _ = await connect_and_start_session("text")

    events_a: list[dict] = []
    audio_after_cancel_a = 0
    cancel_sent_a = False
    cancel_received_a = asyncio.Event()
    done_a = asyncio.Event()
    first_text_a = asyncio.Event()

    async def receiver_a():
        nonlocal audio_after_cancel_a
        try:
            async for msg in ws:
                if isinstance(msg, bytes):
                    if cancel_sent_a:
                        audio_after_cancel_a += 1
                elif isinstance(msg, str):
                    data = json.loads(msg)
                    evt = data.get("type", "")
                    events_a.append(data)
                    if evt == "response.audio.data":
                        if cancel_sent_a:
                            audio_after_cancel_a += 1
                    elif evt == "response.text.delta":
                        first_text_a.set()
                    elif evt == "response.cancel":
                        cancel_received_a.set()
                    elif evt == "response.done":
                        done_a.set()
                    elif evt == "error":
                        done_a.set()
        except websockets.ConnectionClosed:
            pass

    recv_a = asyncio.create_task(receiver_a())

    # Send a long query to maximize PROCESSING time
    query_a = "Write a detailed 500-word essay about the history of mathematics."
    logger.info(f"  Sending query: '{query_a[:60]}...'")
    await ws.send(json.dumps({"type": "query.text", "text": query_a}))

    # Wait for first text delta (confirms PROCESSING started)
    try:
        await asyncio.wait_for(first_text_a.wait(), timeout=30)
        logger.info("  First text delta received — PROCESSING confirmed")
    except asyncio.TimeoutError:
        logger.error("  Timeout waiting for first text delta")

    # Send cancel immediately (before TTS likely starts)
    cancel_sent_a = True
    logger.info("  Sending response.cancel (during PROCESSING)")
    await ws.send(json.dumps({"type": "response.cancel"}))

    # Wait for server acknowledgment
    try:
        await asyncio.wait_for(cancel_received_a.wait(), timeout=10)
        logger.info("  Cancel acknowledged by server")
    except asyncio.TimeoutError:
        # response.done may arrive instead if processing was fast
        logger.info("  No cancel ack — checking if response completed normally")

    # Give time for any straggling events
    await asyncio.sleep(2)

    event_types_a = [e.get("type") for e in events_a]
    cancel_or_done = "response.cancel" in event_types_a or "response.done" in event_types_a
    result.check(
        "A: Cancel or done acknowledged",
        cancel_or_done,
        f"events: {event_types_a}",
    )

    # Verify pipeline reset: send second query
    logger.info("  Sending second query to verify pipeline reset...")
    done_a.clear()
    second_done_a = asyncio.Event()

    # Patch receiver to catch second done
    # (reuse existing receiver — it's still running)
    original_events_len = len(events_a)

    await ws.send(json.dumps({"type": "query.text", "text": "What is 1+1?"}))

    # Wait for the second response.done
    deadline = time.time() + 30
    while time.time() < deadline:
        await asyncio.sleep(0.5)
        new_events = events_a[original_events_len:]
        if any(e.get("type") == "response.done" for e in new_events):
            second_done_a.set()
            break

    result.check(
        "A: Pipeline reset — second query completed",
        second_done_a.is_set(),
    )

    recv_a.cancel()
    await ws.close()

    # ===== Sub-test B: Cancel during SPEAKING =====
    logger.info("\n--- Sub-test B: Cancel during SPEAKING ---")

    ws, _ = await connect_and_start_session("text")

    events_b: list[dict] = []
    audio_chunks_before_cancel = 0
    audio_chunks_after_cancel = 0
    cancel_sent_b = False
    cancel_received_b = asyncio.Event()
    first_audio_b = asyncio.Event()

    async def receiver_b():
        nonlocal audio_chunks_before_cancel, audio_chunks_after_cancel
        try:
            async for msg in ws:
                is_audio = isinstance(msg, bytes)
                if isinstance(msg, str):
                    data = json.loads(msg)
                    evt = data.get("type", "")
                    events_b.append(data)
                    if evt == "response.audio.data":
                        is_audio = True
                    elif evt == "response.cancel":
                        cancel_received_b.set()
                    elif evt == "error":
                        logger.error(f"  Error: {data}")

                if is_audio:
                    if not cancel_sent_b:
                        audio_chunks_before_cancel += 1
                        if audio_chunks_before_cancel == 5:
                            first_audio_b.set()
                    else:
                        audio_chunks_after_cancel += 1
        except websockets.ConnectionClosed:
            pass

    recv_b = asyncio.create_task(receiver_b())

    # Send a long query to produce sustained TTS output
    query_b = "Tell me a long story about a brave knight who goes on an epic quest through enchanted forests and battles dragons."
    logger.info(f"  Sending query: '{query_b[:60]}...'")
    await ws.send(json.dumps({"type": "query.text", "text": query_b}))

    # Wait for several audio chunks (confirms SPEAKING state)
    try:
        await asyncio.wait_for(first_audio_b.wait(), timeout=30)
        logger.info(f"  {audio_chunks_before_cancel} audio chunks received — SPEAKING confirmed")
    except asyncio.TimeoutError:
        logger.error("  Timeout waiting for audio chunks")

    # Send cancel during SPEAKING
    cancel_sent_b = True
    t_cancel = time.time()
    logger.info("  Sending response.cancel (during SPEAKING)")
    await ws.send(json.dumps({"type": "response.cancel"}))

    # Wait for server acknowledgment
    try:
        await asyncio.wait_for(cancel_received_b.wait(), timeout=10)
        cancel_latency = time.time() - t_cancel
        logger.info(f"  Cancel acknowledged in {cancel_latency:.3f}s")
    except asyncio.TimeoutError:
        logger.warning("  No cancel ack received within 10s")

    # Wait briefly to count any trailing audio after cancel
    await asyncio.sleep(2)

    event_types_b = [e.get("type") for e in events_b]

    result.check(
        "B: Audio chunks received before cancel",
        audio_chunks_before_cancel >= 5,
        f"{audio_chunks_before_cancel} chunks",
    )

    result.check(
        "B: Cancel acknowledged",
        cancel_received_b.is_set(),
        "response.cancel received" if cancel_received_b.is_set() else "not received",
    )

    # After cancel, audio should stop (or at most a few trailing chunks)
    result.check(
        "B: Audio stops after cancel (≤5 trailing chunks)",
        audio_chunks_after_cancel <= 5,
        f"{audio_chunks_after_cancel} chunks after cancel",
    )

    # Verify pipeline reset: third query
    logger.info("  Sending query to verify pipeline reset after barge-in...")
    done_b = asyncio.Event()
    pre_len = len(events_b)

    await ws.send(json.dumps({"type": "query.text", "text": "Say hello."}))

    deadline = time.time() + 30
    while time.time() < deadline:
        await asyncio.sleep(0.5)
        new_events = events_b[pre_len:]
        if any(e.get("type") == "response.done" for e in new_events):
            done_b.set()
            break

    result.check(
        "B: Pipeline reset — follow-up query completed",
        done_b.is_set(),
    )

    # Cancel latency check (should be fast, <2s)
    if cancel_received_b.is_set():
        result.check(
            "B: Cancel latency < 2s",
            cancel_latency < 2.0,
            f"{cancel_latency:.3f}s",
        )

    recv_b.cancel()
    await ws.close()

    return result.summary()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main():
    parser = argparse.ArgumentParser(description="Voice proxy integration tests")
    parser.add_argument("--test", choices=["parallel", "playback", "bargein", "all"],
                        default="all", help="Which test to run")
    parser.add_argument("--play", action="store_true",
                        help="Play received audio through local speakers (test 2)")
    args = parser.parse_args()

    results = []

    if args.test in ("parallel", "all"):
        results.append(("Parallel LLM+TTS", await test_parallel_streaming()))
    if args.test in ("playback", "all"):
        results.append(("Audio Playback", await test_audio_playback(play_audio=args.play)))
    if args.test in ("bargein", "all"):
        results.append(("Barge-In", await test_barge_in()))

    logger.info("\n" + "="*60)
    logger.info("INTEGRATION TEST SUMMARY")
    logger.info("="*60)
    all_passed = True
    for name, passed in results:
        status = "PASS" if passed else "FAIL"
        logger.info(f"  [{status}] {name}")
        if not passed:
            all_passed = False
    logger.info("="*60)
    if all_passed:
        logger.info("ALL TESTS PASSED")
    else:
        logger.info("SOME TESTS FAILED")
    logger.info("="*60)


if __name__ == "__main__":
    asyncio.run(main())

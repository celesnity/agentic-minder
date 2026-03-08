"""Quick diagnostic: feed Cartesia TTS audio through VAD and print probabilities."""
import asyncio
import numpy as np
import config
from vad import SileroVAD, _SileroOnnxModel, _SILERO_ONNX_PATH

async def main():
    from cartesia import AsyncCartesia
    client = AsyncCartesia(api_key=config.CARTESIA_API_KEY)

    print("Generating speech audio...")
    pcm_data = bytearray()
    stream = await client.tts.sse(
        model_id="sonic-2",
        transcript="Hello, who are you?",
        voice={"mode": "id", "id": config.CARTESIA_VOICE_ID},
        output_format={"container": "raw", "encoding": "pcm_s16le", "sample_rate": 16000},
    )
    async for event in stream:
        if hasattr(event, "audio") and event.audio:
            pcm_data.extend(event.audio)
        elif hasattr(event, "data") and event.data:
            pcm_data.extend(event.data)

    pcm = bytes(pcm_data)
    duration = len(pcm) / (16000 * 2)
    print(f"Audio: {len(pcm)} bytes, {duration:.2f}s")

    # Direct model test — feed 256-sample chunks and print probabilities
    model = _SileroOnnxModel(_SILERO_ONNX_PATH)
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0

    print(f"\n--- Raw model probabilities (256-sample chunks) ---")
    chunk_size = 256
    for i in range(0, len(samples) - chunk_size + 1, chunk_size):
        chunk = samples[i:i + chunk_size]
        prob = model(chunk)
        time_ms = (i + chunk_size) * 1000 / 16000
        if prob > 0.01:  # Only print non-trivial
            print(f"  {time_ms:6.0f}ms: prob={prob:.4f} {'*** SPEECH' if prob >= 0.5 else ''}")

    # Now test through full VAD state machine
    print(f"\n--- Full VAD state machine (320-sample input frames) ---")
    vad = SileroVAD()
    frame_bytes = 320 * 2
    frame_count = 0

    for offset in range(0, len(pcm) - frame_bytes + 1, frame_bytes):
        frame = pcm[offset:offset + frame_bytes]
        result = vad.process(frame)
        frame_count += 1
        if result:
            print(f"  Frame {frame_count} ({frame_count * 20}ms): {result}")

    # Silence
    silence = b"\x00" * frame_bytes
    for i in range(75):
        result = vad.process(silence)
        frame_count += 1
        if result:
            print(f"  Frame {frame_count} ({frame_count * 20}ms): {result}")

    print(f"\nFinal VAD state: {vad.state}")

asyncio.run(main())

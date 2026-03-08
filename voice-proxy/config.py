"""Voice proxy server configuration."""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

# Server
HOST = os.getenv("VOICE_PROXY_HOST", "0.0.0.0")
PORT = int(os.getenv("VOICE_PROXY_PORT", "8765"))

# OpenClaw
OPENCLAW_URL = os.getenv("OPENCLAW_URL", "ws://127.0.0.1:18789")
OPENCLAW_TOKEN = os.getenv("OPENCLAW_TOKEN", "celesnity-minder")
OPENCLAW_CLIENT_ID = "gateway-client"

# Audio
SAMPLE_RATE = 16000
CHANNELS = 1
FRAME_SIZE = 320  # 20ms at 16kHz (Spectacles audio frame)
FRAME_BYTES = FRAME_SIZE * 2  # PCM16 = 2 bytes per sample
VAD_FRAME_SIZE = 256  # 16ms at 16kHz (Silero VAD optimal frame size)

# VAD (Silero)
VAD_ACTIVATION_THRESHOLD = 0.5
VAD_MIN_SPEECH_DURATION = 0.05  # 50ms
VAD_MIN_SILENCE_DURATION = 0.55  # 550ms
VAD_PREFIX_PADDING = 0.5  # 500ms

# ASR (Deepgram)
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY", "")

# TTS (Cartesia)
CARTESIA_API_KEY = os.getenv("CARTESIA_API_KEY", "")
CARTESIA_VOICE_ID = os.getenv("CARTESIA_VOICE_ID", "a0e99841-438c-4a64-b679-ae501e7d6091")

# Barge-in
BARGE_IN_MIN_DURATION = 0.5  # 500ms sustained speech
FALSE_INTERRUPT_TIMEOUT = 2.0  # Wait for real words
BARGE_IN_CONFIDENCE_THRESHOLD = 0.6

# TTS Pacing
TTS_MIN_REMAINING_AUDIO = 3.0  # seconds
TTS_MAX_TEXT_LENGTH = 300  # chars per TTS request
TTS_MIN_SENTENCE_LENGTH = 20  # chars

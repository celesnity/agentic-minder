"""
Silero VAD wrapper with 4-state detection using ONNX Runtime directly.

States: QUIET → STARTING → SPEAKING → STOPPING → QUIET

Loads the Silero VAD ONNX model directly — no torchaudio dependency.
Requires: onnxruntime, numpy.

Production-tested parameters from LiveKit agents SDK:
- activation_threshold: 0.5
- min_speech_duration: 50ms
- min_silence_duration: 550ms
- prefix_padding: 500ms

Note: Silero VAD v5 expects 256-sample chunks at 16kHz.
      Incoming audio frames (320 samples / 20ms) are re-chunked internally.
"""

import logging
import os

import numpy as np
import onnxruntime as ort

import config

logger = logging.getLogger("vad")

# Path to the cached Silero VAD ONNX model
_SILERO_ONNX_PATH = os.path.expanduser(
    "~/.cache/torch/hub/snakers4_silero-vad_master/src/silero_vad/data/silero_vad.onnx"
)


class VADState:
    QUIET = "quiet"
    STARTING = "starting"
    SPEAKING = "speaking"
    STOPPING = "stopping"


class _SileroOnnxModel:
    """Minimal ONNX wrapper for Silero VAD (replaces torch.hub load)."""

    def __init__(self, model_path: str):
        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        self.session = ort.InferenceSession(model_path, sess_options=opts)

        # Detect state tensor shape from model inputs
        state_input = [i for i in self.session.get_inputs() if i.name == "state"][0]
        # shape is [2, batch, hidden_size] — hidden_size is typically 64 or 128
        hidden_size = state_input.shape[2] if isinstance(state_input.shape[2], int) else 128
        self._hidden_size = hidden_size

        # Internal state tensor (Silero VAD is stateful — LSTM hidden states)
        self._state = np.zeros((2, 1, hidden_size), dtype=np.float32)
        self._sr = np.array(config.SAMPLE_RATE, dtype=np.int64)

    def __call__(self, audio: np.ndarray) -> float:
        """Run VAD on a float32 audio chunk. Returns speech probability [0, 1]."""
        # Silero expects shape (1, num_samples)
        if audio.ndim == 1:
            audio = audio[np.newaxis, :]

        ort_inputs = {
            "input": audio.astype(np.float32),
            "state": self._state,
            "sr": self._sr,
        }
        out, state_new = self.session.run(None, ort_inputs)
        self._state = state_new

        return float(out.squeeze())

    def reset_states(self):
        """Reset LSTM hidden states."""
        self._state = np.zeros((2, 1, self._hidden_size), dtype=np.float32)


class SileroVAD:
    def __init__(self, model_path: str | None = None):
        path = model_path or _SILERO_ONNX_PATH
        if not os.path.exists(path):
            raise FileNotFoundError(
                f"Silero VAD ONNX model not found at {path}. "
                "Download from https://github.com/snakers4/silero-vad"
            )

        self.model = _SileroOnnxModel(path)

        # State
        self.state = VADState.QUIET
        self.state_duration = 0.0  # seconds in current state

        # Config
        self.activation_threshold = config.VAD_ACTIVATION_THRESHOLD
        self.min_speech_duration = config.VAD_MIN_SPEECH_DURATION  # 50ms
        self.min_silence_duration = config.VAD_MIN_SILENCE_DURATION  # 550ms

        # VAD frame size (256 samples = 16ms at 16kHz)
        self.vad_frame_size = config.VAD_FRAME_SIZE
        self.vad_frame_duration = self.vad_frame_size / config.SAMPLE_RATE

        # Re-chunking buffer for converting incoming frames to VAD-sized chunks
        self._sample_buffer = np.array([], dtype=np.float32)

        # Sliding window of recent probabilities for smoothed speech detection
        self._prob_window = 5  # ~80ms window (5 × 16ms frames)
        self._prob_ring = np.zeros(self._prob_window, dtype=np.float32)
        self._prob_idx = 0
        self._start_grace = 0.0  # grace period counter for STARTING state

        # Prefix padding buffer (captures word onsets)
        self.prefix_frames: list[bytes] = []
        input_frame_duration = config.FRAME_SIZE / config.SAMPLE_RATE
        max_prefix_frames = int(config.VAD_PREFIX_PADDING / input_frame_duration)
        self.max_prefix_frames = max_prefix_frames

        logger.info(
            f"Silero VAD initialized (ONNX): threshold={self.activation_threshold}, "
            f"min_speech={self.min_speech_duration}s, "
            f"min_silence={self.min_silence_duration}s, "
            f"prefix_padding={config.VAD_PREFIX_PADDING}s, "
            f"vad_frame={self.vad_frame_size} samples"
        )

    def process(self, pcm_bytes: bytes) -> str | None:
        """
        Process a PCM16 audio frame through VAD.

        Accepts any frame size; internally re-chunks to 256-sample
        windows for optimal Silero VAD performance.

        Returns:
            "speech_start" — when speech is confirmed (after min_speech_duration)
            "speech_end" — when silence is confirmed (after min_silence_duration)
            None — no state transition
        """
        # Convert PCM16 to float32 and append to buffer
        audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        self._sample_buffer = np.concatenate([self._sample_buffer, audio])

        # Process all complete VAD-sized chunks
        result = None
        while len(self._sample_buffer) >= self.vad_frame_size:
            chunk = self._sample_buffer[:self.vad_frame_size]
            self._sample_buffer = self._sample_buffer[self.vad_frame_size:]

            chunk_result = self._process_vad_frame(chunk)
            if chunk_result is not None:
                result = chunk_result

        # Maintain prefix buffer with original frames
        if self.state == VADState.QUIET:
            self.prefix_frames.append(pcm_bytes)
            if len(self.prefix_frames) > self.max_prefix_frames:
                self.prefix_frames.pop(0)

        return result

    def _process_vad_frame(self, audio: np.ndarray) -> str | None:
        """Process a single 256-sample VAD frame through the state machine.

        Uses a sliding window of recent probabilities to smooth decision-making.
        This handles TTS audio and microphones where per-frame probabilities
        flicker rapidly above/below the threshold.
        """
        raw_prob = self.model(audio)
        self._prob_ring[self._prob_idx % self._prob_window] = raw_prob
        self._prob_idx += 1

        # Use max of recent window for speech detection (any speech in window = speech)
        window_size = min(self._prob_idx, self._prob_window)
        recent_max = float(np.max(self._prob_ring[:window_size]))
        is_speech = recent_max >= self.activation_threshold

        result = None

        if self.state == VADState.QUIET:
            if is_speech:
                self.state = VADState.STARTING
                self.state_duration = self.vad_frame_duration

        elif self.state == VADState.STARTING:
            # In STARTING, use raw prob — we want to confirm sustained speech
            if raw_prob >= self.activation_threshold * 0.7:  # Lower threshold during starting
                self.state_duration += self.vad_frame_duration
                if self.state_duration >= self.min_speech_duration:
                    self.state = VADState.SPEAKING
                    self.state_duration = 0.0
                    result = "speech_start"
                    logger.debug("VAD: STARTING → SPEAKING (speech confirmed)")
            else:
                self._start_grace += self.vad_frame_duration
                if self._start_grace >= 0.1:  # 100ms grace
                    self.state = VADState.QUIET
                    self.state_duration = 0.0
                    self._start_grace = 0.0

        elif self.state == VADState.SPEAKING:
            # Use recent_max (ring buffer) for SPEAKING→STOPPING — more tolerant of brief dips
            if recent_max < self.activation_threshold * 0.5:
                self.state = VADState.STOPPING
                self.state_duration = self.vad_frame_duration

        elif self.state == VADState.STOPPING:
            if recent_max >= self.activation_threshold * 0.5:
                # Speech resumed
                self.state = VADState.SPEAKING
                self.state_duration = 0.0
            else:
                self.state_duration += self.vad_frame_duration
                if self.state_duration >= self.min_silence_duration:
                    self.state = VADState.QUIET
                    self.state_duration = 0.0
                    self.prefix_frames.clear()
                    result = "speech_end"
                    logger.debug("VAD: STOPPING → QUIET (silence confirmed)")

        if is_speech:
            self._start_grace = 0.0

        return result

    def is_speech(self, pcm_bytes: bytes) -> bool:
        """Simple speech check for barge-in detection (no state machine)."""
        audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        # Use first VAD-sized chunk for quick check
        if len(audio) >= self.vad_frame_size:
            probability = self.model(audio[:self.vad_frame_size])
        else:
            probability = self.model(audio)
        return probability >= self.activation_threshold

    def get_prefix_audio(self) -> list[bytes]:
        """Get buffered prefix audio frames (for word-onset capture)."""
        frames = list(self.prefix_frames)
        self.prefix_frames.clear()
        return frames

    def reset(self):
        """Reset VAD state."""
        self.state = VADState.QUIET
        self.state_duration = 0.0
        self.prefix_frames.clear()
        self._sample_buffer = np.array([], dtype=np.float32)
        self._prob_ring = np.zeros(self._prob_window, dtype=np.float32)
        self._prob_idx = 0
        self._start_grace = 0.0
        self.model.reset_states()

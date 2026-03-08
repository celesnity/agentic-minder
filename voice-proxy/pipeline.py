"""
VoicePipeline — Audio pipeline orchestrator.

Manages the full voice conversation flow:
  Audio mode:  Spectacles audio → VAD → ASR → OpenClaw → TTS → Spectacles audio
  Text mode:   Spectacles text (query.text) → OpenClaw → TTS → Spectacles audio

State machine:
  IDLE → LISTENING → COMMITTING → PROCESSING → SPEAKING → IDLE
  SPEAKING → INTERRUPTING → LISTENING (barge-in)
  Text mode: IDLE → PROCESSING → SPEAKING → IDLE
"""

import asyncio
import base64
import json
import logging
import os
import re
import time
from datetime import datetime
from pathlib import Path

from fastapi import WebSocket

import config

logger = logging.getLogger("pipeline")

# Sentence boundary: punctuation, newlines, or markdown block boundaries
SENTENCE_BOUNDARY = re.compile(r"[.!?;:]\s*$|[.!?;]\s|\n")

# Patterns to strip from text before TTS (markdown formatting)
MARKDOWN_STRIP = re.compile(r"\*\*|__|##?\s?|`{1,3}|^\|.*\|$|^-{3,}$|^\s*\|?\s*-+\s*\|", re.MULTILINE)


class PipelineState:
    IDLE = "idle"
    LISTENING = "listening"
    COMMITTING = "committing"
    PROCESSING = "processing"
    SPEAKING = "speaking"
    INTERRUPTING = "interrupting"


class VoicePipeline:
    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.state = PipelineState.IDLE
        self.session_started = False
        self.input_mode = "audio"  # "audio" or "text"

        # Components (initialized on session.start)
        self.vad = None
        self.asr = None
        self.tts = None
        self.openclaw = None

        # Streaming state
        self.token_buffer = ""
        self.tts_chars_played = 0
        self.current_response_text = ""
        self.chat_history = []

        # Barge-in state
        self.barge_in_speech_duration = 0.0
        self.false_interrupt_task: asyncio.Task | None = None

        # Visual query: pending image attachment from client
        self.pending_attachment: dict | None = None

        # Audio tracking
        self.audio_bytes_sent = 0
        self.frame_duration = config.FRAME_SIZE / config.SAMPLE_RATE  # 20ms

        # TTS queue for parallel LLM+TTS streaming
        self._tts_queue: asyncio.Queue[str | None] | None = None
        self._tts_task: asyncio.Task | None = None

        # Background processing task (so message loop stays responsive)
        self._processing_task: asyncio.Task | None = None

        # Client log file — timestamped, one per session
        self._client_log_dir = Path(__file__).parent / "logs"
        self._client_log_dir.mkdir(exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        self._client_log_file = self._client_log_dir / f"client_{ts}.log"
        self._client_log_count = 0

        logger.info(f"Pipeline created (client logs → {self._client_log_file})")

    async def handle_control_message(self, msg: dict):
        """Handle a JSON control message from Spectacles."""
        msg_type = msg.get("type", "")

        if msg_type == "session.start":
            await self._handle_session_start(msg)
        elif msg_type == "query.text":
            await self._handle_query_text(msg)
        elif msg_type == "response.cancel":
            await self._handle_cancel(msg)
        elif msg_type == "input.commit":
            await self._handle_manual_commit()
        elif msg_type == "input.attachment":
            self._handle_attachment(msg)
        elif msg_type == "client.log":
            self._handle_client_log(msg)
        else:
            logger.warning(f"Unknown control message: {msg_type}")

    async def _cancel_processing_task(self):
        """Cancel any in-flight processing task (for barge-in or new query)."""
        if self._processing_task and not self._processing_task.done():
            logger.info("Cancelling in-flight processing task")
            self.state = PipelineState.INTERRUPTING
            # Cancel TTS first
            if self.tts:
                self.tts.cancel()
            # Drain TTS queue
            if self._tts_queue:
                while not self._tts_queue.empty():
                    try:
                        self._tts_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                await self._tts_queue.put(None)
            # Abort OpenClaw
            if self.openclaw:
                await self.openclaw.abort()
            # Wait for task to finish
            try:
                await asyncio.wait_for(self._processing_task, timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._processing_task.cancel()
                try:
                    await self._processing_task
                except asyncio.CancelledError:
                    pass
            self._processing_task = None

    async def handle_audio_frame(self, pcm_bytes: bytes):
        """Handle a binary PCM16 audio frame from Spectacles mic."""
        if not self.session_started:
            return

        # During SPEAKING state, check for barge-in
        if self.state == PipelineState.SPEAKING:
            await self._check_barge_in(pcm_bytes)
            return

        # During INTERRUPTING state, feed audio to ASR (already listening)
        if self.state == PipelineState.INTERRUPTING:
            if self.asr:
                await self.asr.feed_audio(pcm_bytes)
            return

        # Process through VAD
        if not self.vad:
            return

        vad_result = self.vad.process(pcm_bytes)

        if vad_result == "speech_start" and self.state == PipelineState.IDLE:
            self.state = PipelineState.LISTENING
            logger.info("VAD: speech_start → LISTENING")
            if self.asr:
                await self.asr.start_stream()
            await self._send_json({"type": "vad.speech_start"})

        if self.state == PipelineState.LISTENING:
            if self.asr:
                await self.asr.feed_audio(pcm_bytes)

        if vad_result == "speech_end" and self.state == PipelineState.LISTENING:
            self.state = PipelineState.COMMITTING
            logger.info("VAD: speech_end → COMMITTING")
            await self._send_json({"type": "vad.speech_end"})
            # Phase 1: immediate commit (no turn detector)
            await self._commit_turn()

    async def _handle_session_start(self, msg: dict):
        """Initialize the voice session with configured components."""
        session_config = msg.get("config", {})
        self.input_mode = session_config.get("inputMode", "audio")
        logger.info(f"Session starting: inputMode={self.input_mode} config={session_config}")

        # Initialize components lazily
        await self._init_components()

        # Report component failures to client
        failures = []
        if self.input_mode == "audio":
            if not self.vad:
                failures.append("vad")
            if not self.asr:
                failures.append("asr")
        if not self.tts:
            failures.append("tts")
        if not self.openclaw:
            failures.append("openclaw")

        self.session_started = True
        self.state = PipelineState.IDLE

        session_config_response = {
            "sampleRate": config.SAMPLE_RATE,
            "channels": config.CHANNELS,
            "encoding": "pcm16",
            "inputMode": self.input_mode,
        }
        if self.input_mode == "audio":
            session_config_response["vadMode"] = "server"
        if failures:
            session_config_response["degraded"] = failures
            logger.warning(f"Session started in degraded mode: {failures}")

        await self._send_json({
            "type": "session.started",
            "config": session_config_response,
        })
        logger.info(f"Session started ({self.input_mode} mode) → IDLE")

    async def _handle_query_text(self, msg: dict):
        """Handle a text query from Spectacles (hybrid mode — ASR done on-device)."""
        text = msg.get("text", "").strip()
        if not text:
            logger.warning("Empty query.text received")
            return

        logger.info(f"Query text: '{text}' (state={self.state})")

        # Cancel any in-flight processing (barge-in on new query)
        if self.state not in (PipelineState.IDLE, PipelineState.LISTENING):
            logger.info(f"New query while {self.state} — cancelling previous")
            await self._cancel_processing_task()

        # Handle inline attachment (visual query)
        attachment = msg.get("attachment")
        attachments = None
        if attachment:
            self.pending_attachment = {
                "type": "image",
                "mimeType": attachment.get("mimeType", "image/jpeg"),
                "content": attachment.get("data", ""),
            }
            logger.info(f"Inline attachment: {attachment.get('mimeType')}")

        # Consume pending attachment
        if self.pending_attachment:
            attachments = [self.pending_attachment]
            self.pending_attachment = None

        # Send transcript event to client for chat UI
        await self._send_json({
            "type": "transcript.final",
            "text": text,
        })

        self.state = PipelineState.PROCESSING

        # Run processing as a background task so the message loop stays responsive
        # This allows barge-in (response.cancel) and new queries to be processed
        self._processing_task = asyncio.create_task(
            self._process_with_openclaw(text, attachments)
        )

    async def _init_components(self):
        """Initialize VAD, ASR, TTS, and OpenClaw client.

        In text input mode, VAD and ASR are skipped (ASR runs on-device).
        """
        if self.input_mode == "audio":
            try:
                from vad import SileroVAD
                self.vad = SileroVAD()
                logger.info("VAD initialized")
            except Exception as e:
                logger.error(f"VAD init failed: {e}")

            try:
                from asr import DeepgramASR
                self.asr = DeepgramASR()
                logger.info("ASR initialized")
            except Exception as e:
                logger.error(f"ASR init failed: {e}")
        else:
            logger.info("Text input mode — skipping VAD/ASR initialization")

        try:
            from tts import CartesiaTTS
            self.tts = CartesiaTTS()
            await self.tts.warmup()
            logger.info("TTS initialized (WebSocket pre-connected)")
        except Exception as e:
            logger.error(f"TTS init failed: {e}")

        try:
            from openclaw_client import OpenClawClient
            self.openclaw = OpenClawClient(config.OPENCLAW_URL, config.OPENCLAW_TOKEN)
            await self.openclaw.connect()
            logger.info("OpenClaw client connected")
        except Exception as e:
            logger.error(f"OpenClaw init failed: {e}")

    async def _commit_turn(self):
        """Commit the current ASR transcript to the LLM."""
        self.state = PipelineState.PROCESSING

        transcript = ""
        if self.asr:
            transcript = await self.asr.finalize()

        if not transcript.strip():
            logger.info("Empty transcript, returning to IDLE")
            self.state = PipelineState.IDLE
            return

        logger.info(f"Transcript: '{transcript}'")
        await self._send_json({
            "type": "transcript.final",
            "text": transcript,
        })

        # Consume pending attachment (if any)
        attachments = None
        if self.pending_attachment:
            attachments = [self.pending_attachment]
            self.pending_attachment = None
            logger.info("Including image attachment in query")

        # Send to OpenClaw and stream TTS
        await self._process_with_openclaw(transcript, attachments)

    async def _process_with_openclaw(self, text: str, attachments: list | None = None):
        """Send transcript to OpenClaw, stream response through TTS in parallel.

        Producer: LLM token loop accumulates tokens, detects sentence boundaries,
                  pushes complete sentences to a TTS queue.
        Consumer: Background task pulls sentences from queue, synthesizes and sends audio.
        """
        if not self.openclaw:
            logger.error("No OpenClaw client — cannot process")
            await self._send_json({"type": "error", "code": 503, "message": "OpenClaw not connected"})
            self.state = PipelineState.IDLE
            return

        # Reconnect OpenClaw if disconnected
        if not self.openclaw.connected:
            logger.info("OpenClaw disconnected — attempting reconnect")
            try:
                await self.openclaw.connect()
                logger.info("OpenClaw reconnected")
            except Exception as e:
                logger.error(f"OpenClaw reconnect failed: {e}")
                await self._send_json({"type": "error", "code": 503, "message": "OpenClaw reconnect failed"})
                self.state = PipelineState.IDLE
                return

        self.token_buffer = ""
        self.current_response_text = ""
        self.tts_chars_played = 0
        self.audio_bytes_sent = 0
        t0 = time.time()

        # Start TTS consumer task
        self._tts_queue = asyncio.Queue()
        self._tts_task = asyncio.create_task(self._tts_consumer())

        first_text = True
        first_tts = True
        try:
            async for token in self.openclaw.chat_send_streaming(text, attachments=attachments):
                if self.state == PipelineState.INTERRUPTING:
                    logger.info("Interrupted during OpenClaw streaming")
                    break

                if first_text:
                    logger.info(f"[TIMING] first text delta: +{time.time()-t0:.3f}s")
                    first_text = False

                self.token_buffer += token
                self.current_response_text += token

                # Send text delta to client for chat UI
                await self._send_json({
                    "type": "response.text.delta",
                    "delta": token,
                    "accumulated": self.current_response_text,
                })

                # Check for sentence boundary — push to TTS queue (non-blocking)
                if len(self.token_buffer) >= config.TTS_MIN_SENTENCE_LENGTH and \
                   SENTENCE_BOUNDARY.search(self.token_buffer):
                    sentence = self._clean_for_tts(self.token_buffer)
                    self.token_buffer = ""
                    if sentence and self.tts:
                        if first_tts:
                            logger.info(f"[TIMING] first sentence to TTS: +{time.time()-t0:.3f}s ({len(sentence)} chars)")
                            first_tts = False
                        await self._tts_queue.put(sentence)

            # Flush remaining tokens
            remaining = self._clean_for_tts(self.token_buffer)
            if remaining and self.state != PipelineState.INTERRUPTING and self.tts:
                await self._tts_queue.put(remaining)

        except Exception as e:
            logger.error(f"OpenClaw processing error: {e}")
            await self._send_json({"type": "error", "code": 500, "message": str(e)})

        # Signal TTS consumer to finish
        if self._tts_queue:
            await self._tts_queue.put(None)

        # Wait for TTS consumer to drain all queued sentences
        if self._tts_task:
            try:
                await self._tts_task
            except Exception as e:
                logger.error(f"TTS consumer error: {e}")

        self._tts_queue = None
        self._tts_task = None

        if self.state != PipelineState.INTERRUPTING:
            elapsed = time.time() - t0
            self.chat_history.append({
                "role": "assistant",
                "content": self.current_response_text,
            })
            await self._send_json({
                "type": "response.done",
                "text": self.current_response_text,
            })
            self.state = PipelineState.IDLE
            logger.info(f"Response complete → IDLE (total={elapsed:.2f}s, audio={self.audio_bytes_sent}B, text={len(self.current_response_text)}ch)")
        else:
            logger.info("Response interrupted — not sending response.done")

    async def _tts_consumer(self):
        """Background task: pull sentences from queue and synthesize TTS.

        Runs in parallel with the LLM token producer — while sentence N is
        being synthesized, the LLM keeps generating tokens for sentence N+1.
        """
        first_audio_sent = False

        while True:
            try:
                sentence = await self._tts_queue.get()
            except asyncio.CancelledError:
                break

            if sentence is None:
                break

            if self.state == PipelineState.INTERRUPTING:
                break

            if not first_audio_sent:
                self.state = PipelineState.SPEAKING
                await self._send_json({"type": "response.audio.start",
                                       "sampleRate": config.SAMPLE_RATE})
                first_audio_sent = True

            await self._synthesize_and_send(sentence)

    @staticmethod
    def _clean_for_tts(text: str) -> str:
        """Strip markdown formatting and non-speakable content for TTS."""
        cleaned = MARKDOWN_STRIP.sub("", text)
        # Collapse multiple whitespace/newlines
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        return cleaned

    async def _synthesize_and_send(self, text: str):
        """Synthesize text to speech and send audio to client.

        Sends BOTH binary frames (standard) and Base64 JSON (Snap-compatible fallback).
        The client will use whichever path works in its runtime.
        """
        if not self.tts:
            return

        first_chunk = True
        t_start = time.time()
        async for audio_chunk in self.tts.synthesize_streaming(text):
            if self.state == PipelineState.INTERRUPTING:
                break
            if first_chunk:
                logger.info(f"[TIMING] TTS first chunk: {time.time()-t_start:.3f}s after request")
                first_chunk = False
            try:
                # Send as Base64 JSON text frame (proven path in Snap AI Playground)
                b64 = base64.b64encode(audio_chunk).decode("ascii")
                await self.ws.send_text(json.dumps({
                    "type": "response.audio.data",
                    "data": b64,
                }))
                self.audio_bytes_sent += len(audio_chunk)
                self.tts_chars_played += len(text)
            except Exception as e:
                logger.error(f"Failed to send audio: {e}")
                break

    async def _check_barge_in(self, pcm_bytes: bytes):
        """Check if user is speaking during agent response (barge-in)."""
        if not self.vad:
            return

        # Use VAD to check if this frame contains speech
        is_speech = self.vad.is_speech(pcm_bytes)

        if is_speech:
            self.barge_in_speech_duration += self.frame_duration
            if self.barge_in_speech_duration >= config.BARGE_IN_MIN_DURATION:
                logger.info(f"Barge-in detected ({self.barge_in_speech_duration:.2f}s)")
                await self._execute_barge_in()
        else:
            self.barge_in_speech_duration = 0.0

    async def _execute_barge_in(self):
        """Execute barge-in: cancel everything, start listening."""
        self.state = PipelineState.INTERRUPTING
        self.barge_in_speech_duration = 0.0

        # 1. Abort OpenClaw generation
        if self.openclaw:
            await self.openclaw.abort()

        # 2. Cancel TTS and drain TTS queue
        if self.tts:
            self.tts.cancel()
        if self._tts_queue:
            # Drain remaining sentences and signal consumer to stop
            while not self._tts_queue.empty():
                try:
                    self._tts_queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
            await self._tts_queue.put(None)

        # 3. Tell client to flush audio
        await self._send_json({
            "type": "response.cancel",
            "interrupted_at": self.tts_chars_played,
        })

        # 4. Truncate chat history to what user heard
        if self.chat_history and self.current_response_text:
            heard = self.current_response_text[:self.tts_chars_played]
            self.chat_history[-1]["content"] = heard + " [interrupted]"

        # 5. Start new ASR session
        if self.asr:
            await self.asr.start_stream()

        # 6. Start false interruption detection
        self.false_interrupt_task = asyncio.create_task(
            self._check_false_interruption()
        )

        self.state = PipelineState.LISTENING
        logger.info("Barge-in executed → LISTENING")

    async def _check_false_interruption(self):
        """Wait for real words after barge-in; auto-resume if false positive."""
        await asyncio.sleep(config.FALSE_INTERRUPT_TIMEOUT)

        if self.asr and not self.asr.has_words:
            logger.info("False interruption detected — no words in ASR")
            await self._send_json({"type": "agent.false_interruption"})
            # Future: could auto-resume speech here

    async def _handle_cancel(self, msg: dict):
        """Handle explicit cancel from client (barge-in)."""
        if self.state in (PipelineState.SPEAKING, PipelineState.PROCESSING):
            logger.info(f"Cancel requested (state={self.state})")
            await self._cancel_processing_task()
            await self._send_json({
                "type": "response.cancel",
                "interrupted_at": self.tts_chars_played,
            })
            self.state = PipelineState.IDLE
            logger.info("Cancel complete → IDLE")

    async def _handle_manual_commit(self):
        """Handle explicit end-of-utterance from client."""
        if self.state == PipelineState.LISTENING:
            await self._send_json({"type": "vad.speech_end"})
            self.state = PipelineState.COMMITTING
            await self._commit_turn()

    def _handle_attachment(self, msg: dict):
        """Store a pending image attachment from client for the next query."""
        data = msg.get("data")
        mime_type = msg.get("mimeType", "image/jpeg")
        if data:
            self.pending_attachment = {"type": "image", "mimeType": mime_type, "content": data}
            logger.info(f"Attachment received: {mime_type}, {len(data)} chars")

    def _handle_client_log(self, msg: dict):
        """Write client-side logs to a persistent file."""
        lines = msg.get("lines", [])
        if not lines:
            return

        try:
            with open(self._client_log_file, "a") as f:
                for line in lines:
                    f.write(line + "\n")
            self._client_log_count += len(lines)

            if self._client_log_count <= len(lines):
                logger.info(f"Client logs started → {self._client_log_file}")
        except Exception as e:
            logger.error(f"Failed to write client logs: {e}")

    async def _send_json(self, msg: dict):
        """Send a JSON control message to the client."""
        try:
            await self.ws.send_text(json.dumps(msg))
        except Exception as e:
            logger.error(f"Failed to send JSON: {e}")

    async def cleanup(self):
        """Clean up all resources."""
        if self._processing_task and not self._processing_task.done():
            self._processing_task.cancel()
            try:
                await self._processing_task
            except asyncio.CancelledError:
                pass

        if self._tts_task and not self._tts_task.done():
            self._tts_task.cancel()
            try:
                await self._tts_task
            except asyncio.CancelledError:
                pass

        if self.false_interrupt_task and not self.false_interrupt_task.done():
            self.false_interrupt_task.cancel()

        if self.openclaw:
            await self.openclaw.disconnect()

        if self.asr:
            await self.asr.close()

        if self.tts:
            self.tts.close()

        logger.info("Pipeline cleaned up")

"""
Streaming ASR client using Deepgram WebSocket API directly.

Opens a WebSocket to Deepgram for real-time transcription.
Feeds PCM16 audio frames, receives partial + final transcripts.

Uses raw websockets instead of the Deepgram SDK to avoid
sync/async timing issues in our async pipeline.
"""

import asyncio
import json
import logging
import ssl

import certifi
import websockets

import config

logger = logging.getLogger("asr")

DEEPGRAM_WS_URL = "wss://api.deepgram.com/v1/listen"


class DeepgramASR:
    def __init__(self):
        if not config.DEEPGRAM_API_KEY:
            raise ValueError("DEEPGRAM_API_KEY not set")

        self.api_key = config.DEEPGRAM_API_KEY
        self._ws = None
        self._receive_task: asyncio.Task | None = None
        self.transcript_buffer = ""
        self.final_transcript = ""
        self.has_words = False
        self._finalize_event = asyncio.Event()

    async def start_stream(self):
        """Start a new ASR streaming session."""
        self.transcript_buffer = ""
        self.final_transcript = ""
        self.has_words = False
        self._finalize_event.clear()

        params = (
            f"model=nova-3"
            f"&encoding=linear16"
            f"&sample_rate={config.SAMPLE_RATE}"
            f"&channels={config.CHANNELS}"
            f"&smart_format=true"
            f"&interim_results=true"
            f"&utterance_end_ms=1000"
            f"&vad_events=false"
        )
        url = f"{DEEPGRAM_WS_URL}?{params}"

        try:
            ssl_ctx = ssl.create_default_context(cafile=certifi.where())
            self._ws = await websockets.connect(
                url,
                additional_headers={"Authorization": f"Token {self.api_key}"},
                ssl=ssl_ctx,
            )
            self._receive_task = asyncio.create_task(self._receive_loop())
            logger.info("ASR stream started")
        except Exception as e:
            logger.error(f"Failed to start ASR stream: {e}")
            self._ws = None

    async def feed_audio(self, pcm_bytes: bytes):
        """Feed a PCM16 audio frame to Deepgram."""
        if self._ws:
            try:
                await self._ws.send(pcm_bytes)
            except Exception as e:
                logger.error(f"Failed to feed audio: {e}")

    async def finalize(self) -> str:
        """Finalize the ASR stream and return the final transcript."""
        if self._ws:
            try:
                # Send close stream message
                await self._ws.send(json.dumps({"type": "CloseStream"}))
            except Exception as e:
                logger.error(f"Failed to send CloseStream: {e}")

        # Wait for final transcript
        try:
            await asyncio.wait_for(self._finalize_event.wait(), timeout=3.0)
        except asyncio.TimeoutError:
            pass

        result = self.final_transcript or self.transcript_buffer
        logger.info(f"ASR finalized: '{result}'")
        # Clean up in background to avoid blocking the pipeline
        asyncio.create_task(self._cleanup())
        return result.strip()

    async def close(self):
        """Close the ASR connection."""
        await self._cleanup()

    async def _cleanup(self):
        if self._receive_task and not self._receive_task.done():
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass
        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None

    async def _receive_loop(self):
        """Background loop receiving transcript events."""
        try:
            async for raw in self._ws:
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                msg_type = data.get("type", "")

                if msg_type == "Results":
                    channel = data.get("channel", {})
                    alternatives = channel.get("alternatives", [])
                    if not alternatives:
                        continue

                    transcript = alternatives[0].get("transcript", "")
                    is_final = data.get("is_final", False)
                    speech_final = data.get("speech_final", False)

                    if transcript:
                        if is_final:
                            self.final_transcript += transcript + " "
                            self.has_words = True
                            logger.debug(f"ASR final: '{transcript}'")
                        else:
                            self.transcript_buffer = transcript
                            if transcript.strip():
                                self.has_words = True
                            logger.debug(f"ASR partial: '{transcript}'")

                    if speech_final:
                        self._finalize_event.set()

                elif msg_type == "UtteranceEnd":
                    self._finalize_event.set()

                elif msg_type == "Metadata":
                    logger.debug(f"ASR metadata: {data.get('request_id', '')}")

                elif msg_type == "Error":
                    logger.error(f"ASR error: {data.get('message', data)}")

        except websockets.ConnectionClosed:
            logger.debug("ASR WebSocket closed")
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"ASR receive error: {e}")

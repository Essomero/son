# Streaming local STT — sherpa-onnx zipformer online decoder.
#
# The web-speech mode's killer feature is live interims: the transcript row
# grows while the user talks, instead of landing all at once when they stop.
# Parakeet (parakeet_stt.py) is an OfflineRecognizer — final per VAD turn,
# no partials. This module is the streaming sibling: a sherpa-onnx
# OnlineRecognizer (streaming zipformer transducer) is fed each audio chunk
# as it arrives and yields an InterimTranscriptionFrame whenever the
# hypothesis changes, so the client row drips words in real time; the
# pipeline's Silero VAD still owns turn boundaries (VADUserStarted/Stopped-
# SpeakingFrame, pushed UPSTREAM by the user aggregator), and the final
# hypothesis is pushed as a finalized TranscriptionFrame when the user stops,
# feeding the same cleanup stage as parakeet.
#
# Model files download once into ~/.cache/son/streaming on first use. Both
# models are pure-CPU ONNX (no API key, no audio leaving the box); the 100m
# export is the accuracy default, the 20m export is the snappy fallback.

import asyncio
import importlib.util
import threading
from collections.abc import AsyncGenerator
from pathlib import Path

import numpy as np
import requests
from loguru import logger

from pipecat.frames.frames import (
    Frame,
    InterimTranscriptionFrame,
    TranscriptionFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.services.stt_service import STTService
from pipecat.transcriptions.language import Language
from pipecat.utils.time import time_now_iso8601

# Model repo id → picker label. First entry = default. sherpa-onnx streaming
# zipformer exports come in chunk/context-size variants; the standard
# chunk-16-left-64 export is what sherpa's own streaming examples use.
STREAMING_MODELS = {
    "csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26": "streaming-zipformer-100m · local",
    "csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17": "streaming-zipformer-20m · local",
}
STREAMING_MODEL_FILES = {
    # Each model's export layout differs slightly, so files are per-model.
    # model_type picks the sherpa-onnx decoder family: the 2023-06-26 export
    # embeds query/value head dims (zipformer v2 metadata) and hard-aborts
    # the process if loaded as plain "zipformer" (verified crash), while the
    # 20m export embeds attention_dims (zipformer v1).
    "csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26": {
        "encoder": "encoder-epoch-99-avg-1-chunk-16-left-64.int8.onnx",
        "decoder": "decoder-epoch-99-avg-1-chunk-16-left-64.int8.onnx",
        "joiner": "joiner-epoch-99-avg-1-chunk-16-left-64.int8.onnx",
        "tokens": "tokens.txt",
        "model_type": "zipformer2",
    },
    "csukuangfj/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17": {
        "encoder": "encoder-epoch-99-avg-1.int8.onnx",
        "decoder": "decoder-epoch-99-avg-1.int8.onnx",
        "joiner": "joiner-epoch-99-avg-1.int8.onnx",
        "tokens": "tokens.txt",
        "model_type": "zipformer",
    },
}
STREAMING_CACHE_DIR = Path.home() / ".cache" / "son" / "streaming"
STREAMING_SAMPLE_RATE = 16000  # zipformer's training rate; the base class resamples


def streaming_stt_available() -> bool:
    """True when sherpa-onnx is installed. Cheap probe — no model download."""
    return importlib.util.find_spec("sherpa_onnx") is not None


def _model_dir(model_id: str) -> Path:
    return STREAMING_CACHE_DIR / model_id.rsplit("/", 1)[-1]


def _download_file(url: str, dest: Path):
    """Stream one model file to disk (the kokoro-onnx download pattern)."""
    logger.info(f"Downloading {url} ...")
    dest.parent.mkdir(parents=True, exist_ok=True)
    resp = requests.get(url, stream=True, timeout=300)
    resp.raise_for_status()
    with open(dest, "wb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            f.write(chunk)


def _ensure_model_files(model_id: str) -> Path:
    d = _model_dir(model_id)
    files = STREAMING_MODEL_FILES[model_id]
    # "model_type" is config, not a download; the rest are ONNX/token files.
    missing = [v for k, v in files.items() if k != "model_type" and not (d / v).is_file()]
    if missing:
        total = "~430 MB" if "2023-06-26" in model_id else "~50 MB"
        logger.info(
            f"Streaming STT: downloading {len(missing)} model file(s) ({total} total, "
            f"one-time) from huggingface.co/{model_id} ..."
        )
        for f in missing:
            _download_file(f"https://huggingface.co/{model_id}/resolve/main/{f}", d / f)
    return d


# The recognizer holds ONNX model state (~150 MB for the 100m export) and
# loading takes a moment, so cache it per model across sessions (same
# rationale as the parakeet cache). The lock serializes decode — sherpa-onnx
# recognizers are not safe under concurrent use.
_recognizers: dict[str, tuple] = {}
_recognizers_guard = threading.Lock()


def _get_recognizer(model_id: str):
    with _recognizers_guard:
        entry = _recognizers.get(model_id)
        if entry is None:
            import sherpa_onnx  # delayed: the C++ import is heavy

            d = _ensure_model_files(model_id)
            files = STREAMING_MODEL_FILES[model_id]
            recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
                tokens=str(d / files["tokens"]),
                encoder=str(d / files["encoder"]),
                decoder=str(d / files["decoder"]),
                joiner=str(d / files["joiner"]),
                num_threads=2,
                sample_rate=STREAMING_SAMPLE_RATE,
                feature_dim=80,
                decoding_method="greedy_search",
                provider="cpu",
                model_type=files.get("model_type", "zipformer"),
            )
            logger.info(f"Streaming STT: loaded {model_id} (num_threads=2, provider=cpu)")
            entry = (recognizer, threading.Lock())
            _recognizers[model_id] = entry
        return entry


class StreamingSTTService(STTService):
    """Transcribe continuously with a streaming zipformer on the local CPU.

    Every audio chunk is decoded in place; a changed hypothesis is pushed as
    an InterimTranscriptionFrame (the RTVI observer relays it as a
    user-transcription partial, so the client row grows live). The pipeline's
    VAD owns turn boundaries: the stream is created on VADUserStarted-
    SpeakingFrame and, on VADUserStoppedSpeakingFrame, the final hypothesis
    is pushed as a finalized TranscriptionFrame and the stream resets for the
    next turn — the same shape SegmentedSTTService produces, so the cleanup
    stage and aggregator treat both providers identically.
    """

    def __init__(self, *, model: str | None = None, **kwargs):
        self._model = model or next(iter(STREAMING_MODELS))
        super().__init__(sample_rate=STREAMING_SAMPLE_RATE, **kwargs)
        self._recognizer, self._inference_lock = _get_recognizer(self._model)
        self._stream = None
        self._last_partial = ""

    def can_generate_metrics(self) -> bool:
        return True

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        """Decode one audio chunk (16 kHz int16 PCM) and report the new partial."""
        if not audio or self._stream is None:
            return
        # int16 PCM → float32 in [-1, 1], what sherpa-onnx wants.
        samples = np.frombuffer(audio, dtype=np.int16).astype(np.float32) / 32768.0
        # CPU-bound ONNX inference must not block the pipeline event loop.
        text = await asyncio.to_thread(self._decode_chunk, samples)
        if text and text != self._last_partial:
            self._last_partial = text
            yield InterimTranscriptionFrame(text, self._user_id, time_now_iso8601(), Language.EN)

    async def process_frame(self, frame, direction):
        # super() first: the base owns AudioRawFrame/VAD handling (audio
        # feeding, TTFB state, downstream passthrough of the VAD frames).
        await super().process_frame(frame, direction)
        if isinstance(frame, VADUserStartedSpeakingFrame):
            await self.start_processing_metrics()
            self._begin_utterance()
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            await self._end_utterance()

    def _begin_utterance(self):
        with self._inference_lock:
            self._stream = self._recognizer.create_stream()
            self._last_partial = ""

    def _decode_chunk(self, samples: np.ndarray) -> str:
        with self._inference_lock:
            self._stream.accept_waveform(STREAMING_SAMPLE_RATE, samples)
            while self._recognizer.is_ready(self._stream):
                self._recognizer.decode_stream(self._stream)
            return self._recognizer.get_result(self._stream).strip()

    async def _end_utterance(self):
        if self._stream is None:
            return
        text = await asyncio.to_thread(self._end_utterance_sync)
        if text:
            await self.emit_stt_usage_metrics()
            await self.push_frame(
                TranscriptionFrame(
                    text, self._user_id, time_now_iso8601(), Language.EN, finalized=True
                )
            )
        await self.stop_processing_metrics()

    def _end_utterance_sync(self) -> str:
        with self._inference_lock:
            if self._stream is None:
                return ""
            text = self._recognizer.get_result(self._stream).strip()
            self._stream = None  # next utterance creates a fresh stream
            return text

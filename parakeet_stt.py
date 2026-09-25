# NVIDIA Parakeet TDT — local speech-to-text via sherpa-onnx.
#
# Parakeet TDT runs entirely on this machine (ONNX on CPU, like Kokoro): no
# API key, no audio leaving the box. Turn detection stays with Silero VAD in
# the pipeline; this service transcribes each VAD-segmented utterance as one
# batch call (the TDT models are offline, not streaming), so a transcription
# lands per utterance, when the user stops speaking. The model (~660 MB)
# downloads once into ~/.cache/son/parakeet on first use.
#
# sherpa-onnx API note: Parakeet is a NeMo transducer, so the recognizer is
# built with model_type="nemo_transducer" — that selects the NeMo-style
# feature extraction; the generic "transducer" type mis-decodes its features.

import asyncio
import importlib.util
import threading
import time
from collections.abc import AsyncGenerator
from pathlib import Path

import numpy as np
import requests
from loguru import logger

from pipecat.frames.frames import Frame, TranscriptionFrame
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.transcriptions.language import Language
from pipecat.utils.time import time_now_iso8601

# Model repo id → picker label. Only sherpa-onnx NeMo transducer exports are
# supported (the encoder/decoder/joiner + tokens layout below).
PARAKEET_MODELS = {
    # v3 trains on 24 languages and the Granary corpus (incl. accented English).
    # Only v3 is offered; v2 was dropped per user preference (v3 wins on both
    # accuracy and speed). First entry = default.
    "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8": "parakeet-tdt-0.6b-v3 · local",
}
PARAKEET_MODEL_FILES = ("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")
PARAKEET_CACHE_DIR = Path.home() / ".cache" / "son" / "parakeet"
PARAKEET_SAMPLE_RATE = 16000  # Parakeet's training rate; the base class resamples


def parakeet_stt_available() -> bool:
    """True when sherpa-onnx is installed. Cheap probe — no model download."""
    return importlib.util.find_spec("sherpa_onnx") is not None


def _model_dir(model_id: str) -> Path:
    return PARAKEET_CACHE_DIR / model_id.rsplit("/", 1)[-1]


def _download_file(url: str, dest: Path):
    """Stream one model file to disk (the kokoro-onnx download pattern)."""
    logger.info(f"Downloading {url} ...")
    dest.parent.mkdir(parents=True, exist_ok=True)
    resp = requests.get(url, stream=True, timeout=300)
    resp.raise_for_status()
    with open(dest, "wb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            f.write(chunk)


def ensure_model_files(model_id: str) -> Path:
    """Fetch any missing model file for this model. Blocking — call it off the
    event loop (son.py does, via prepare())."""
    d = _model_dir(model_id)
    missing = [f for f in PARAKEET_MODEL_FILES if not (d / f).is_file()]
    if missing:
        logger.info(
            f"Parakeet: downloading {len(missing)} model file(s) (~660 MB total, "
            f"one-time) from huggingface.co/{model_id} ..."
        )
        for f in missing:
            _download_file(f"https://huggingface.co/{model_id}/resolve/main/{f}", d / f)
    return d


def prepare(model_id: str) -> None:
    """Download the model if needed and load the recognizer — now, while the
    caller can afford to wait *off* the event loop.

    Both halves block: ~660 MB over the network, then ~600 MB into RAM. son.py
    serves the web page, /models, /roles and the browser extension from the same
    event loop as the voice pipeline, so running this from the pipeline's own task
    stalled every HTTP route until it finished — the page and the extension both
    saw a dead bot for as long as the download took. son.py calls this through
    asyncio.to_thread; the recognizer cache then makes the service's first turn
    instant instead of freezing it.
    """
    _get_recognizer(model_id)


# Loading the recognizer pulls the ONNX model into RAM (~600 MB) and takes
# seconds, so cache it per model across sessions (same rationale as the TTS
# service cache in son.py). The lock serializes inference — sherpa-onnx
# recognizers are not safe under concurrent decode.
_recognizers: dict[str, tuple] = {}
_recognizers_guard = threading.Lock()


def _get_recognizer(model_id: str):
    with _recognizers_guard:
        entry = _recognizers.get(model_id)
        if entry is None:
            import sherpa_onnx  # delayed: the C++ import is heavy

            d = ensure_model_files(model_id)
            recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
                encoder=str(d / "encoder.int8.onnx"),
                decoder=str(d / "decoder.int8.onnx"),
                joiner=str(d / "joiner.int8.onnx"),
                tokens=str(d / "tokens.txt"),
                num_threads=2,
                sample_rate=PARAKEET_SAMPLE_RATE,
                feature_dim=80,
                decoding_method="greedy_search",
                provider="cpu",
                model_type="nemo_transducer",
            )
            logger.info(f"Parakeet: loaded {model_id} (num_threads=2, provider=cpu)")
            entry = (recognizer, threading.Lock())
            _recognizers[model_id] = entry
        return entry


def release(keep: str | None = None) -> list[str]:
    """Drop cached recognizers, freeing ~600 MB each.

    The cache exists to save a ~1.5 s rebuild *between turns and sessions* — not
    to pin memory for the life of the process. So a session that doesn't use
    Parakeet (the default is browser Web Speech) or that is over (nothing is
    using anything) drops what it doesn't need: `keep=None` releases everything.

    Safe while a decode is in flight: the caller holds the recognizer object, so
    dropping our reference only means the *next* session rebuilds it.
    """
    with _recognizers_guard:
        dropped = [model for model in _recognizers if model != keep]
        for model in dropped:
            _recognizers.pop(model, None)
    if dropped:
        logger.info(f"Parakeet: released {', '.join(dropped)} — keeping {keep or 'nothing'}")
    return dropped


class ParakeetSTTService(SegmentedSTTService):
    """Transcribe each VAD turn with NVIDIA Parakeet TDT on the local CPU.

    The model loads eagerly at construction (like Kokoro): the first session
    start pays the one-time download + load, every turn after is instant.
    """

    def __init__(self, *, model: str | None = None, echo_roll=None, **kwargs):
        self._model = model or next(iter(PARAKEET_MODELS))
        super().__init__(sample_rate=PARAKEET_SAMPLE_RATE, **kwargs)
        self._recognizer, self._inference_lock = _get_recognizer(self._model)
        self._echo_roll = echo_roll  # BotAudioRoll; None disables the echo gate

    @property
    def wants_wav_segments(self) -> bool:
        """The model reads raw 16-bit PCM, not a WAV container."""
        return False

    def can_generate_metrics(self) -> bool:
        return True

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame, None]:
        await self.start_processing_metrics()

        # int16 PCM → float32 in [-1, 1], what sherpa-onnx wants.
        samples = np.frombuffer(audio, dtype=np.int16).astype(np.float32) / 32768.0

        # Echo gate: the segment arrived whole at VAD stop; compare its onset
        # against the bot's recent playback. The segment started
        # len(samples)/rate seconds ago — that's the reference time.
        if self._echo_roll is not None and len(samples) >= int(0.5 * PARAKEET_SAMPLE_RATE):
            onset = samples[: int(0.5 * PARAKEET_SAMPLE_RATE)]
            is_echo, score = await asyncio.to_thread(
                self._echo_roll.match,
                onset,
                time.monotonic() - len(samples) / PARAKEET_SAMPLE_RATE,
            )
            if is_echo:
                logger.warning(
                    f"Echo turn dropped (bot-audio match {score:.2f}) — "
                    "the mic heard the bot's own voice"
                )
                await self.stop_processing_metrics()
                return

        def _transcribe() -> str:
            with self._inference_lock:
                stream = self._recognizer.create_stream()
                stream.accept_waveform(PARAKEET_SAMPLE_RATE, samples)
                self._recognizer.decode_stream(stream)
                return stream.result.text.strip()

        # CPU-bound ONNX inference must not block the pipeline event loop.
        text = await asyncio.to_thread(_transcribe)

        await self.stop_processing_metrics()

        if text:
            logger.debug(f"Parakeet transcription: [{text}]")
            yield TranscriptionFrame(text, self._user_id, time_now_iso8601(), Language.EN)

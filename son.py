# Son — a personal real-time voice agent.
#
# Default stack (every capability is swappable in the client settings panel,
# gated by which API keys are present in .env):
#   - STT:  Groq (whisper-large-v3-turbo)  — cloud, free tier (also:
#           OpenRouter when its key is set, Parakeet TDT local ONNX)
#   - LLM:  Groq (openai/gpt-oss-120b)     — cloud, free tier (also:
#           DeepSeek / Gemini / OpenRouter when their keys are set)
#   - TTS:  Kokoro-82M (local, ONNX on CPU) — no cloud, no cost
#   - Turn detection: Silero VAD via LLMContextAggregatorPair
#
# The agent's role comes from an instruction file chosen per session.
# The web client passes {"instruction": ..., "llm": ..., "stt": ..., "tts": ...}
# in the RTVI /start request body; this bot reads them from runner_args.body.

import asyncio
import base64
import binascii
import io
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import wave
from functools import lru_cache
from pathlib import Path

import httpx
from dotenv import load_dotenv
from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    AudioRawFrame,
    InputAudioRawFrame,
    LLMRunFrame,
    TranscriptionFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.runner.types import RunnerArguments
from pipecat.services.cerebras.llm import CerebrasLLMService
from pipecat.services.deepseek.llm import DeepSeekLLMService
from pipecat.services.google.llm import GoogleLLMService
from pipecat.services.google.stt import GoogleSTTService
from pipecat.services.google.tts import GeminiTTSService
from pipecat.services.groq.llm import GroqLLMService
from pipecat.services.groq.stt import GroqSTTService
from pipecat.services.groq.tts import GroqTTSService
from pipecat.services.kokoro.tts import KokoroTTSService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.openai.stt import OpenAISTTService
from pipecat.services.openrouter.llm import OpenRouterLLMService

from audio_filters import build_input_filter, capture, repeat_phrase
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.utils.text.base_text_filter import BaseTextFilter
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner

import parakeet_stt
import sessions_store as sessions

load_dotenv(override=True)

sessions.init_db()  # idempotent; creates son.db on first run

INSTRUCTIONS_DIR = Path(__file__).parent / "instructions"
DEFAULT_INSTRUCTION = "default.md"

# Groq is OpenAI-compatible; these live on the base service.
# Note: Groq rotates its model roster — llama-3.3-70b-versatile was removed
# in Aug 2026 (404 model_not_found). gpt-oss-120b streams first content in
# ~0.45s with reasoning_effort=low (see GroqLLMService.Settings below).
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
GROQ_STT_MODEL = os.getenv("GROQ_STT_MODEL", "whisper-large-v3-turbo")
KOKORO_VOICE = os.getenv("KOKORO_VOICE", "af_heart")

# reasoning_effort trades smarts for latency on gpt-oss models (passed to the
# Groq API via Settings.extra):
#   low    ~0.45s to first content — snappy but shallow
#   medium balanced (default)
#   high   noticeably smarter, slower first token
GROQ_REASONING_EFFORT = os.getenv("GROQ_REASONING_EFFORT", "medium")

# LM Studio / local OpenAI-compatible inference. LMSTUDIO_API_KEY gates the
# provider (any value works if the server has auth disabled). Point
# LMSTUDIO_BASE_URL at a tailnet IP to use a remote machine's server.
LMSTUDIO_BASE_URL = os.getenv("LMSTUDIO_BASE_URL", "http://127.0.0.1:1234/v1")
LMSTUDIO_MODEL = os.getenv("LMSTUDIO_MODEL", "ornith-1.5-9b-mlx")

# Local voice-model STT: the fine-tuned whisper served by whisper.cpp
# (whisper_local.py shim on :8083 -> whisper-server on :8081). Keyless.
WHISPER_LOCAL_BASE_URL = os.getenv("WHISPER_LOCAL_BASE_URL", "http://127.0.0.1:8083/v1")
WHISPER_LOCAL_MODEL = os.getenv("WHISPER_LOCAL_MODEL", "whisper-small-son")

# Optional STT transcript cleanup: rewrite each final utterance through a local
# text-normalizer model (s1-mini on LM Studio) before the brain sees it.
# Empty model = disabled. Auth reuses LMSTUDIO_API_KEY.
STT_CLEANUP_MODEL = os.getenv("STT_CLEANUP_MODEL", "")
STT_CLEANUP_BASE_URL = os.getenv("STT_CLEANUP_BASE_URL", LMSTUDIO_BASE_URL)

STT_CLEANUP_SYSTEM_PROMPT = (
    "You are a text normalizer for speech-to-text transcripts. Clean the "
    "transcript to match these settings: styling semi-formal, structure "
    "prose, context general. Output only the cleaned text. Always output "
    "something: if the input is a single word or fragment, output it as-is."
)

# --- Model providers ----------------------------------------------------------
# A provider is enabled only when its API key is present in .env (same pattern
# as the readme project's api/models.js). The client's settings panel picks a
# provider+model per capability (LLM / STT / TTS) and sends it in custom_data;
# /start validates the choice and builds the services below.

PROVIDER_ENV_KEYS = {
    "groq": "GROQ_API_KEY",
    "cerebras": "CEREBRAS_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "lmstudio": "LMSTUDIO_API_KEY",
}

# Which providers offer each capability, and the key that gates them.
STT_PROVIDER_ENV_KEYS = {
    "groq": "GROQ_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "google": None,         # google: see google_stt_available()
    "whisper-local": None,  # local: see whisper_local_available()
}
TTS_PROVIDER_ENV_KEYS = {"kokoro": None, "groq": "GROQ_API_KEY", "gemini": "GEMINI_API_KEY"}


def google_stt_available() -> bool:
    """Cloud Speech-to-Text V2 needs real, usable Google credentials — a
    service account via GOOGLE_APPLICATION_CREDENTIALS, or `gcloud auth
    application-default login`. Pipecat's GoogleSTTService has no API-key
    auth, so GEMINI_API_KEY alone can NOT drive it. File existence isn't
    enough: an expired ADC token ("Reauthentication is needed") still fails
    at request time, so probe by refreshing the credentials."""
    adc_file = os.getenv("GOOGLE_APPLICATION_CREDENTIALS") or str(
        Path.home() / ".config/gcloud/application_default_credentials.json"
    )
    if not Path(adc_file).is_file():
        return False
    try:
        from google.auth import default as adc_default
        from google.auth.transport.requests import Request

        creds, _ = adc_default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        if not creds.valid:
            creds.refresh(Request())
        return True
    except Exception as e:
        logger.warning(f"Google credentials not usable ({type(e).__name__}: {e}); Google STT disabled")
        return False

def whisper_local_available() -> bool:
    """Local fine-tuned whisper (whisper.cpp server on 127.0.0.1:8081, fronted
    by the whisper_local.py OpenAI-compat shim on :8083). Probe the server's
    TCP port — it's the real dependency; the shim is inert without it."""
    import socket

    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.5)
    try:
        s.connect(("127.0.0.1", 8081))
        return True
    except OSError:
        return False
    finally:
        s.close()


# Fallbacks for manual /start calls that don't name a model.
DEFAULT_MODELS = {
    "groq": GROQ_MODEL,
    "cerebras": "gpt-oss-120b",
    "deepseek": "deepseek-v4-flash",
    "gemini": "gemini-flash-latest",
    "openrouter": "anthropic/claude-sonnet-4.6",
    "lmstudio": LMSTUDIO_MODEL,
}

# Curated OpenRouter models — only these appear in the picker.
CURATED_OPENROUTER_MODELS = {
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-haiku-4.5",
    "google/gemini-3.6-flash",
    "openai/gpt-4o-mini",
    "deepseek/deepseek-chat",
    "qwen/qwen3.6-flash",
    "x-ai/grok-4.3",
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen3-next-80b-a3b-instruct:free",
}

# Kokoro-82M voice ids (shown in the TTS picker).
KOKORO_VOICES = [
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore",
    "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael",
    "am_onyx", "am_puck", "am_santa",
    "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
    "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
]


def available_providers() -> list[str]:
    """Providers whose API key is present in the environment."""
    return [p for p in PROVIDER_ENV_KEYS if os.getenv(PROVIDER_ENV_KEYS[p])]


def build_llm_service(provider: str, model: str, instruction: str):
    if provider == "groq":
        return GroqLLMService(
            api_key=require_env("GROQ_API_KEY"),
            settings=GroqLLMService.Settings(
                model=model,
                system_instruction=instruction,
                extra={"reasoning_effort": GROQ_REASONING_EFFORT},
            ),
        )
    if provider == "cerebras":
        return CerebrasLLMService(
            api_key=os.getenv("CEREBRAS_API_KEY"),
            settings=CerebrasLLMService.Settings(model=model, system_instruction=instruction),
        )
    if provider == "deepseek":
        return DeepSeekLLMService(
            api_key=os.getenv("DEEPSEEK_API_KEY"),
            settings=DeepSeekLLMService.Settings(model=model, system_instruction=instruction),
        )
    if provider == "gemini":
        return GoogleLLMService(
            api_key=os.getenv("GEMINI_API_KEY"),
            settings=GoogleLLMService.Settings(model=model, system_instruction=instruction),
        )
    if provider == "openrouter":
        return OpenRouterLLMService(
            api_key=os.getenv("OPENROUTER_API_KEY"),
            settings=OpenRouterLLMService.Settings(model=model, system_instruction=instruction),
        )
    if provider == "lmstudio":
        # Local OpenAI-compatible server (LM Studio). api_key can be None —
        # the client only sends the header when the env var is set.
        return OpenAILLMService(
            api_key=os.getenv("LMSTUDIO_API_KEY"),
            base_url=LMSTUDIO_BASE_URL,
            settings=OpenAILLMService.Settings(model=model, system_instruction=instruction),
        )
    raise ValueError(f"Unknown LLM provider: {provider}")


def build_stt_service(provider: str, model: str):
    if provider == "groq":
        return GroqSTTService(
            api_key=require_env("GROQ_API_KEY"),
            settings=GroqSTTService.Settings(model=model),
        )
    if provider == "openrouter":
        # OpenRouter's /audio/transcriptions is OpenAI-compatible (multipart,
        # same request shape as Whisper), so the OpenAI STT service just needs
        # the base URL pointed at OpenRouter's API.
        return OpenAISTTService(
            api_key=require_env("OPENROUTER_API_KEY"),
            base_url="https://openrouter.ai/api/v1",
            settings=OpenAISTTService.Settings(model=model),
        )
    if provider == "google":
        # Credentials come from GOOGLE_APPLICATION_CREDENTIALS / ADC; there is
        # no API-key auth for Cloud Speech (see google_stt_available()).
        return GoogleSTTService(settings=GoogleSTTService.Settings(model=model))
    if provider == "parakeet":
        # Local NVIDIA Parakeet TDT via sherpa-onnx (ONNX on CPU). The model
        # (~660 MB) downloads once into ~/.cache/son/parakeet on first use.
        return parakeet_stt.ParakeetSTTService(model=model)
    if provider == "whisper-local":
        # Fine-tuned whisper via whisper.cpp. whisper.cpp's /inference isn't
        # OpenAI-shaped, so the whisper_local.py shim bridges the multipart
        # /v1/audio/transcriptions call to it. The OpenAI SDK refuses falsy
        # api_keys, so send a dummy "local" key — whisper-server ignores the
        # Authorization header entirely (same trick as LM Studio).
        return OpenAISTTService(
            api_key=os.getenv("WHISPER_LOCAL_API_KEY", "local"),
            base_url=WHISPER_LOCAL_BASE_URL,
            settings=OpenAISTTService.Settings(model=model or WHISPER_LOCAL_MODEL),
        )
    raise ValueError(f"Unknown STT provider: {provider}")


def build_tts_service(provider: str, model: str | None, voice: str | None):
    # MarkdownToSpeechFilter: strip markdown markers from what the TTS
    # synthesizes, per sentence, without touching the transcript stream.
    filters = [MarkdownToSpeechFilter()]
    if provider == "kokoro":
        return KokoroTTSService(
            settings=KokoroTTSService.Settings(voice=voice or KOKORO_VOICE),
            text_filters=filters,
        )
    if provider == "groq":
        return GroqTTSService(
            api_key=require_env("GROQ_API_KEY"),
            settings=GroqTTSService.Settings(model=model, voice=voice),
            text_filters=filters,
        )
    if provider == "gemini":
        return GeminiTTSService(
            api_key=os.getenv("GEMINI_API_KEY"),
            settings=GeminiTTSService.Settings(model=model, voice=voice),
            text_filters=filters,
        )
    raise ValueError(f"Unknown TTS provider: {provider}")


# --- One-shot TTS for the client's "Read out" page (POST /speak) ------------
# The read-out page needs a complete audio file, not a stream: synthesize the
# whole text, collect the PCM frames, wrap them in a WAV. All three providers
# yield AudioRawFrame chunks (TTSAudioRawFrame subclasses it), so one
# collector covers them. Kokoro synthesizes at its hardcoded speed=1.0 — the
# client applies speed at playback time (playbackRate), never here.

_SPEAK_MAX_CHARS = 8000  # a paragraph at a time; kokoro is ~real-time on CPU

# Constructing KokoroTTSService loads the ONNX model (~1 GB RAM, seconds), so
# cache services per (provider, voice) instead of building per request. The
# per-service lock serializes synthesis: run_tts streams through the
# service's own resampler, which isn't safe under concurrency.
_tts_services: dict = {}
_tts_services_guard = threading.Lock()


def _get_tts_service(provider: str, model: str | None, voice: str | None):
    key = (provider, voice)
    with _tts_services_guard:
        entry = _tts_services.get(key)
        if entry is None:
            svc = build_tts_service(provider, model, voice)
            if provider != "groq":
                # A service in a pipeline adopts its output sample rate from
                # the transport's StartFrame; standalone (here) that never
                # happens and the rate stays 0, which soxr rejects. Set the
                # same field the pipeline would. 24000 Hz: kokoro's native
                # rate (no-op resample) and what cloud voices answer in.
                # Groq is exempt — it reports the rate from its own API WAV.
                svc._sample_rate = 24000
            entry = (svc, threading.Lock())
            _tts_services[key] = entry
        return entry


def _synthesize_to_wav(service, text: str) -> bytes:
    """Run one synthesis and collect the frames into a WAV file."""
    chunks: list[bytes] = []
    sample_rate = 0

    async def run():
        nonlocal sample_rate
        async for frame in service.run_tts(text, "speak"):
            if isinstance(frame, AudioRawFrame):
                chunks.append(frame.audio)
                sample_rate = sample_rate or frame.sample_rate

    # The route handler runs in FastAPI's threadpool (a sync def), so there's
    # no running loop here — asyncio.run is safe, and the model/network work
    # never blocks the event loop (chat sessions stay smooth mid-read).
    asyncio.run(run())
    if not chunks or not sample_rate:
        raise RuntimeError("TTS produced no audio")
    pcm = b"".join(chunks)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


def speak_audio(text: str, provider: str, model: str | None, voice: str | None) -> bytes:
    service, lock = _get_tts_service(provider, model, voice)
    with lock:
        return _synthesize_to_wav(service, text)


def require_speak_text(text: str) -> str:
    """Shared text validation for /speak and /export."""
    text = (text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Nothing to read — paste some text first.")
    if len(text) > _SPEAK_MAX_CHARS:
        raise HTTPException(
            status_code=400, detail=f"Text is too long (max {_SPEAK_MAX_CHARS} characters)."
        )
    return text


def resolve_speak_voice(payload: dict) -> tuple[str, str | None, str | None]:
    """{voice: {provider, id}} → (provider, model, voice). Unavailable
    providers fall back to the local kokoro voice, same as the chat path."""
    choice = payload.get("voice") or {}
    provider = choice.get("provider") or "kokoro"
    if provider not in TTS_PROVIDER_ENV_KEYS or (
        TTS_PROVIDER_ENV_KEYS[provider] and not os.getenv(TTS_PROVIDER_ENV_KEYS[provider])
    ):
        logger.warning(f"TTS provider '{provider}' unavailable; using kokoro")
        provider = "kokoro"
    if provider == "kokoro":
        model, voice = None, choice.get("id")
    else:
        model, voice = choice.get("id"), None
    return provider, model, voice


# --- Read-page export (POST /export): save + compress with ffmpeg -----------
# The browser can't choose where downloads land, so the server writes the file
# itself: re-synthesize the textarea, then either save the raw WAV or compress
# it with ffmpeg (present on the server machine, run via subprocess). The WAV
# is roughly 2.6 MB/minute of speech; podcast-grade AAC/Opus at 96–128 kbps is
# ~5x smaller at quality a listener can't tell apart. Tags and cover art go in
# as ffmpeg metadata.

EXPORT_FORMATS = ("wav", "mp3", "m4a", "opus")
EXPORT_DEFAULT_BITRATE = 128  # kbps
EXPORT_BITRATES = (64, 96, 128, 192, 256)


def detect_download_dir() -> str:
    """The server's own downloads folder (the client asks for it via
    /export/defaults so the Export panel can prefill)."""
    home = Path.home()
    for candidate in (home / "Downloads", home / "Desktop", home):
        if candidate.is_dir():
            return str(candidate)
    return str(home)


def sanitize_stem(name: str) -> str:
    """A file name that survives ffmpeg and the filesystem. ffmpeg treats a
    ':' in the output path as a protocol prefix (e.g. "a:b.mp3" is protocol
    'a'), and shell metacharacters make a copied command silently fail. Keep
    letters, digits, spaces, dot, dash, underscore; a ':' becomes an em dash
    '—', everything else folds to '-', then tidy the edges so the result
    isn't empty, '.' or '..'."""
    stem = Path(name or "").stem
    # ':' survives this pass on purpose — swapped for the em dash just after.
    stem = re.sub(r"[^A-Za-z0-9 ._:_-]+", "-", stem)
    stem = re.sub(r"\s+", " ", stem).replace(":", "—").strip(" .")
    return stem or "reading"


def shell_quote(s: str) -> str:
    """Always-quoted for the echoed ffmpeg command — quote even when there
    are no spaces: the command is copied into a shell, and an unquoted stray
    space or ':' is a silent break."""
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def build_ffmpeg_args(
    src: Path, dst: Path, fmt: str, bitrate: int, title: str, album: str, artist: str, cover: str | None
) -> list[str]:
    """The exact ffmpeg arguments for this export — executed as-is by the
    server and echoed (with "ffmpeg" prepended) to the client for display."""
    args = ["-y", "-i", str(src)]
    has_cover = bool(cover) and fmt in ("mp3", "m4a")
    if has_cover:
        args += ["-i", cover]
    codec = {"mp3": "libmp3lame", "m4a": "aac", "opus": "libopus"}[fmt]
    args += ["-c:a", codec, "-b:a", f"{bitrate}k"]
    if has_cover:
        # attached_pic is the standard way to embed cover art (ID3 APIC for
        # mp3, the covr atom for m4a). Opus/OGG has no picture channel — the
        # route rejects cover for it up front.
        args += ["-map", "0:a", "-map", "1:v", "-c:v", "copy", "-disposition:v", "attached_pic"]
    else:
        args += ["-map", "0:a"]
    for key, value in (("title", title), ("album", album), ("artist", artist)):
        if value:
            args += ["-metadata", f"{key}={value}"]
    if fmt == "mp3" and has_cover:
        args += ["-id3v2_version", "3", "-metadata:s:v", "title=Album cover",
                 "-metadata:s:v", "comment=Cover (front)"]
    args.append(str(dst))
    return args


def load_instruction(name: str | None) -> str:
    """Load an instruction file safely: basename only, inside instructions/.

    The web client passes a filename (e.g. "study-buddy.md"). We strip any
    path components so a request can never read outside the instructions dir.
    """
    filename = Path(name or DEFAULT_INSTRUCTION).name
    path = INSTRUCTIONS_DIR / filename
    if not path.is_file():
        logger.warning(f"Instruction '{filename}' not found, falling back to default")
        path = INSTRUCTIONS_DIR / DEFAULT_INSTRUCTION
    return path.read_text()


def require_env(key: str) -> str:
    value = os.getenv(key)
    if not value:
        raise RuntimeError(
            f"Missing {key}. Copy .env.example to .env and set your Groq API key "
            "(free at https://console.groq.com)."
        )
    return value


# --- Markdown-to-speech cleaning (LLM reply → TTS) ---------------------------
# LLM replies are markdown (the transcript renders it), but Kokoro reads the
# raw text: "**TS2322**" comes out as "asterisk asterisk TS2322". Strip the
# markers while keeping the inner content — bold/code/link text is still
# spoken, just without the syntax. Cleaning happens as a TTS text filter, so
# it applies inside the TTS service at synthesis time: the frames the
# transcripts see (live chat and stored sessions) keep the raw markdown
# untouched. The client's cleanText (lib/clean.ts) covers the /speak path;
# this covers every chat TTS provider (kokoro/groq/gemini).

def clean_for_tts(text: str) -> str:
    t = text
    # Escaped markers first: \* \` \[ become literal chars, so the marker
    # rules below see them (a stray escaped \* ends in the stray sweep).
    t = re.sub(r"\\([\\`*_{}\[\]()#+\-.!>])", r"\1", t)
    # Code blocks: keep the content, drop the fences (```lang … ```).
    t = re.sub(r"```[^\n]*\n([\s\S]*?)\n?```", r"\1", t)
    # Inline code: `code` → code.
    t = re.sub(r"`([^`\n]+)`", r"\1", t)
    # Images: ![alt](url) → alt; links: [text](url) → text.
    t = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", t)
    # Bold and italic — pairs first, then single markers, both word-adjacent
    # so "2 * 2" (math) keeps its asterisks until the stray sweep.
    t = re.sub(r"(\*\*|__)([^*_\n]+?)\1", r"\2", t)
    t = re.sub(r"(?<=\S)(\*|_)([^*_\n]+?)\1(?=\S)", r"\2", t)
    # Strikethrough: ~~x~~ → x.
    t = re.sub(r"~~([^~\n]+?)~~", r"\1", t)
    # Heading markers, blockquotes, list bullets and numbers.
    t = re.sub(r"(?m)^\s{0,3}#{1,6}\s+", "", t)
    t = re.sub(r"(?m)^\s*>\s?", "", t)
    t = re.sub(r"(?m)^\s*[-*+]\s+", "", t)
    t = re.sub(r"(?m)^\s*\d+[.)]\s+", "", t)
    # Table pipes: | a | b | → a b.
    t = re.sub(r"\|", " ", t)
    # Footnote references: [1] / [^1].
    t = re.sub(r"\[\^?\d+\]", "", t)
    # Table separator rows (| --- | --- |) and other marker-only lines.
    t = re.sub(r"[ \t]+(?=\n)", "", t)
    t = re.sub(r"(?m)^[\s:\-]+$", "", t)
    t = re.sub(r"(?m)^[ \t]+", "", t)
    t = re.sub(r"\n{2,}", "\n", t)
    # Stray markers (e.g. one half of a ** pair that never completed) and
    # identifier underscores — never meaningful aloud.
    t = re.sub(r"[\*`~_]{1,4}", "", t)
    # Collapse the whitespace runs the removals leave behind.
    t = re.sub(r"[ \t]{2,}", " ", t)
    t = re.sub(r"\s+([.,!?;:])", r"\1", t)
    return t.strip()


class MarkdownToSpeechFilter(BaseTextFilter):
    """Strips markdown markers from the text the TTS synthesizes.

    Registered as a TTSService text_filter: pipecat applies these inside the
    TTS service after sentence aggregation, immediately before synthesis. The
    transcript never sees the cleaned text — the TTS forwards the original
    sentence frames downstream before filtering (append_to_context=False)."""

    async def filter(self, text: str) -> str:
        return clean_for_tts(text)


class SegmentCaptureProcessor(FrameProcessor):
    """Feed post-filter mic audio (16 kHz, what whisper actually sees) into
    the repeat-capture roll. Zero cost until a repeat is detected."""

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            capture.feed_post(frame.audio, frame.sample_rate)
            capture.pre_turn_max = max(capture.pre_turn_max, capture.pre_rms)
            capture.agc_turn_max = max(capture.agc_turn_max, capture.agc_gain)
        await self.push_frame(frame, direction)


class TranscriptCleanupProcessor(FrameProcessor):
    """Rewrite each final STT utterance through a local text-normalizer LLM.

    Parakeet is fast but its raw transcript is messy — no punctuation, filler
    ("um", "uh"), word repeats. This stage sends every finalized utterance to
    a small local model (s1-mini on LM Studio) that returns clean prose, so
    the brain reads text that matches what was actually said.

    Each cleaned utterance is pushed as a NEW TranscriptionFrame carrying the
    raw frame's timestamp, so the RTVI observer emits a second user-
    transcription event (fresh frame id) and the client replaces the raw span
    in place — the live bubble flips to the cleaned text ~1s after the user
    stops speaking. Failures pass the raw frame through untouched: cleanup
    must never stall or corrupt a turn."""

    def __init__(self, model: str, base_url: str, api_key: str | None):
        super().__init__()
        self._model = model
        self._last_raw = ""
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers={"Authorization": f"Bearer {api_key}"} if api_key else {},
            timeout=20.0,
        )

    async def process_frame(self, frame, direction):
        # super() first: the base owns StartFrame handling — without it the
        # processor never marks itself started and push_frame silently drops
        # every frame (verified: the greeting's LLMRunFrame went missing).
        await super().process_frame(frame, direction)
        if (
            direction == FrameDirection.DOWNSTREAM
            and isinstance(frame, TranscriptionFrame)
            and frame.finalized
        ):
            cleaned = await self._clean(frame.text)
            # Debug instrument for repeated-phrase transcriptions: log the
            # raw/cleaned pair every turn, and when either side contains a
            # verbatim repeated n-gram — or the same finalized text arrives
            # twice in a row (the short-utterance variant) — dump the last
            # ~25 s of mic audio (pre- and post-filter) for replay.
            logger.info(f"cleanup: {frame.text!r} -> {cleaned!r}")
            key = frame.text.strip().lower()
            duplicate = bool(key) and key == self._last_raw
            self._last_raw = key
            if (
                repeat_phrase(frame.text)
                or (cleaned and repeat_phrase(cleaned))
                or duplicate
            ):
                logger.warning(
                    "repeated phrase in transcript — audio dumped to "
                    "~/.cache/son/debug/repeat-*"
                )
                capture.dump(frame.text, cleaned)
            # Quiet-turn capture: the turn's loudest pre-filter frame was
            # <= -32 dBFS, or the AGC needed >= +6 dB — soft speech, the
            # user-reported failure case. Throttled/capped inside dump_quiet.
            quiet = (
                0 < capture.pre_turn_max <= 10 ** (-32 / 20)
                or capture.agc_turn_max >= 2.0
            )
            capture.pre_turn_max = -1.0
            capture.agc_turn_max = 1.0
            if quiet:
                capture.dump_quiet(frame.text)
            if cleaned:
                # New frame, same timestamp: a fresh id makes the RTVI observer
                # emit a second user-transcription event, and the shared
                # timestamp lets the client replace the raw span with this one.
                frame = TranscriptionFrame(
                    cleaned,
                    frame.user_id,
                    frame.timestamp,
                    frame.language,
                    result=frame.result,
                    finalized=True,
                )
        await self.push_frame(frame, direction)

    async def _clean(self, text: str) -> str:
        async def once() -> str:
            r = await self._client.post(
                "/chat/completions",
                json={
                    "model": self._model,
                    "messages": [
                        {"role": "system", "content": STT_CLEANUP_SYSTEM_PROMPT},
                        {"role": "user", "content": text},
                    ],
                    "temperature": 0,
                    "max_tokens": 1024,
                },
            )
            r.raise_for_status()
            msg = r.json()["choices"][0]["message"]
            # s1-mini writes its answer in the reasoning channel — LM Studio
            # returns it as reasoning_content and leaves content empty.
            return (msg.get("content") or msg.get("reasoning_content") or "").strip()

        try:
            cleaned = await once()
            if not cleaned:
                # s1-mini occasionally emits nothing at all (empty reasoning
                # channel); one retry before falling back to the raw text.
                cleaned = await once()
            return cleaned
        except Exception as e:
            logger.warning(f"Transcript cleanup failed, passing raw text through: {e}")
            return ""

    async def cleanup(self):
        await self._client.aclose()
        await super().cleanup()


async def run_bot(transport: BaseTransport, runner_args: RunnerArguments) -> None:
    body = runner_args.body or {}
    custom_data = body.get("custom_data") or {}
    # Custom personas send their markdown verbatim; built-in roles pass a file
    # name that load_instruction resolves from instructions/ (basename only).
    instruction_content = custom_data.get("instruction_content")
    if instruction_content:
        instruction = instruction_content
    else:
        instruction = load_instruction(custom_data.get("instruction"))
    role_file = Path(custom_data.get("instruction") or DEFAULT_INSTRUCTION).name

    # Per-capability choices come from the client's settings panel. Anything
    # absent, unknown, or gated by a missing key falls back to the default.
    defaults = {
        "llm": {"provider": "groq", "model": GROQ_MODEL},
        "stt": {"provider": "groq", "model": GROQ_STT_MODEL},
        "tts": {"provider": "kokoro", "model": None, "voice": KOKORO_VOICE},
    }

    llm_choice = {**defaults["llm"], **(custom_data.get("llm") or {})}
    if llm_choice.get("provider") not in available_providers():
        logger.warning(f"LLM provider '{llm_choice.get('provider')}' unavailable; using groq")
        llm_choice = defaults["llm"]
    if llm_choice.get("id"):
        llm_choice["model"] = llm_choice["id"]  # client sends /models entries ({provider, id}); id wins over the default model

    stt_choice = {**defaults["stt"], **(custom_data.get("stt") or {})}
    stt_provider = stt_choice.get("provider")
    stt_available = (
        google_stt_available()
        if stt_provider == "google"
        else whisper_local_available()
        if stt_provider == "whisper-local"
        else parakeet_stt.parakeet_stt_available()
        if stt_provider == "parakeet"
        else bool(os.getenv(STT_PROVIDER_ENV_KEYS.get(stt_provider, "")))
    )
    if not stt_available:
        logger.warning(f"STT provider '{stt_provider}' unavailable; using groq")
        stt_choice = defaults["stt"]
    if stt_choice.get("id"):
        stt_choice["model"] = stt_choice["id"]  # client sends /models entries ({provider, id}); id wins over the default model

    tts_choice = {**defaults["tts"], **(custom_data.get("tts") or {})}
    tts_provider = tts_choice.get("provider")
    # kokoro is local (no key): allowed only as an explicit known provider.
    if tts_provider not in TTS_PROVIDER_ENV_KEYS or (
        TTS_PROVIDER_ENV_KEYS[tts_provider] and not os.getenv(TTS_PROVIDER_ENV_KEYS[tts_provider])
    ):
        logger.warning(f"TTS provider '{tts_provider}' unavailable; using kokoro")
        tts_choice = defaults["tts"]
    # The client sends /models entries ({provider, id}); map id to the field
    # each service expects — voice for Kokoro, model for cloud TTS. id wins
    # over the merged default (voice/model).
    if tts_choice.get("provider") == "kokoro":
        if tts_choice.get("id"):
            tts_choice["voice"] = tts_choice["id"]
    elif tts_choice.get("id"):
        tts_choice["model"] = tts_choice["id"]

    logger.info(
        f"Session: role={role_file} "
        f"llm={llm_choice['provider']}/{llm_choice.get('model')} "
        f"stt={stt_choice['provider']}/{stt_choice.get('model')} "
        f"tts={tts_choice['provider']}/{tts_choice.get('voice') or tts_choice.get('model')}"
        + (f" cleanup={STT_CLEANUP_MODEL}" if STT_CLEANUP_MODEL else "")
    )

    stt = build_stt_service(stt_choice["provider"], stt_choice.get("model"))
    llm = build_llm_service(llm_choice["provider"], llm_choice.get("model"), instruction)
    tts = build_tts_service(tts_choice["provider"], tts_choice.get("model"), tts_choice.get("voice"))

    # Session persistence: the client owns the session id (a uuid sent in
    # custom_data), so a session survives reconnects and bot restarts. A
    # known id resumes with the stored transcript seeded into the brain; an
    # unknown/missing id creates a fresh session row, auto-named from the
    # role + start time. No session_id at all stays fully ephemeral — the
    # behavior before sessions existed.
    session_id = custom_data.get("session_id")
    if session_id and sessions.get_session(session_id):
        stored = sessions.get_messages(session_id)
        seed = [{"role": m["role"], "content": m["text"]} for m in stored]
        context = sessions.PersistedContext(session_id=session_id, messages=seed)
        logger.info(f"Resuming session {session_id} ({len(seed)} stored messages)")
    else:
        context = sessions.PersistedContext(session_id=session_id or None)
        if session_id:
            role_name = sessions.parse_frontmatter_name(instruction)
            sessions.create_session(
                session_id,
                f"{role_name or role_file} · {time.strftime('%b %d, %H:%M')}",
                role_file,
                role_name,
            )
            logger.info(f"Created session {session_id}")

    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )

    # Optional transcript cleanup: rewrite each finalized STT utterance through
    # a local text-normalizer model (s1-mini on LM Studio) before the brain
    # sees it. STT_CLEANUP_MODEL="" disables the stage entirely.
    cleanup = (
        TranscriptCleanupProcessor(
            model=STT_CLEANUP_MODEL,
            base_url=STT_CLEANUP_BASE_URL,
            api_key=os.getenv("LMSTUDIO_API_KEY"),
        )
        if STT_CLEANUP_MODEL
        else None
    )

    stages = [
        transport.input(),
        SegmentCaptureProcessor(),  # repeat-capture roll (debug instrument)
        stt,
    ]  # user audio -> speech -> text
    if cleanup:
        stages.append(cleanup)  # ... -> clean the raw transcript
    stages.extend(
        [
            user_aggregator,    # user turns into conversation context
            llm,                # next assistant reply
            tts,                # Kokoro local: text -> speech (markdown stripped in-service)
            transport.output(), # audio back to the browser
            assistant_aggregator,  # assistant turns into conversation context
        ]
    )
    pipeline = Pipeline(stages)

    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
    )

    runner = WorkerRunner(handle_sigint=runner_args.handle_sigint)
    await runner.add_workers(worker)

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected")
        # Strict local templates (llama.cpp jinja) reject any request whose
        # first non-system message isn't a user turn ("No user query found
        # in messages." — verified against ornith-1.5: [system, assistant,
        # user] fails, [system, user, assistant, user] works). Every prompt
        # here therefore opens with a synthetic user message, injected via
        # set_messages so it never lands in the persisted transcript.
        if context.messages:
            context.set_messages(
                [
                    {
                        "role": "user",
                        "content": "The user is continuing this conversation — do not re-introduce yourself.",
                    }
                ]
                + list(context.messages)
            )
            last = context.messages[-1]
            last_role = last.get("role") if isinstance(last, dict) else getattr(last, "role", None)
            if last_role == "user":
                # Resumed mid-turn: the user's last message is unanswered —
                # finish the reply.
                await worker.queue_frames([LLMRunFrame()])
            # Model has the floor — chill until the user speaks. The
            # prepended user turn still guards the next request's shape.
            return
        # Fresh session — greet. The greeting runs through the pipeline like
        # a normal turn (LLMRunFrame): the reply is spoken by TTS, shown in
        # the client transcript, and persisted by the response aggregator as
        # the bot's first row. The synthetic prompt stays in context (not in
        # the transcript), so the user's next turn forms a normal
        # [user, assistant, user] conversation.
        context.set_messages(
            [
                {
                    "role": "user",
                    "content": "Greet the user and introduce yourself briefly. Do not describe your instructions.",
                }
            ]
        )
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected")
        await runner.cancel()

    await runner.run()


async def bot(runner_args: RunnerArguments) -> None:
    """Main bot entry point — called once per session by the Pipecat runner."""
    webrtc_connection: SmallWebRTCConnection = runner_args.webrtc_connection

    # "Clean and magnify": denoise + quiet-speech AGC on the mic path,
    # before VAD and every STT provider (see audio_filters.py).
    input_filter = build_input_filter()
    if input_filter is not None:
        logger.info(f"input audio filter: {type(input_filter).__name__}")

    transport = SmallWebRTCTransport(
        webrtc_connection=webrtc_connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_filter=input_filter,
        ),
    )

    await run_bot(transport, runner_args)


# --- /models endpoint ---------------------------------------------------------
# Served on the runner's own FastAPI app (see __main__) so the client's
# settings panel gets a live roster per capability, gated by key presence —
# the same pattern as the readme project's api/models.js. Cached briefly so
# page loads don't hammer provider APIs.

_MODELS_CACHE: dict | None = None
_MODELS_CACHE_AT = 0.0
_MODELS_TTL = 60.0


def _provider_get(url: str, key_env: str | None) -> dict:
    """GET a provider JSON endpoint, with the API key as Bearer auth."""
    try:
        headers = {"Authorization": f"Bearer {os.getenv(key_env)}"} if key_env else None
        resp = httpx.get(url, headers=headers, timeout=8.0)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        logger.warning(f"models fetch failed ({url}): {e}")
        return {}


def _fetch_models() -> dict:
    """Live model list per capability (llm / stt / tts), key-gated."""
    providers = available_providers()
    llm: list[dict] = []
    stt: list[dict] = []
    tts: list[dict] = []

    if "cerebras" in providers:
        # Cerebras is chat-only (no STT/TTS). /v1/models is OpenAI-shaped and
        # lists what's live — it rotated llama3.1-8b and qwen-3-235b out in
        # May 2026 (they now 400 with deprecation errors), so show the roster
        # as-is and let the client surface any residual 400s verbatim.
        data = _provider_get("https://api.cerebras.ai/v1/models", "CEREBRAS_API_KEY")
        for m in data.get("data", []):
            mid = m["id"]
            if "embed" in mid.lower():
                continue
            llm.append({"provider": "cerebras", "id": mid, "label": mid})

    if "deepseek" in providers:
        data = _provider_get("https://api.deepseek.com/v1/models", "DEEPSEEK_API_KEY")
        for m in data.get("data", []):
            llm.append({"provider": "deepseek", "id": m["id"], "label": m["id"]})

    if "groq" in providers:
        data = _provider_get("https://api.groq.com/openai/v1/models", "GROQ_API_KEY")
        for m in data.get("data", []):
            mid = m["id"]
            low = mid.lower()
            if low.startswith("whisper"):
                stt.append({"provider": "groq", "id": mid, "label": mid})
            elif low.startswith(("playai", "cartesia", "eleven")) or "tts" in low or "orpheus" in low:
                # canopylabs/orpheus-* is Groq's TTS model (guard/safety ids
                # hide mid-string, so match substrings, not prefixes)
                tts.append({"provider": "groq", "id": mid, "label": mid})
            elif "prompt-guard" not in low and "safeguard" not in low:
                llm.append({"provider": "groq", "id": mid, "label": mid})

    if "gemini" in providers:
        data = _provider_get(
            f"https://generativelanguage.googleapis.com/v1beta/models?key={os.getenv('GEMINI_API_KEY')}",
            None,
        )
        # Google's speech-to-text aliases (short-form = voice-turn length) —
        # only when real Google credentials exist (no API-key auth for STT).
        if google_stt_available():
            stt.append({"provider": "google", "id": "latest_short", "label": "latest_short"})
            stt.append({"provider": "google", "id": "latest_long", "label": "latest_long"})
        # The list endpoint doesn't report output modalities (always None),
        # so classify from id/displayName. Capability slots (STT/TTS) get
        # their models first, whatever their preview/version status; the
        # brain picker then gets only stable, text-only chat models — no
        # previews, no image/audio/video/music/robot/agent models. (Nano
        # Banana / Lyria / Omni / robotics are display names, hence the
        # keyword match over both id and displayName.)
        NON_TEXT = (
            "image", "nano banana", "lyria", "veo", "robotics",
            "omni", "antigravity", "deep-research",
        )
        for m in data.get("models", []):
            mid = m.get("name", "").replace("models/", "")
            hay = (mid + " " + m.get("displayName", "")).lower()
            if "generateContent" not in (m.get("supportedGenerationMethods") or []):
                continue
            label = m.get("displayName") or mid
            if "transcribe" in hay or "speech-to-text" in hay or "speech" in hay:
                stt.append({"provider": "google", "id": mid, "label": label})
                continue
            if "tts" in hay or ("audio" in hay and "speech" in hay):
                tts.append({"provider": "gemini", "id": mid, "label": label})
                continue
            if mid.startswith("gemma") or "gemini-2." in mid:
                continue
            if "preview" in hay or any(k in hay for k in NON_TEXT):
                continue
            llm.append({"provider": "gemini", "id": mid, "label": label})

    if "openrouter" in providers:
        data = _provider_get("https://openrouter.ai/api/v1/models", "OPENROUTER_API_KEY")
        for m in data.get("data", []):
            if m["id"] in CURATED_OPENROUTER_MODELS:
                llm.append({"provider": "openrouter", "id": m["id"], "label": m.get("name") or m["id"]})
        # STT: the query param filters server-side (the per-model
        # output_modalities field is empty in the response), same shape as
        # OpenAI's roster endpoint. Sorted cheapest first — pricing.prompt is
        # $/second for duration-based models, $/input token for token-based
        # ones (which also bill completion); the picker label shows the rate
        # so the order is legible.
        stt_data = _provider_get(
            "https://openrouter.ai/api/v1/models?output_modalities=transcription",
            "OPENROUTER_API_KEY",
        )
        priced = []
        for m in stt_data.get("data", []):
            pricing = m.get("pricing") or {}
            prompt = pricing.get("prompt", "0")
            completion = pricing.get("completion", "0")
            try:
                in_price = float(prompt)
                out_price = float(completion)
            except (TypeError, ValueError):
                in_price = out_price = float("inf")
            def fmt(p: float) -> str:  # no trailing zeros: 0.36, not 0.36000000
                return f"{p:.8f}".rstrip("0").rstrip(".")

            if out_price > 0:  # token-based: rates per input/output token
                suffix = f" · ${fmt(in_price)} in + ${fmt(out_price)} out/tok"
            else:              # duration-based: $ per second of audio
                suffix = f" · ${fmt(in_price)}/s"
            priced.append(
                (
                    in_price + out_price,
                    {
                        "provider": "openrouter",
                        "id": m["id"],
                        "label": (m.get("name") or m["id"]) + suffix,
                    },
                )
            )
        for _, entry in sorted(priced, key=lambda e: e[0]):
            stt.append(entry)

    if "lmstudio" in providers:
        # List what the local server actually has loaded, so the picker is
        # live. LM Studio serves embedding models alongside chat ones — skip
        # them (same filtering as the Cerebras roster above).
        root = LMSTUDIO_BASE_URL.rstrip("/").rstrip("/v1")
        data = _provider_get(f"{root}/v1/models", "LMSTUDIO_API_KEY")
        for m in data.get("data", []):
            if "embed" in m["id"].lower():
                continue
            llm.append({"provider": "lmstudio", "id": m["id"], "label": m["id"]})

    # Local STT needs no API key — listed when sherpa-onnx is installed
    # (same pattern as the Kokoro voices below).
    if parakeet_stt.parakeet_stt_available():
        for mid, label in parakeet_stt.PARAKEET_MODELS.items():
            stt.append({"provider": "parakeet", "id": mid, "label": label})

    # Fine-tuned voice-model whisper: listed when the whisper.cpp server is up.
    if whisper_local_available():
        stt.append(
            {
                "provider": "whisper-local",
                "id": WHISPER_LOCAL_MODEL,
                "label": f"{WHISPER_LOCAL_MODEL} (voice fine-tune)",
            }
        )

    for voice in KOKORO_VOICES:
        tts.append({"provider": "kokoro", "id": voice, "label": voice})

    return {"llm": llm, "stt": stt, "tts": tts}


if __name__ == "__main__":
    from fastapi import Body, HTTPException
    from fastapi.responses import Response
    from fastapi.staticfiles import StaticFiles
    from pipecat.runner.run import app, main

    @app.get("/models")
    def models_endpoint() -> dict:
        global _MODELS_CACHE, _MODELS_CACHE_AT
        now = time.monotonic()
        if _MODELS_CACHE is None or now - _MODELS_CACHE_AT > _MODELS_TTL:
            _MODELS_CACHE = _fetch_models()
            _MODELS_CACHE_AT = now
        return _MODELS_CACHE

    @app.get("/sessions")
    def sessions_list() -> list[dict]:
        return sessions.list_sessions()

    @app.get("/sessions/{session_id}")
    def session_detail(session_id: str) -> dict:
        meta = sessions.get_session(session_id)
        if not meta:
            raise HTTPException(status_code=404, detail="Session not found")
        meta["messages"] = sessions.get_messages(session_id)
        return meta

    @app.patch("/sessions/{session_id}")
    def session_rename(session_id: str, payload: dict = Body(...)) -> dict:
        if not sessions.get_session(session_id):
            raise HTTPException(status_code=404, detail="Session not found")
        name = (payload.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name cannot be empty")
        sessions.rename_session(session_id, name)
        return {"ok": True}

    @app.delete("/sessions/{session_id}")
    def session_delete(session_id: str) -> dict:
        if not sessions.delete_session(session_id):
            raise HTTPException(status_code=404, detail="Session not found")
        return {"ok": True}

    @app.post("/speak", include_in_schema=False)
    def speak(payload: dict = Body(...)) -> Response:
        """One-shot TTS for the read-out page: {text, voice: {provider, id}} →
        a WAV file. Voice mapping mirrors run_bot — kokoro id → voice id,
        cloud id → model name (the roster's tts entries are models there).
        Unavailable providers fall back to the local kokoro voice, same as
        the chat path."""
        text = require_speak_text(payload.get("text"))
        provider, model, voice = resolve_speak_voice(payload)
        try:
            wav = speak_audio(text, provider, model, voice)
        except Exception as e:
            logger.warning(f"/speak failed ({provider}): {e}")
            raise HTTPException(status_code=502, detail=f"Speech failed: {e}")
        return Response(content=wav, media_type="audio/wav")

    def unique_path(dst: Path) -> Path:
        """If dst exists, pick the next Finder-style name — "read (2).mp3",
        "read (3).mp3"… — so an export never silently overwrites a file."""
        if not dst.exists():
            return dst
        stem, suffix = dst.stem, dst.suffix
        for n in range(2, 1000):
            candidate = dst.with_name(f"{stem} ({n}){suffix}")
            if not candidate.exists():
                return candidate
        return dst  # unreachable in practice — 998 names already taken

    @app.get("/export/defaults", include_in_schema=False)
    def export_defaults() -> dict:
        """Download-folder detection + ffmpeg availability. Detection is
        server-side — the browser can't see the filesystem, but the server is
        the user's machine and knows its own home directory."""
        return {"dir": detect_download_dir(), "ffmpeg": bool(shutil.which("ffmpeg"))}

    @app.post("/export", include_in_schema=False)
    def export(payload: dict = Body(...)) -> dict:
        """Save the read-out page's text as a file in a folder of the user's
        choice. The server re-synthesizes so the file written is exactly what
        the textarea holds: {text, voice, filename, dir, format, bitrate,
        title, album, artist, cover} → {path, size, format, command}. With
        ffmpeg available the file is compressed (mp3/m4a/opus) and tagged;
        without it, only wav can be saved."""
        text = require_speak_text(payload.get("text"))
        provider, model, voice = resolve_speak_voice(payload)
        fmt = (payload.get("format") or "mp3").lower()
        if fmt not in EXPORT_FORMATS:
            raise HTTPException(
                status_code=400, detail=f"Format must be one of: {', '.join(EXPORT_FORMATS)}."
            )
        try:
            bitrate = int(payload.get("bitrate") or EXPORT_DEFAULT_BITRATE)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Bitrate must be a number (kbps).")
        bitrate = max(16, min(bitrate, 512))

        stem = sanitize_stem(payload.get("filename"))
        out_dir = Path(payload.get("dir") or detect_download_dir()).expanduser()
        out_dir.mkdir(parents=True, exist_ok=True)

        title = (payload.get("title") or "").strip() or stem
        album = (payload.get("album") or "").strip()
        artist = (payload.get("artist") or "").strip()
        # Cover art comes either as a server-side path (typed by an advanced
        # user) or as uploaded bytes from the client's file picker
        # (cover_data/cover_name). The browser never reveals a picked file's
        # path, so the image must travel as data — uploads take precedence.
        cover = (payload.get("cover") or "").strip()
        cover_bytes: bytes | None = None
        cover_ext = ".jpg"
        cover_data = payload.get("cover_data")
        if cover_data is not None:
            if not isinstance(cover_data, str) or not cover_data.strip():
                raise HTTPException(status_code=400, detail="Cover image is empty.")
            if len(cover_data) > 25_000_000:  # ~18 MB decoded
                raise HTTPException(status_code=400, detail="Cover image is too large (max ~18 MB).")
            try:
                cover_bytes = base64.b64decode(cover_data, validate=True)
            except (ValueError, binascii.Error):
                raise HTTPException(status_code=400, detail="Cover image data is not valid base64.")
            if not cover_bytes:
                raise HTTPException(status_code=400, detail="Cover image is empty.")
            cover_ext = Path(payload.get("cover_name") or "").suffix.lower() or ".jpg"
        elif cover:
            cover_path = Path(cover).expanduser().resolve()
            if not cover_path.is_file():
                raise HTTPException(status_code=400, detail=f"Cover art not found: {cover}")
            cover = str(cover_path)
        if (cover_bytes is not None or cover) and fmt == "opus":
            raise HTTPException(
                status_code=400, detail="Cover art isn't supported in Opus (OGG) files — use mp3 or m4a."
            )

        try:
            wav = speak_audio(text, provider, model, voice)
        except Exception as e:
            logger.warning(f"/export synthesis failed ({provider}): {e}")
            raise HTTPException(status_code=502, detail=f"Speech failed: {e}")

        dst = unique_path(out_dir / f"{stem}.{fmt}")
        if fmt == "wav":
            dst.write_bytes(wav)
            return {"path": str(dst), "size": len(wav), "format": "wav", "command": None}

        if not shutil.which("ffmpeg"):
            raise HTTPException(
                status_code=503,
                detail="ffmpeg is not installed on the server — install it (e.g. `brew install ffmpeg`) or export as WAV.",
            )
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "input.wav"
            src.write_bytes(wav)
            cover_arg = cover
            if cover_bytes is not None:
                cover_file = Path(tmp) / f"cover{cover_ext}"
                cover_file.write_bytes(cover_bytes)
                cover_arg = str(cover_file)
            args = build_ffmpeg_args(src, dst, fmt, bitrate, title, album, artist, cover_arg)
            try:
                proc = subprocess.run(
                    ["ffmpeg", *args], capture_output=True, text=True, timeout=180
                )
            except subprocess.TimeoutExpired:
                raise HTTPException(status_code=500, detail="ffmpeg timed out.")
            if proc.returncode != 0:
                logger.warning(f"/export ffmpeg failed: {proc.stderr[-500:]}")
                raise HTTPException(status_code=500, detail=f"ffmpeg failed: {proc.stderr.strip()[-300:]}")
        return {
            "path": str(dst),
            "size": dst.stat().st_size,
            "format": fmt,
            "command": "ffmpeg " + " ".join(shell_quote(a) for a in args),
        }

    # Serve the built client from this same app — one process, one URL.
    # These must be registered BEFORE main(): the runner adds its own routes
    # (/start, /ws, /status, its "/" redirect to the prebuilt UI) during
    # main(), so anything we register here claims these paths first — and a
    # catch-all mount at "/" is out, it would shadow the runner's routes
    # entirely (its exact routes only win when they come first). Vite's dist
    # layout is fixed — index.html + assets/ + roles.json — so three
    # registrations cover it. Rebuild the client with `cd client &&
    # npm run build` after UI changes.
    dist = Path(__file__).parent / "client" / "dist"

    @lru_cache(maxsize=1)
    def _client_shell(root: Path, mtime: float) -> str:
        """index.html with relocatable (./assets) URLs made root-absolute.

        The chat route /s/<session_id> serves this shell: with base "./" the
        asset URLs would resolve under /s/... and 404, so rewrite them to
        /assets/... once and cache the result. Only the built bundle is
        relocatable — nothing else in the page is path-relative. Keyed on the
        file's mtime so a client rebuild invalidates it — otherwise the cached
        shell keeps naming asset files the rebuild just deleted."""
        return (root / "index.html").read_text().replace("./assets/", "/assets/")

    if (dist / "index.html").is_file():
        from fastapi.responses import FileResponse

        @app.get("/", include_in_schema=False)
        def client_index() -> FileResponse:
            return FileResponse(dist / "index.html")

        # Chat routes: /s/<session_id> is the client's "open conversation"
        # URL — reloads (and shared links) must land back in the app shell,
        # never a 404. A specific path, so unlike a catch-all it can't shadow
        # the runner's routes. The id is the client's payload, not ours.
        # The bundle is built relocatable (Vite base "./"), so its asset URLs
        # would resolve under /s/... — rewrite them root-absolute, cached.
        @app.get("/s/{session_id}", include_in_schema=False)
        def client_session() -> Response:
            index = dist / "index.html"
            return Response(content=_client_shell(dist, index.stat().st_mtime), media_type="text/html")

        @app.get("/roles.json", include_in_schema=False)
        def client_roles() -> FileResponse:
            return FileResponse(dist / "roles.json")

        if (dist / "assets").is_dir():
            app.mount("/assets", StaticFiles(directory=dist / "assets"), name="client-assets")

        logger.info(f"Serving the web client from {dist} — open http://localhost:7860")
    else:
        logger.warning(
            "client/dist not found — the UI won't be served here "
            "(run `cd client && npm run build` first)"
        )

    main()

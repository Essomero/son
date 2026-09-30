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
import json
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
from typing import Callable

import httpx
from dotenv import load_dotenv
from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    AudioRawFrame,
    InputAudioRawFrame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMRunFrame,
    LLMTextFrame,
    TranscriptionFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
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

import echo_guard
import parakeet_stt
import s1_mini
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
# text-normalizer model before the brain sees it.
#   unset → the local s1-mini server (s1_mini.py, served by `son start cleanup`)
#   ""    → disabled
#   else  → that model name at STT_CLEANUP_BASE_URL (e.g. LM Studio over a
#           tailnet, which is what this used to require)
STT_CLEANUP_MODEL = (
    s1_mini.DEFAULT_MODEL
    if (env := os.environ.get("STT_CLEANUP_MODEL")) is None
    else env.strip()
)
STT_CLEANUP_BASE_URL = os.environ.get("STT_CLEANUP_BASE_URL") or s1_mini.base_url()

STT_CLEANUP_SYSTEM_PROMPT = (
    "You are a text normalizer for speech-to-text transcripts. Fix "
    "punctuation, casing, and spacing only. You may remove filler words "
    "('um', 'uh') and exact duplicated phrases. NEVER remove, shorten, "
    "reword, or paraphrase content the speaker said — every meaningful "
    "word must appear in the output. Output only the cleaned text. If the "
    "input is a single word or fragment, output it as-is."
)

# Prompts for cleanup models that *are* instruct models (an LM Studio normalizer,
# say). The default model, s1-mini, is not one of those: it takes its own system
# prompt plus a control line and ignores these entirely — see s1_mini.py, where
# that contract lives.
#
# Web-speech finals use the format-only prompt below: the browser path's
# transcript is already faithful (no repeats, few fillers), so this pass adds
# punctuation/casing/spacing and touches nothing else — no filler removal, no
# dedup, no restructuring (an instruct normalizer happily rewrites "and milk
# eggs and bread" into a bulleted list; it must not here). The pipeline keeps
# the fuller prompt above.
STT_CLEANUP_WEB_PROMPT = (
    "You are a text formatter for speech-to-text transcripts. Add missing "
    "punctuation and fix casing and spacing only — for lists of items that "
    "means commas between them ('milk eggs and bread' -> 'milk, eggs, and "
    "bread'), never bullets or newlines. Do not remove, add, reword, "
    "reorder, or restructure anything the speaker said — keep fillers "
    "('um', 'uh'), repeats, and the original word order exactly as they "
    "are. Output ONLY the formatted text as one continuous line. If the "
    "input is a single word or fragment, output it as-is."
)

# Words the cleanup stage may drop without losing meaning; every other
# raw word must survive cleaning verbatim (see the guard in _clean). The
# fillers, plus the leading discourse markers the normalizer also drops
# (live: "um so i need to..." -> "I need to...") — a discarded "so" is
# worth more than losing the whole cleaned sentence to the guard.
CLEANUP_FILLERS = {"um", "uh", "hmm", "hm", "ah", "er", "eh", "so", "well", "like", "oh", "yeah", "okay"}


def _norm_words(s: str) -> set[str]:
    # Apostrophe-stripped so contractions match their un-contracted form
    # ("Let's" == "lets") — an apostrophe is punctuation, not a new word;
    # without this the guard rejects a perfect "lets" -> "Let's".
    return {w.replace("'", "") for w in re.findall(r"[a-z']+", s.lower())} - CLEANUP_FILLERS


# A cleanup endpoint that is down must not tax every turn: the first failure
# takes the stage out of the way for a while, so following utterances go
# straight to the raw transcript instead of each waiting out the timeout.
_CLEANUP_DOWN_UNTIL = 0.0
CLEANUP_RETRY_AFTER = 60.0


def cleanup_hot() -> bool:
    """Is there a cleanup model, and is the endpoint worth calling right now?"""
    return bool(STT_CLEANUP_MODEL) and time.monotonic() >= _CLEANUP_DOWN_UNTIL


def _mark_cleanup_down() -> None:
    global _CLEANUP_DOWN_UNTIL
    _CLEANUP_DOWN_UNTIL = time.monotonic() + CLEANUP_RETRY_AFTER
    logger.warning(f"cleanup unreachable — skipping cleanup for {int(CLEANUP_RETRY_AFTER)}s")


def _mark_cleanup_up() -> None:
    global _CLEANUP_DOWN_UNTIL
    _CLEANUP_DOWN_UNTIL = 0.0


def cleanup_messages(model: str, prompt: str, text: str) -> list[dict]:
    """The request's messages, chosen by model.

    s1-mini is *not* an instruct model — its card says it "will not follow
    general instructions" and that it is steered by a control line — so it needs
    its own system prompt plus `[Styling: …] [Structure: prose] [Context: …]`
    and ignores the chat-style prompts the other normalizers take. Keeping the
    choice here means the pipeline stage and the /cleanup route can't drift apart.
    """
    if s1_mini.is_s1_mini(model):
        return s1_mini.messages(text)
    return [
        {"role": "system", "content": prompt},
        {"role": "user", "content": text},
    ]


async def _clean_transcript_text(
    text: str,
    model: str,
    client: httpx.AsyncClient,
    prompt: str,
    on_guard: Callable[[str], None] | None = None,
) -> str | None:
    """One normalizer pass (model on `client`) with the word-survival guard.
    Shared by the pipeline stage (TranscriptCleanupProcessor, full cleanup
    prompt) and the /cleanup route (web-speech finals, format-only prompt).
    Returns "" on any failure — callers fall back to the raw text — and, for
    s1-mini, None when the utterance held nothing but noise (its documented
    output for filler), which callers should treat as "no utterance at all"."""
    if not cleanup_hot():
        return ""

    async def once() -> str:
        r = await client.post(
            "/chat/completions",
            json={
                "model": model,
                "messages": cleanup_messages(model, prompt, text),
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
        _mark_cleanup_up()
        # A thinking build can answer inside a thinking block (llama.cpp with
        # reasoning on, or a reasoning model behind LM Studio): that text is not
        # the answer, so it never survives the first look.
        cleaned = re.sub(r"(?s)^\s*<think(?:ing)?>.*?</think(?:ing)?>\s*", "", cleaned).strip()
        if not cleaned and not s1_mini.is_s1_mini(model):
            # The instruct normalizer occasionally emits nothing at all (empty
            # reasoning channel); one retry before falling back to the raw text.
            # s1-mini answering empty is *meaning* — see its branch below.
            cleaned = await once()
        # The formatter sometimes answers as a bulleted list no matter what
        # the prompt says ("...bought:\n- Milk\n- Eggs\n- Bread"). Flatten
        # deterministically so a list never reaches the transcript.
        cleaned = re.sub(r"(?m)^\s*[•*\-]\s*", "", cleaned)
        cleaned = re.sub(r"\s*\n\s*", " ", cleaned).strip()
        if s1_mini.is_s1_mini(model):
            # s1-mini's job *is* to drop fillers and resolve false starts
            # ("...send the report by friday no wait make that thursday" →
            # "...by Thursday."), so the word-survival guard below — written for
            # an instruct normalizer that deleted words by accident — would
            # reject exactly the good edits. Trust it, with two cheap checks: an
            # empty answer means the utterance was noise (nothing to send), and
            # an answer that balloons in length is not a cleanup.
            if not cleaned:
                return None
            if len(cleaned) > 2 * len(text) + 80:
                logger.warning(f"cleanup grew {len(text)} → {len(cleaned)} chars; keeping raw")
                return ""
            return cleaned
        missing = _norm_words(text) - _norm_words(cleaned)
        if cleaned and missing:
            # The normalizer sometimes "normalizes" by deleting or rewriting
            # words the speaker actually said (live: 'I love spreadsheets,
            # what's exciting about yours?' -> 'What's exciting about yours?',
            # and 'The last purchase was exciting about yours' -> a
            # same-length rewrite). A word-count ratio can't catch same-length
            # rewrites, so require every raw word (minus fillers) to survive.
            # Losing the user's words is worse than the raw text — fall back
            # to it.
            logger.warning(
                f"cleanup dropped words {sorted(missing)!r} "
                f"({text!r} -> {cleaned!r}); keeping raw"
            )
            if on_guard:
                on_guard(f"GUARD keep raw (missing {sorted(missing)!r}): {text!r} -> {cleaned!r}")
            return ""
        return cleaned
    except Exception as e:
        logger.warning(f"Transcript cleanup failed, passing raw text through: {e}")
        _mark_cleanup_down()
        return ""


# --- One-shot brain calls: the read page's "Clean with AI" --------------------
# Every provider is reachable through an OpenAI-compatible chat endpoint, so one
# code path serves all of them. The roots are the same hosts the /models probes
# use (they append /models), kept here so there is exactly one place that knows
# where each provider's API lives.
LLM_BASE_URLS = {
    "groq": "https://api.groq.com/openai/v1",
    "cerebras": "https://api.cerebras.ai/v1",
    "deepseek": "https://api.deepseek.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
    "openrouter": "https://openrouter.ai/api/v1",
    "lmstudio": LMSTUDIO_BASE_URL,
}

# What /rewrite sends when the caller brings no instruction. The read page sends
# the full audio prompt (client/src/lib/audioPrompt.ts, the same text its "Audio
# prompt" button copies); this is the short version for anything else.
DEFAULT_REWRITE_INSTRUCTION = (
    "Rewrite the text so it reads well aloud: plain prose, no markdown or math "
    "notation (say symbols in words), every sentence and list item preserved, "
    "no preamble and no closing note."
)


def llm_rewrite(text: str, instruction: str, provider: str, model: str) -> str:
    """One chat completion over the provider's OpenAI-compatible endpoint.

    Synchronous on purpose: the route that calls it is a plain `def`, which
    FastAPI runs in its threadpool — a minute-long rewrite must not hold the
    event loop that the panels, the CLI and the voice pipeline all share.
    """
    root = LLM_BASE_URLS.get(provider)
    if root is None:
        raise ValueError(f"unknown LLM provider '{provider}'")
    if provider == "lmstudio":
        key = os.getenv("LMSTUDIO_API_KEY")  # optional: the local server usually has none
    else:
        key = require_env(PROVIDER_ENV_KEYS[provider])
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    # Room for a rewrite (an article in, a comparable article out), capped so a
    # provider with a smaller ceiling still accepts the request.
    max_tokens = min(8192, max(2048, len(text) // 2))
    with httpx.Client(base_url=root, timeout=180.0) as client:
        r = client.post(
            "/chat/completions",
            headers=headers,
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": instruction},
                    {"role": "user", "content": text},
                ],
                "temperature": 0,
                "max_tokens": max_tokens,
            },
        )
        r.raise_for_status()
        message = r.json()["choices"][0]["message"]
        # A reasoning model may answer in its reasoning channel with `content`
        # empty (same fallback the transcript normalizer needs).
        return (message.get("content") or message.get("reasoning_content") or "").strip()


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
TTS_PROVIDER_ENV_KEYS = {
    "kokoro": None,
    "browser": None,  # Chrome speechSynthesis: the client speaks the text itself
    "piper": None,  # local piper1-gpl (piper-tts): in-process ONNX, no key
    "groq": "GROQ_API_KEY",
    "gemini": "GEMINI_API_KEY",
}

# Browser-native TTS voice roster (Chrome speechSynthesis, Google voices).
# id → the voice name Chrome reports; the client falls back to any Google
# English voice when the exact one is missing.
BROWSER_TTS_VOICES = {
    "google-us-english": "Google US English",
    "google-uk-english-female": "Google UK English Female",
    "google-uk-english-male": "Google UK English Male",
}

# Groq's Orpheus TTS accepts exactly these voice ids (API-enforced).
ORPHEUS_VOICES = ("autumn", "diana", "hannah", "austin", "daniel", "troy")
ORPHEUS_DEFAULT_VOICE = "hannah"

# Piper (piper1-gpl) — a tiny ONNX engine that runs in-process on CPU and
# streams its first audio in ~50 ms (kokoro's TTFB on a laptop is ~1.5 s for
# comparison; piper is also ~real-time for full sentences). id → display
# name; the roster is also the allowlist (the service would happily download
# ANY voice name — we only offer these).
PIPER_VOICES = {
    "en_US-amy-medium": "Amy (medium)",
    "en_US-lessac-medium": "Lessac (medium)",
    "en_US-ryan-high": "Ryan (high)",
    "en_US-hfc_male-medium": "HFC Male (medium)",
}
PIPER_DEFAULT_VOICE = "en_US-amy-medium"
PIPER_MODEL_DIR = Path(os.getenv("PIPER_MODEL_DIR", str(Path.home() / ".cache/son/piper")))
# pipecat's PiperTTSService downloads the voice into this directory but never
# creates it (download_voices.download_voice opens the file path directly), so
# a first run on a machine with no ~/.cache/son — or after the cache is
# cleared — dies with FileNotFoundError while the pipeline is being built, i.e.
# before the greeting. Creating it here means the download can do its job.
PIPER_MODEL_DIR.mkdir(parents=True, exist_ok=True)


# What the local-model warmup is doing, keyed by a human label:
# "downloading" → "ready" (or "failed: …"). Served in /models, so both clients
# can explain a first session that is connected but quiet — the model files have
# to exist before the pipeline can even be built.
_MODEL_WARMUP: dict[str, str] = {}


def ensure_piper_voice(voice: str) -> None:
    """Fetch a Piper voice's model now, if it isn't cached. Blocking.

    PiperTTSService downloads inside its constructor (~60 MB, one-time), which
    runs on the pipeline's task — see prewarm_local_models for why that must not
    happen there.
    """
    from piper.download_voices import download_voice

    if (PIPER_MODEL_DIR / f"{voice}.onnx").is_file():
        return
    logger.info(f"Piper: downloading voice '{voice}' (~60 MB, one-time) ...")
    PIPER_MODEL_DIR.mkdir(parents=True, exist_ok=True)
    download_voice(voice, PIPER_MODEL_DIR)


def ensure_kokoro_files() -> None:
    """Fetch Kokoro's model + voices now, if they aren't cached. Blocking.

    Uses pipecat's own helper and cache directory, so the paths stay in step with
    the service that will read them (a service that renamed the helper still does
    its own download — this is a prewarm, not a requirement).
    """
    from pipecat.services.kokoro import tts as kokoro_tts

    ensure = getattr(kokoro_tts, "_ensure_model_files", None)
    if ensure is None:
        return
    ensure(
        kokoro_tts.KOKORO_CACHE_DIR / "kokoro-v1.0.onnx",
        kokoro_tts.KOKORO_CACHE_DIR / "voices-v1.0.bin",
    )


def release_unused_models(stt_choice: dict | None) -> None:
    """Drop the cached local models the current picks don't need.

    The counterpart to prewarm_local_models: a cached Parakeet recognizer is
    ~600 MB and a cached read-aloud TTS service up to ~350 MB, so the caches
    follow *use*. A session keeps what its STT pick needs and releases the rest;
    a session that is over (`None`) releases everything, because then nothing is
    in use. The cost of a release is the rebuild on next use (~1.5 s Parakeet) —
    the trade for not holding a default machine's memory for the process's life.

    The pipeline builds its *own* TTS service per session, so only the one-shot
    read-aloud cache is dropped here.
    """
    keep = None
    if stt_choice and stt_choice.get("provider") == "parakeet":
        keep = stt_choice.get("model") or next(iter(parakeet_stt.PARAKEET_MODELS))
    parakeet_stt.release(keep)
    with _tts_services_guard:
        released = list(_tts_services)
        _tts_services.clear()
    if released:
        logger.info(f"TTS: released {len(released)} cached read-aloud service(s)")


async def prewarm_local_models(stt_choice: dict, tts_choice: dict) -> None:
    """Fetch/load the chosen local models in a worker thread, before the pipeline
    is built.

    Every local provider downloads on first use (Parakeet ~660 MB, a Piper voice
    ~60 MB, Kokoro ~354 MB) and Parakeet additionally builds a ~600 MB recognizer.
    Those are blocking calls, and this process serves the web page, /models,
    /roles and the browser extension from the *same event loop* as the pipeline:
    run there, a first-use download freezes every HTTP route, so the page and the
    extension look like they can't reach a bot that is in fact running. In a
    thread it costs the same wall time and blocks nothing.
    """
    for label, job in local_model_jobs(stt_choice, tts_choice):
        await asyncio.to_thread(warm_model, label, job)


def warm_default_models() -> None:
    """Fetch the models an untouched client will ask for — **files, not loads**.

    A Parakeet recognizer is ~600 MB resident once built, and building it at
    startup would hold that for an idle server's whole life. The build is ~1.5 s
    (the *download* is the slow part, and the part that froze the HTTP side), so it
    stays with the session that needs it, off the event loop — see
    prewarm_local_models.
    """
    defaults = default_choices()
    for label, job in local_model_jobs(defaults["stt"], defaults["tts"], load_recognizer=False):
        warm_model(label, job)
    # The default STT (browser Web Speech) has no local files — its fallback
    # does. Fetching Parakeet's ~643 MB now costs disk, never RAM, and is what
    # makes "Web Speech failed -> Parakeet" a 1.5 s switch rather than a
    # download the user waits through mid-sentence.
    fallback = stt_fallback_choice()
    if fallback != defaults["stt"]:
        warm_model(
            "parakeet model (stt fallback)",
            lambda: parakeet_stt.ensure_model_files(fallback["model"]),
        )
    # The cleanup model is part of the default stack now, so fetch its GGUF too
    # (files only, like everything here) when cleanup points at the local
    # server — otherwise the first utterance after a fresh clone pays 462 MB.
    if s1_mini.is_s1_mini(STT_CLEANUP_MODEL) and "127.0.0.1" in STT_CLEANUP_BASE_URL:
        warm_model("s1-mini cleanup model", s1_mini.ensure_gguf)


def warm_model(label: str, job: Callable[[], None]) -> None:
    """Run one blocking prewarm job, recording what it is doing for /models.

    The state is what lets both clients say *why* a first session is quiet:
    the files have to exist before the pipeline can be built, so an empty cache
    means a connected-but-silent bot for as long as the download takes.
    """
    _MODEL_WARMUP[label] = "downloading"
    started = time.monotonic()
    try:
        job()
    except Exception as e:
        _MODEL_WARMUP[label] = f"failed: {e}"
        logger.warning(f"Could not pre-fetch the {label}: {e}")
    else:
        _MODEL_WARMUP[label] = "ready"
        logger.info(f"{label}: ready ({time.monotonic() - started:.1f}s)")


def local_model_jobs(
    stt_choice: dict, tts_choice: dict, *, load_recognizer: bool = True
) -> list[tuple[str, Callable[[], None]]]:
    """The blocking prewarm jobs for these picks — the same resolution the
    service builders use, so the files fetched are the files they look for.

    `load_recognizer=False` fetches Parakeet's files without building the ~600 MB
    recognizer: what the startup thread wants (and what keeps an idle server
    small), versus what a session wants before its first turn.
    """
    jobs: list[tuple[str, Callable[[], None]]] = []
    if stt_choice.get("provider") == "parakeet":
        model = stt_choice.get("model") or next(iter(parakeet_stt.PARAKEET_MODELS))
        jobs.append(
            (
                "parakeet model",
                (lambda: parakeet_stt.prepare(model))
                if load_recognizer
                else (lambda: parakeet_stt.ensure_model_files(model)),
            )
        )
    if tts_choice.get("provider") == "piper":
        vid = tts_choice.get("model") if tts_choice.get("model") in PIPER_VOICES else None
        if vid is None and tts_choice.get("voice") in PIPER_VOICES:
            vid = tts_choice.get("voice")
        voice = vid or PIPER_DEFAULT_VOICE
        jobs.append(("piper voice", lambda: ensure_piper_voice(voice)))
    elif tts_choice.get("provider") == "kokoro":
        jobs.append(("kokoro model", ensure_kokoro_files))
    return jobs


def default_choices() -> dict:
    """The picks run_bot falls back to when a client sends none.

    Module level rather than inline in run_bot so the startup warmup prepares
    exactly what an untouched client will ask for.
    """
    return {
        "llm": {"provider": "groq", "model": GROQ_MODEL},
        # Browser Web Speech by default: recognition runs in the client, so a
        # server-side STT service is `None` and nothing is downloaded or held
        # resident for it. Parakeet is the *fallback* (see stt_fallback_choice),
        # not the default. A client that picks web-speech must run recognition
        # itself — one that sends no stt pick gets a bot that hears nothing, so
        # both shipped clients always send an explicit pick.
        "stt": {"provider": "web-speech", "model": "browser"},
        "tts": {"provider": "piper", "model": PIPER_DEFAULT_VOICE, "voice": None},
    }


def stt_fallback_choice() -> dict:
    """What a client switches to when browser Web Speech fails.

    The startup warmup pre-fetches these files (disk only, never loaded) so the
    switch is a ~1.5 s recognizer build instead of a 643 MB download in the
    middle of a conversation.
    """
    return {"provider": "parakeet", "model": next(iter(parakeet_stt.PARAKEET_MODELS))}


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


def build_stt_service(provider: str, model: str, echo_roll=None):
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
        return parakeet_stt.ParakeetSTTService(model=model, echo_roll=echo_roll)
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
    if provider == "browser":
        # Browser-native TTS (Chrome speechSynthesis): no server synthesis —
        # the client speaks the streamed LLM text itself.
        return None
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
    if provider == "piper":
        # piper-tts is GPL-3 — import lazily so plain son.py runs don't pay
        # the import cost, and a missing package only fails this branch.
        # Full module path: the package __init__ doesn't re-export the service.
        from pipecat.services.piper.tts import PiperTTSService

        # The client sends the piper voice id as `id` → model (display names
        # arrive in `voice` and are not model names): accept roster ids only.
        vid = model if model in PIPER_VOICES else None
        if vid is None and voice in PIPER_VOICES:
            vid = voice
        return PiperTTSService(
            settings=PiperTTSService.Settings(voice=vid or PIPER_DEFAULT_VOICE),
            download_dir=PIPER_MODEL_DIR,
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

# Read-aloud is one-shot, so ONE service stays resident: the voice just used.
# Anything else was "used once, kept for the process's life" — a Kokoro entry is
# ~350 MB, and reading aloud with three voices held all three. Switching back
# rebuilds (piper <1 s, kokoro a few seconds), which is the trade for not
# pinning a voice the user has moved on from. See also release_unused_models.
_TTS_CACHE_MAX = 1


def _get_tts_service(provider: str, model: str | None, voice: str | None):
    # The model belongs in the key: Piper carries its voice in `model` (the
    # roster `id`) and leaves `voice` empty, so (provider, voice) collapsed every
    # Piper voice onto one entry — read-aloud with a switched voice answered in
    # the first voice's audio.
    key = (provider, model, voice)
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
            # Age out the rest (insertion order is use order here: a hit keeps
            # its place, and only a miss builds).
            for stale in [k for k in _tts_services if k != key][
                : max(0, len(_tts_services) - _TTS_CACHE_MAX)
            ]:
                _tts_services.pop(stale, None)
                logger.info(f"TTS: released cached read-aloud service {stale}")
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
    if provider == "browser":
        # Browser speechSynthesis can't return a WAV — the read page needs
        # server-side synthesis, so fall back to the local voice (and drop
        # the browser voice id, which kokoro would reject).
        logger.warning("TTS provider 'browser' not usable for /speak; using kokoro")
        provider, choice = "kokoro", {"provider": "kokoro", "id": None}
    if provider == "kokoro":
        model, voice = None, choice.get("id")
    else:
        model, voice = choice.get("id"), choice.get("voice")
    if provider == "groq" and voice not in ORPHEUS_VOICES:
        logger.warning(f"Groq TTS voice '{voice}' invalid; using '{ORPHEUS_DEFAULT_VOICE}'")
        voice = ORPHEUS_DEFAULT_VOICE
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


# --- Audio labelling / conversion (POST /tag/*) ------------------------------
# Unlike /export, the source here is a file the user already owns: the browser
# uploads it, ffprobe reads its container and current tags, and ffmpeg writes a
# labelled (and optionally converted) copy into the chosen folder. The form
# edits *every* tag the file carries — not a fixed title/album/artist trio —
# so -map_metadata -1 drops the source's tags and the file ends up with exactly
# what the form shows, never an invisible merge. Re-encoding is opt-in: when the
# container is unchanged the audio stream is copied, so re-tagging is lossless
# and instant.

TAG_FORMATS = ("mp3", "m4a", "opus", "ogg", "flac", "wav")
TAG_BITRATES = (64, 96, 128, 192, 256, 320)
TAG_SAMPLE_RATES = (22050, 32000, 44100, 48000)
TAG_CHANNELS = (1, 2)
TAG_DEFAULT_BITRATE = 128  # kbps, when a re-encode doesn't name one
TAG_MAX_BYTES = 512 * 1024 * 1024  # an upload cap: audiobooks fit, accidents don't
TAG_MAX_TAGS = 64
TAG_MAX_VALUE = 20_000  # lyrics are long; anything past this is not a tag

# Container bookkeeping ffprobe reports as "tags" but that aren't labels:
# MP4 brand/handler atoms, muxer time stamps and ffmpeg's own encoder stamp.
# Left in, they would clutter the form and, re-emitted, some of them make
# ffmpeg reject the run (brand atoms aren't metadata) — and `encoder` is
# overwritten by ffmpeg on every write anyway, so offering it would be a lie.
TAG_IGNORE = frozenset({
    "major_brand", "minor_version", "compatible_brands", "creation_time",
    "handler_name", "vendor_id", "language", "encoder", "copyright",
})

# Container → codec. wav/flac are lossless, so a bitrate is meaningless there.
TAG_CODECS = {
    "mp3": "libmp3lame",
    "m4a": "aac",
    "opus": "libopus",
    "ogg": "libvorbis",
    "flac": "flac",
    "wav": "pcm_s16le",
}
TAG_LOSSLESS = ("flac", "wav")
# Containers whose picture channel ffmpeg can attach cover art to.
TAG_COVER_FORMATS = ("mp3", "m4a")

# Canonical label fields, in the order the form shows them. ffprobe reports a
# tag's key differently per container (ID3 "album_artist" vs Vorbis
# "ALBUMARTIST" vs MP4 "album_artist"), so each field lists the spellings it
# absorbs. Anything else the file carries is kept verbatim as an extra tag.
TAG_FIELDS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("title", "Title", ("title",)),
    ("artist", "Artist", ("artist",)),
    ("album", "Album", ("album",)),
    ("album_artist", "Album artist", ("album_artist", "albumartist", "album artist")),
    ("grouping", "Grouping / season name", ("grouping", "contentgroup", "group")),
    ("track", "Track", ("track", "tracknumber", "track_number")),
    ("disc", "Disc", ("disc", "discnumber", "disc_number")),
    ("date", "Year / date", ("date", "year", "originaldate")),
    ("genre", "Genre", ("genre",)),
    ("composer", "Composer", ("composer",)),
    ("comment", "Comment", ("comment", "description")),
    ("lyrics", "Lyrics", ("lyrics", "unsyncedlyrics", "unsynchronised_lyrics")),
)
_TAG_ALIASES = {alias: field for field, _, aliases in TAG_FIELDS for alias in aliases}


class TagError(Exception):
    """A user-facing failure in the Tag tool — a file ffprobe can't read, or an
    ffmpeg run that failed. The routes turn it into a 400/500 with its text."""


def normalize_tag_key(key: str) -> str:
    """ffprobe tag key → canonical field name, or the lowercased key itself.
    ffmpeg's -metadata takes a bare name, so fold it to that shape."""
    folded = re.sub(r"[^a-z0-9_]+", "_", key.strip().lower()).strip("_")
    return _TAG_ALIASES.get(key.strip().lower(), _TAG_ALIASES.get(folded, folded))


def container_format(format_name: str | None, codec: str | None) -> str | None:
    """ffprobe's format_name/codec_name → one of TAG_FORMATS, or None when the
    container isn't one this tool writes. None makes the client require an
    explicit output format (there is no safe "same container" default)."""
    fmt = (format_name or "").lower()
    name = (codec or "").lower()
    if "mp3" in fmt or name.startswith("mp3"):
        return "mp3"
    if "flac" in fmt or name == "flac":
        return "flac"
    if name.startswith("pcm_"):
        return "wav"
    if "opus" in fmt or name == "opus":
        return "opus"
    if "ogg" in fmt or name in ("vorbis", "opus"):
        return "ogg"
    if any(k in fmt for k in ("mp4", "m4a", "mov", "3gp")) or name in ("aac", "alac"):
        return "m4a"
    if "wav" in fmt:
        return "wav"
    return None


def probe_audio(path: Path, original_name: str | None = None) -> dict:
    """ffprobe one audio file → container, stream facts and its current tags.
    Raises TagError when the file has no readable audio stream."""
    proc = subprocess.run(
        [
            "ffprobe", "-v", "error", "-print_format", "json",
            "-show_format", "-show_streams", str(path),
        ],
        capture_output=True, text=True, timeout=120,
    )
    if proc.returncode != 0:
        raise TagError(proc.stderr.strip()[-300:] or "ffprobe could not read that file.")
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        raise TagError("ffprobe returned an unreadable report for that file.")
    streams = data.get("streams") or []
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not audio:
        raise TagError("No audio stream in that file.")
    fmt = data.get("format") or {}

    # Container tags first, then stream tags only where a key is still missing.
    tags: dict[str, str] = {}
    for source in (fmt.get("tags") or {}, audio.get("tags") or {}):
        for key, value in source.items():
            canon = normalize_tag_key(str(key))
            if value and canon and canon not in tags and canon not in TAG_IGNORE:
                tags[canon] = str(value)

    def as_int(value) -> int:
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return 0

    return {
        "name": original_name or path.name,
        "size": path.stat().st_size,
        "format": container_format(fmt.get("format_name"), audio.get("codec_name")),
        "container": str(fmt.get("format_name") or ""),
        "codec": str(audio.get("codec_name") or ""),
        "duration": round(float(fmt.get("duration") or audio.get("duration") or 0), 2),
        "bitrate": as_int(fmt.get("bit_rate") or audio.get("bit_rate")),
        "sample_rate": as_int(audio.get("sample_rate")),
        "channels": as_int(audio.get("channels")),
        "cover": any((s.get("disposition") or {}).get("attached_pic") for s in streams),
        "tags": tags,
    }


def sanitize_tags(raw) -> dict[str, str]:
    """A client-supplied tag map → ffmpeg-safe metadata. Keys become simple
    names ('-'/' ' fold to '_'); NULs are dropped because ffmpeg takes tags as
    literal argv, and empty values are omitted (an omitted key is a dropped
    tag — the form's blank field)."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for key, value in raw.items():
        if not isinstance(key, str) or value is None:
            continue
        name = normalize_tag_key(key)
        if not name or name in TAG_IGNORE:
            continue
        text = str(value).replace("\x00", "").strip()[:TAG_MAX_VALUE]
        if text:
            out[name] = text
        if len(out) >= TAG_MAX_TAGS:
            break
    return out


def build_tag_args(
    src: Path,
    dst: Path,
    fmt: str,
    *,
    tags: dict[str, str],
    copy_audio: bool,
    bitrate: int | None,
    sample_rate: int | None,
    channels: int | None,
    new_cover: str | None,
    keep_cover: bool,
) -> list[str]:
    """The exact ffmpeg arguments for one Tag save — executed as-is by the
    server and echoed (with "ffmpeg" prepended) to the client for display.
    `new_cover` is a path to a freshly picked image (a second input); otherwise
    `keep_cover` re-attaches the picture already in the source."""
    args = ["-y", "-i", str(src)]
    # Only mp3/m4a have a picture channel ffmpeg will fill; the route rejects a
    # new cover for any other container before we get here.
    coverable = fmt in TAG_COVER_FORMATS
    add_cover = coverable and (bool(new_cover) or keep_cover)
    if new_cover and coverable:
        args += ["-i", new_cover]
    args += ["-map", "0:a"]
    if add_cover:
        if new_cover:
            args += ["-map", "1:v", "-c:v", "copy", "-disposition:v", "attached_pic"]
        else:
            # The '?' makes a missing picture stream non-fatal (the source may
            # have lost its art since the probe).
            args += ["-map", "0:v?", "-c:v", "copy", "-disposition:v", "attached_pic"]
    if copy_audio:
        args += ["-c:a", "copy"]
    else:
        args += ["-c:a", TAG_CODECS[fmt]]
        if fmt not in TAG_LOSSLESS and bitrate:
            args += ["-b:a", f"{bitrate}k"]
        if sample_rate:
            args += ["-ar", str(sample_rate)]
        if channels:
            args += ["-ac", str(channels)]
    args += ["-map_metadata", "-1"]
    for key, value in tags.items():
        if key == "copyright":
            continue
        args += ["-metadata", f"{key}={value}"]
    if fmt == "m4a":
        args += ["-movflags", "+faststart"]
    if fmt == "mp3" and add_cover:
        args += ["-id3v2_version", "3", "-metadata:s:v", "title=Album cover",
                 "-metadata:s:v", "comment=Cover (front)"]
    args.append(str(dst))
    return args


def write_upload(file, dst: Path) -> int:
    """Spool an UploadFile to dst, refusing anything past TAG_MAX_BYTES.
    Chunked, because an audiobook is not a JSON string and must not become
    one. Raises TagError when the cap is crossed."""
    size = 0
    with dst.open("wb") as out:
        while True:
            chunk = file.file.read(1 << 20)
            if not chunk:
                break
            size += len(chunk)
            if size > TAG_MAX_BYTES:
                raise TagError(f"File is too large (max {TAG_MAX_BYTES // (1 << 20)} MB).")
            out.write(chunk)
    if not size:
        raise TagError("The file is empty.")
    return size


COVER_MAX_CHARS = 25_000_000  # ~18 MB decoded — a cover, not a wallpaper


def decode_cover_b64(data, name) -> tuple[bytes, str]:
    """A client-uploaded cover image (base64 payload + original file name) →
    (bytes, suffix). Shared by /export and /tag/save: neither can learn a picked
    file's path, so the image travels as data."""
    if not isinstance(data, str) or not data.strip():
        raise TagError("Cover image is empty.")
    if len(data) > COVER_MAX_CHARS:
        raise TagError("Cover image is too large (max ~18 MB).")
    try:
        blob = base64.b64decode(data, validate=True)
    except (ValueError, binascii.Error):
        raise TagError("Cover image data is not valid base64.")
    if not blob:
        raise TagError("Cover image is empty.")
    return blob, (Path(name or "").suffix.lower() or ".jpg")


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


def instruction_roles() -> list[dict]:
    """The instructions/ roster — the same entries scripts/gen_roles.py writes
    into the web client's roles.json, served from the source of truth instead.

    The browser extension connects to the server without ever loading the web
    bundle, so the roster can't come from client/dist/roles.json (which only
    exists once that bundle is built).
    """
    roles = []
    for path in sorted(INSTRUCTIONS_DIR.glob("*.md")):
        fields = sessions.parse_frontmatter_fields(
            path.read_text(encoding="utf-8", errors="replace")
        )
        roles.append(
            {
                "file": path.name,
                "name": fields.get("name") or path.stem,
                "description": fields.get("description") or "",
            }
        )
    return roles


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
    ("um", "uh"), word repeats. This stage sends every finalized utterance to a
    small local model (s1-mini, served on loopback by `son start cleanup`; see
    s1_mini.py) that returns clean prose, so the brain reads text that matches
    what was actually said. A model that answers with nothing — s1-mini's
    documented output for filler-only input — ends the turn here: there is no
    utterance to send.

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
        self._last_raw_at = 0.0  # monotonic time the last finalized frame arrived
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers={"Authorization": f"Bearer {api_key}"} if api_key else {},
            timeout=20.0,
        )

    def _debug_log(self, line: str) -> None:
        """Append one line to the cleanup debug log (bounded, best-effort).

        Terminal scrollback isn't recoverable after the fact, so the
        raw->cleaned history lands here too — the file that settles
        double-message / deletion reports."""
        try:
            path = Path.home() / ".cache" / "son" / "debug" / "cleanup.log"
            if path.exists() and path.stat().st_size > 1_000_000:
                path.unlink()  # debug instrument: start fresh, never grow
            with open(path, "a") as f:
                f.write(f"{time.strftime('%H:%M:%S')} {line}\n")
        except OSError:
            pass

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
            key = frame.text.strip().lower()
            now = time.monotonic()
            if key and key == self._last_raw and now - self._last_raw_at < 2.0:
                # Same text as the turn we just processed, within 2 s: a
                # double emission of the final frame, not a genuine repeat
                # (a real one needs speech + whisper + cleanup, >2 s). The
                # cleaned frame was already pushed — swallow the duplicate
                # so the transcript and son.db get one message per turn.
                logger.warning(
                    f"cleanup: duplicate finalized frame dropped ({frame.text!r})"
                )
                self._debug_log(f"DROP duplicate final: {frame.text!r}")
                return
            self._last_raw = key
            self._last_raw_at = now
            # Snapshot the turn-level telemetry BEFORE the cleanup await —
            # the roll keeps filling during the 1-3 s model call, so reading
            # it afterwards would describe the NEXT turn's audio.
            pre_turn_max, agc_turn_max = (
                capture.pre_turn_max,
                capture.agc_turn_max,
            )
            capture.pre_turn_max = -1.0
            capture.agc_turn_max = 1.0
            cleaned = await self._clean(frame.text)
            if cleaned is None:
                # s1-mini answered with nothing: the utterance was filler and
                # noise only, which its card documents as the correct output for
                # that input. There is no utterance to hand the brain, so the
                # turn ends here instead of sending noise for it to answer.
                logger.info(f"cleanup: {frame.text!r} -> (nothing said)")
                return
            # Debug instrument for repeated-phrase transcriptions: log the
            # raw/cleaned pair every turn, and when either side contains a
            # verbatim repeated n-gram dump the last ~25 s of mic audio
            # (pre- and post-filter) for replay.
            logger.info(f"cleanup: {frame.text!r} -> {cleaned!r}")
            self._debug_log(f"final: {frame.text!r} cleaned={cleaned!r}")
            if repeat_phrase(frame.text) or (cleaned and repeat_phrase(cleaned)):
                logger.warning(
                    "repeated phrase in transcript — audio dumped to "
                    "~/.cache/son/debug/repeat-*"
                )
                capture.dump(frame.text, cleaned)
            # Quiet-turn capture: the turn's loudest pre-filter frame was
            # <= -32 dBFS, or the AGC needed >= +6 dB — soft speech, the
            # user-reported failure case. Throttled/capped inside dump_quiet.
            if (
                0 < pre_turn_max <= 10 ** (-32 / 20)
                or agc_turn_max >= 2.0
            ):
                capture.dump_quiet(frame.text, pre_turn_max, agc_turn_max)
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
        return await _clean_transcript_text(
            text, self._model, self._client, STT_CLEANUP_SYSTEM_PROMPT, self._debug_log
        )

    async def cleanup(self):
        await self._client.aclose()
        await super().cleanup()


class EmptyTurnRetryProcessor(FrameProcessor):
    """Retry an LLM run that produced no speech text.

    Some model/provider hiccups answer a request with an empty completion
    (Gemini's MALFORMED_RESPONSE finish reason, a locally reloaded model
    returning nothing): the turn opens and closes with zero LLMTextFrame, so
    the user hears nothing and the bot never answers. Retry once — a second
    run of the same context usually succeeds (the observed recovery: the
    following utterance produced the full reply). Skips the retry when the
    run was interrupted by the user (a barge-in legitimately aborts it)."""

    def __init__(self):
        super().__init__()
        self._text_seen = False
        self._retried = False

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMFullResponseStartFrame):
            self._text_seen = False
            self._retried = False
        elif isinstance(frame, LLMTextFrame):
            self._text_seen = True
        elif isinstance(frame, InterruptionFrame):
            # A barge-in legitimately aborts the run — don't re-answer a
            # question the user already overrode.
            self._retried = True
        elif (
            isinstance(frame, LLMFullResponseEndFrame)
            and not self._text_seen
            and not self._retried
        ):
            self._retried = True
            logger.warning("LLM turn produced no text — retrying once")
            await self.push_frame(LLMRunFrame(), FrameDirection.UPSTREAM)
        await self.push_frame(frame, direction)


# --- page context (browser extension) -----------------------------------------
# The Chrome extension is a second client of this bot: a side panel that hears a
# spoken question about the page the user is reading. RTVI client messages would
# be the obvious transport for "here is my page", but they race the turn they
# describe — the context frame for a turn is built the instant the user stops
# speaking — so the extension POSTs what changed to /page-context and
# PageContextInjector attaches it to the conversation.
#
# The model is commit-once, replace-on-change — not inject-per-request:
#   - the page text enters the conversation when the panel first reports it and
#     *is history* from then on. Later turns send it as an ordinary stable
#     prefix (providers with prefix caching, Groq included, bill that at the
#     cached rate) instead of carrying a fresh copy at the end of every request;
#   - a new selection replaces the previous selection block and a new page
#     replaces the previous page block, so the context holds at most one of each
#     and the newest is what "this" / "this page" means;
#   - the panel sends a part only when it changed, so an unchanged page costs
#     nothing at all — not even a request — and a long conversation doesn't
#     re-pay for it turn after turn.
# That is why the registry holds *pending updates* rather than a current state:
# a push is an event ("this changed"), not a snapshot to re-assert.
#
# Process-local on purpose: the runner starts bot() with
# background_tasks.add_task on this same event loop (pipecat/runner/run.py), so
# the route and the pipeline share the dict. The HTTP thread never touches the
# context itself — the injector applies updates from the pipeline task, where
# mutating it is safe.

PAGE_CONTEXT_PAGE_MARKER = "[Page context — the page the user is reading"
PAGE_CONTEXT_SELECTION_MARKER = "[Page context — text the user selected"
PAGE_CONTEXT_MARKERS = (PAGE_CONTEXT_PAGE_MARKER, PAGE_CONTEXT_SELECTION_MARKER)
PAGE_CONTEXT_PAGE_MAX_CHARS = 40000  # ~10k tokens, paid once per page
PAGE_CONTEXT_SELECTION_MAX_CHARS = 6000
PAGE_CONTEXT_TTL_SECS = 6 * 60 * 60
# session_id -> [(kind, block, monotonic), ...] not yet attached to a request
_PAGE_CONTEXT_PENDING: dict[str, list[tuple[str, str, float]]] = {}
_PAGE_CONTEXT_LOCK = threading.Lock()


def queue_page_context(session_id: str, updates: list[tuple[str, str]]) -> None:
    """Queue blocks for a session, dropping sessions nobody touched within TTL.

    The prune rides on the write: only a live panel creates entries.
    """
    now = time.monotonic()
    with _PAGE_CONTEXT_LOCK:
        pending = _PAGE_CONTEXT_PENDING.setdefault(session_id, [])
        for kind, block in updates:
            # The same text twice in a row (a re-push after a reconnect, the
            # panel and a tab agreeing on one page): one block is enough.
            if pending and pending[-1][0] == kind and pending[-1][1] == block:
                continue
            pending.append((kind, block, now))
        for stale, entries in list(_PAGE_CONTEXT_PENDING.items()):
            if stale != session_id and (not entries or now - entries[-1][2] > PAGE_CONTEXT_TTL_SECS):
                del _PAGE_CONTEXT_PENDING[stale]


def take_page_context(session_id: str) -> list[tuple[str, str]]:
    """Drain the session's queued blocks (called from the pipeline task)."""
    with _PAGE_CONTEXT_LOCK:
        pending = _PAGE_CONTEXT_PENDING.pop(session_id, [])
    return [(kind, block) for kind, block, _ in pending]


def drop_page_context(session_id: str) -> None:
    with _PAGE_CONTEXT_LOCK:
        _PAGE_CONTEXT_PENDING.pop(session_id, None)


def build_page_context_updates(payload: dict) -> list[tuple[str, str]]:
    """Blocks to attach (or detach), one per part the panel actually sent.

    A field arrives only when that part changed (or when the user re-attached
    it), so an empty field means "nothing to say about it" rather than "forget
    it": the page the user has moved on from stays in the conversation as
    material they may still ask about, and the newest block is what "this page"
    refers to. `detach: ["page"]` is the explicit removal — the panel's chip is
    the control, and a detached part stops being sent with requests.
    """
    def text_field(key: str, cap: int) -> str:
        value = payload.get(key)
        if not isinstance(value, str):
            return ""
        value = value.strip()
        return value if len(value) <= cap else value[:cap].rstrip() + " …[truncated]"

    url = text_field("url", 400)
    title = text_field("title", 300)
    selection = text_field("selection", PAGE_CONTEXT_SELECTION_MAX_CHARS)
    page = text_field("page", PAGE_CONTEXT_PAGE_MAX_CHARS)
    updates: list[tuple[str, str]] = []
    requested_detach = payload.get("detach")
    if isinstance(requested_detach, list):
        for kind in ("page", "selection"):
            # An empty block IS the removal instruction — a block always carries
            # its marker header, so "" can't be mistaken for content.
            if kind in requested_detach:
                updates.append((kind, ""))
    if page:
        where = "\n".join(
            part for part in (f"URL: {url}" if url else "", f"Title: {title}" if title else "") if part
        )
        updates.append(
            (
                "page",
                "\n\n".join(
                    [f"{PAGE_CONTEXT_PAGE_MARKER} — not something the user said.]"]
                    + ([where] if where else [])
                    + ["Page text:\n" + page, 'Ground answers about "this page" in this text.']
                ),
            )
        )
    if selection:
        updates.append(
            (
                "selection",
                "\n\n".join(
                    [
                        f"{PAGE_CONTEXT_SELECTION_MARKER} — not something the user said.]",
                        selection,
                        'When the user says "this", "that" or "the snippet", they mean this text.',
                    ]
                ),
            )
        )
    return updates


def _message_content(message) -> str | None:
    content = message.get("content") if isinstance(message, dict) else getattr(message, "content", None)
    return content if isinstance(content, str) else None


def _page_context_marker(message) -> str | None:
    """Which kind of page-context block this message is, if it is one."""
    content = _message_content(message)
    if content is None:
        return None
    for marker in PAGE_CONTEXT_MARKERS:
        if content.startswith(marker):
            return marker
    return None


def _message_role(message) -> str | None:
    role = message.get("role") if isinstance(message, dict) else getattr(message, "role", None)
    return role if isinstance(role, str) else None


class PageContextInjector(FrameProcessor):
    """Attach queued page/selection blocks to the conversation, once each.

    Sits between the user aggregator and the LLM, so it sees every
    LLMContextFrame: a spoken turn, a typed one, or the aggregator-built frame
    for an LLMRunFrame. Each frame drains the session's queued updates and
    rewrites the shared context — set_messages, the documented "replace
    wholesale, don't persist" path, so the page never lands in son.db and a
    resumed session never replays a stale page.

    A block is placed immediately before the last user turn (the question it
    arrived with) and then left alone. It is history from that point on: later
    turns send it as part of the conversation rather than re-inserting it, which
    is what keeps an unchanged page from costing anything per turn. An update
    identical to the block already in the context is skipped, so a duplicate
    push or a reconnect that re-reports the same page changes nothing.
    """

    def __init__(self, session_id: str | None):
        super().__init__()
        self._session_id = session_id

    async def process_frame(self, frame, direction):
        # super() first: the base owns StartFrame handling — without it this
        # processor never marks itself started and push_frame drops every
        # frame (see TranscriptCleanupProcessor).
        await super().process_frame(frame, direction)
        if (
            direction == FrameDirection.DOWNSTREAM
            and self._session_id
            and isinstance(frame, LLMContextFrame)
        ):
            self._apply(frame.context)
        await self.push_frame(frame, direction)

    def _apply(self, context: LLMContext) -> None:
        updates = take_page_context(self._session_id)
        if not updates:
            return
        messages = list(context.messages)
        changes: list[str] = []
        for kind, block in updates:
            marker = PAGE_CONTEXT_PAGE_MARKER if kind == "page" else PAGE_CONTEXT_SELECTION_MARKER
            existing = [m for m in messages if _page_context_marker(m) == marker]
            if not block:
                # Explicit detach (the panel's chip): the block leaves the
                # conversation, so later requests stop carrying it.
                if existing:
                    messages = [m for m in messages if _page_context_marker(m) != marker]
                    changes.append(f"{kind}=-")
                continue
            if len(existing) == 1 and _message_content(existing[0]) == block:
                continue  # already in the conversation, byte for byte
            # Replace, never stack: the newest page/selection is the one "this"
            # and "this page" refer to.
            messages = [m for m in messages if _page_context_marker(m) != marker]
            # Before the question it arrived with, not after it — and where the
            # user's turn is, not simply last: the assistant may already have
            # replied (a barge-in), and a greeting's synthetic prompt sits where
            # a user turn would.
            index = next(
                (i for i in range(len(messages) - 1, -1, -1) if _message_role(messages[i]) == "user"),
                None,
            )
            if index is None:
                messages.append({"role": "user", "content": block})
            else:
                messages.insert(index, {"role": "user", "content": block})
            changes.append(f"{kind}={len(block)}c")
        if not changes:
            return
        context.set_messages(messages)
        logger.debug(
            f"page context: {' '.join(changes)} (session {self._session_id})"
        )


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
    defaults = default_choices()

    llm_choice = {**defaults["llm"], **(custom_data.get("llm") or {})}
    if llm_choice.get("provider") not in available_providers():
        logger.warning(f"LLM provider '{llm_choice.get('provider')}' unavailable; using groq")
        llm_choice = defaults["llm"]
    if llm_choice.get("id"):
        llm_choice["model"] = llm_choice["id"]  # client sends /models entries ({provider, id}); id wins over the default model

    stt_choice = {**defaults["stt"], **(custom_data.get("stt") or {})}
    stt_provider = stt_choice.get("provider")
    # "web-speech" is a browser-side STT (Chrome's SpeechRecognition): no
    # server service, text arrives via RTVI send-text. Keyless, always on.
    stt_available = stt_provider == "web-speech" or (
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
    # Groq's Orpheus TTS enforces its voice roster server-side; a kokoro
    # voice id (the merged default) would 400 the whole turn.
    if tts_choice.get("provider") == "groq" and tts_choice.get("voice") not in ORPHEUS_VOICES:
        logger.warning(
            f"Groq TTS voice '{tts_choice.get('voice')}' invalid; using '{ORPHEUS_DEFAULT_VOICE}'"
        )
        tts_choice["voice"] = ORPHEUS_DEFAULT_VOICE

    logger.info(
        f"Session: role={role_file} "
        f"llm={llm_choice['provider']}/{llm_choice.get('model')} "
        f"stt={stt_choice['provider']}/{stt_choice.get('model')} "
        f"tts={tts_choice['provider']}/{tts_choice.get('voice') or tts_choice.get('model')}"
        + (f" cleanup={STT_CLEANUP_MODEL}" if STT_CLEANUP_MODEL else "")
    )

    # This session's picks decide what stays resident: a switch from Parakeet to
    # Web Speech (or the other way) must not leave the other provider's ~600 MB
    # cached (see release_unused_models).
    release_unused_models(stt_choice)

    # Local models download/load on first use (Parakeet ~660 MB, then a ~600 MB
    # recognizer). Do it in a worker thread *before* the pipeline exists, or it
    # stalls the HTTP side of this process — the page, /models, the extension —
    # for as long as the download takes.
    await prewarm_local_models(stt_choice, tts_choice)

    # The echo guard's bot-audio roll: filled by the capture processor on the
    # TTS branch, queried by the local STT services (see echo_guard.py).
    echo_roll = echo_guard.BotAudioRoll()
    stt = (
        None
        if stt_choice["provider"] == "web-speech"  # text arrives via RTVI send-text
        else build_stt_service(stt_choice["provider"], stt_choice.get("model"), echo_roll)
    )
    llm = build_llm_service(llm_choice["provider"], llm_choice.get("model"), instruction)
    tts = (
        None
        if tts_choice["provider"] == "browser"  # client speaks the text itself
        else build_tts_service(tts_choice["provider"], tts_choice.get("model"), tts_choice.get("voice"))
    )

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
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(
                params=VADParams(
                    # Tuned for soft speech: pipecat's defaults (confidence
                    # 0.7, stop 0.2 s, min_volume 0.6) chop quiet turns at
                    # every soft dip — one sentence became five misheard
                    # fragments live. Lower thresholds, longer stop.
                    confidence=float(os.getenv("SON_VAD_CONFIDENCE", "0.5")),
                    start_secs=float(os.getenv("SON_VAD_START_SECS", "0.15")),
                    stop_secs=float(os.getenv("SON_VAD_STOP_SECS", "0.7")),
                    min_volume=float(os.getenv("SON_VAD_MIN_VOLUME", "0.35")),
                )
            )
        ),
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
    ]  # user audio -> speech -> text
    if stt is not None:
        stages.append(stt)  # absent for web-speech: text comes from the browser
    if cleanup:
        stages.append(cleanup)  # ... -> clean the raw transcript
    empty_retry = EmptyTurnRetryProcessor()
    stages.extend(
        [
            user_aggregator,    # user turns into conversation context
            # Extension page state -> the request the brain reads. Inert until
            # a panel pushes for this session.
            PageContextInjector(session_id),
            llm,                # next assistant reply
            empty_retry,  # one retry if the reply comes back empty (see class)
        ]
    )
    if tts is not None:
        # Kokoro local: text -> speech (markdown stripped in-service). Absent
        # for browser TTS: the client speaks the LLM text itself.
        stages.append(tts)
        # Tee the bot's audio into the echo guard roll (the STT tests its
        # candidate turns against this to drop the bot's own voice).
        stages.append(echo_guard.BotAudioCaptureProcessor(echo_roll))
    stages.extend(
        [
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
        # The panel re-pushes on its next connect, so dropping the block here
        # only keeps a dead session's page text out of memory.
        if session_id:
            drop_page_context(session_id)
        await runner.cancel()
        # Same reasoning for the model caches: nothing this session used is in
        # use once it is gone, and Parakeet is ~600 MB (release_unused_models).
        release_unused_models(None)

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
                # hide mid-string, so match substrings, not prefixes). The
                # API enforces its voice roster, so offer one entry per voice.
                # Only the English model is offered — the Arabic variant's
                # voices don't fit the roster.
                if "arabic" in low:
                    continue
                for voice in ORPHEUS_VOICES:
                    tts.append({"provider": "groq", "id": mid, "voice": voice, "label": f"Orpheus · {voice}"})
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
    # Browser-side STT (Chrome's SpeechRecognition): no server audio path,
    # text lands via RTVI send-text. Chrome-only by nature.
    stt.append({"provider": "web-speech", "id": "browser", "label": "Browser · Web Speech"})

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
    # Piper local voices — in-process ONNX, no API key, first audio in ~50 ms.
    for vid, vname in PIPER_VOICES.items():
        tts.append({"provider": "piper", "id": vid, "voice": vname, "label": f"Piper · {vname}"})
    # Browser-native TTS (Chrome speechSynthesis, Google neural voices): no
    # server audio path — the client speaks the streamed text. Voice names
    # vary per browser/OS; the client resolves and falls back.
    for vid, vname in BROWSER_TTS_VOICES.items():
        tts.append({"provider": "browser", "id": vid, "label": f"Browser · {vname}"})

    return {"llm": llm, "stt": stt, "tts": tts}


if __name__ == "__main__":
    from fastapi import Body, File, Form, HTTPException, UploadFile
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
        # Whether the transcript cleanup stage is on: the client hides the
        # raw web-speech text behind a loading bubble when it's available.
        # `cleanup_hot()` also goes false while a failed endpoint is sitting out
        # its retry window, so the client stops promising a cleanup that isn't
        # coming and shows the raw text straight away.
        return {**_MODELS_CACHE, "cleanup": cleanup_hot()}

    @app.get("/warming", include_in_schema=False)
    def warming_state() -> dict:
        """Local-model warmup state — deliberately its own route, not a field on
        /models: that one probes every configured provider and can take minutes
        on a cold cache, which is exactly when you want to know why a session is
        quiet (see _MODEL_WARMUP)."""
        return {"warming": dict(_MODEL_WARMUP)}

    @app.get("/roles", include_in_schema=False)
    def roles_roster() -> list[dict]:
        """Role roster for clients that don't load the web bundle (the browser
        extension): same shape as roles.json, straight from instructions/."""
        return instruction_roles()

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

    @app.post("/rewrite", include_in_schema=False)
    def rewrite(payload: dict = Body(...)) -> dict:
        """Rewrite text for reading aloud with the configured *brain*.

        This is the read page's "Clean with AI": the audio prompt goes in as the
        system message, the article as the user message, and the reply replaces
        the box. Unlike /cleanup — a format-only pass on a small local normalizer
        — a real model may restructure sentences, which is why the client keeps
        an undo for it. Runs in the threadpool (a plain `def`), so a long rewrite
        never blocks the shared event loop."""
        text = require_speak_text(payload.get("text"))
        instruction = (payload.get("instruction") or DEFAULT_REWRITE_INSTRUCTION).strip()
        choice = payload.get("llm") or {}
        fallback = default_choices()["llm"]
        provider = str(choice.get("provider") or fallback["provider"]).strip()
        model = str(choice.get("id") or choice.get("model") or fallback["model"]).strip()
        try:
            rewritten = llm_rewrite(text, instruction, provider, model)
        except Exception as e:
            logger.warning(f"/rewrite failed ({provider}/{model}): {e}")
            raise HTTPException(status_code=502, detail=f"Clean failed: {e}")
        if not rewritten:
            raise HTTPException(status_code=502, detail="Clean returned nothing.")
        logger.info(f"/rewrite: {len(text)} chars in, {len(rewritten)} out ({provider}/{model})")
        return {"text": rewritten, "provider": provider, "model": model}

    @app.post("/cleanup", include_in_schema=False)
    def cleanup(payload: dict = Body(...)) -> dict:
        """Punctuation/formatting pass for browser-side STT. Web-speech finals
        arrive via RTVI send-text and never enter TranscriptCleanupProcessor,
        so the client normalizes them here with the same model/prompt/guard
        before the brain sees the turn. Server-side STT (parakeet/groq/…)
        cleans in-pipeline and never calls this route. Failures return the
        original text — cleanup must never stall a turn."""
        text = (payload.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="Nothing to clean.")
        if not STT_CLEANUP_MODEL:
            raise HTTPException(
                status_code=503,
                detail="Cleanup disabled: set STT_CLEANUP_MODEL (a local model, e.g. on LM Studio).",
            )

        async def run() -> str:
            # A fresh client per call: httpx pools are bound to the event
            # loop the client was created in, and each asyncio.run spins a
            # new loop — a reused client dies with "Event loop is closed".
            # (The pipeline's processor keeps one client for its lifetime:
            # the pipecat loop never changes.)
            client = httpx.AsyncClient(
                base_url=STT_CLEANUP_BASE_URL,
                headers=(
                    {"Authorization": f"Bearer {os.getenv('LMSTUDIO_API_KEY')}"}
                    if os.getenv("LMSTUDIO_API_KEY")
                    else {}
                ),
                timeout=20.0,
            )
            try:
                # Web-speech finals are format-only: punctuation, casing,
                # spacing — nothing else (see STT_CLEANUP_WEB_PROMPT).
                return await _clean_transcript_text(
                    text, STT_CLEANUP_MODEL, client, STT_CLEANUP_WEB_PROMPT
                )
            finally:
                await client.aclose()

        cleaned = asyncio.run(run())
        if cleaned is None:
            # Noise only — the model is explicit that filler alone cleans to
            # nothing. Say so in a field, but still hand back the raw text so a
            # client that doesn't know about it behaves exactly as before.
            return {"text": text, "dropped": True}
        return {"text": cleaned or text}

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

    @app.post("/page-context", include_in_schema=False)
    def page_context_push(payload: dict = Body(...)) -> dict:
        """Attach the extension's page state to a live session.

        {session_id, url, title, selection, page, detach} — the panel sends a
        part only when it changed, and an empty part means "nothing to say about
        it", not "forget it" (the page the user moved on from stays in the
        conversation). `detach: ["page"]` removes an attached block, which is the
        chip's × — after that, requests stop carrying it.
        Returns the sizes actually queued so the panel can show what went in.
        Never 404s: the panel pushes the moment it connects, and a push for a
        session that already ended is harmless (the TTL reaps it).
        """
        session_id = (payload.get("session_id") or "").strip()
        if not session_id:
            raise HTTPException(status_code=400, detail="session_id is required")
        updates = build_page_context_updates(payload)
        if not updates:
            return {"page": 0, "selection": 0}
        queue_page_context(session_id, updates)
        sizes = {kind: len(block) for kind, block in updates}
        return {"page": sizes.get("page", 0), "selection": sizes.get("selection", 0)}

    @app.get("/export/defaults", include_in_schema=False)
    def export_defaults() -> dict:
        """Download-folder detection + ffmpeg/ffprobe availability. Detection is
        server-side — the browser can't see the filesystem, but the server is
        the user's machine and knows its own home directory. The Tag page needs
        the folder default and both binaries; the Read page's Export panel only
        ffmpeg (adding a field is additive)."""
        return {
            "dir": detect_download_dir(),
            "ffmpeg": bool(shutil.which("ffmpeg")),
            "ffprobe": bool(shutil.which("ffprobe")),
        }

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
            try:
                cover_bytes, cover_ext = decode_cover_b64(cover_data, payload.get("cover_name"))
            except TagError as e:
                raise HTTPException(status_code=400, detail=str(e))
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

    # --- Tag page: label and convert an uploaded audio file ----------------
    # Two multipart routes. /tag/inspect reads the file's container and every
    # tag it carries (ffprobe); /tag/save writes the edited version with ffmpeg.
    # The source is the user's own file, so it is spooled through a temp file
    # rather than synthesized like /export's.

    def require_binary(name: str) -> None:
        if not shutil.which(name):
            raise HTTPException(
                status_code=503,
                detail=f"{name} is not installed on the server — install ffmpeg "
                "(e.g. `brew install ffmpeg`) to label and convert audio files.",
            )

    def store_upload(file: UploadFile, tmp: str) -> Path:
        """Spool an upload into `tmp`, keeping its extension so ffmpeg can
        sniff the container. TagError (too large / empty) becomes a 400."""
        name = Path(file.filename or "").name
        suffix = Path(name).suffix.lower()
        if not re.fullmatch(r"\.[a-z0-9]{1,6}", suffix or ""):
            suffix = ".audio"
        src = Path(tmp) / f"source{suffix}"
        try:
            write_upload(file, src)
        except TagError as e:
            raise HTTPException(status_code=400, detail=str(e))
        return src

    @app.post("/tag/load", include_in_schema=False)
    def tag_load(payload: dict = Body(...)) -> dict:
        """Load audio files from a local filesystem folder or file path.
        When loading from a folder, returns the files and folder path so
        the client can set the save destination to that folder."""
        require_binary("ffprobe")
        raw_path = str(payload.get("path") or "").strip()
        if not raw_path:
            raise HTTPException(status_code=400, detail="Path is empty.")
        p = Path(raw_path).expanduser().resolve()
        if not p.exists():
            raise HTTPException(status_code=404, detail=f"Path not found: {raw_path}")

        files: list[Path] = []
        if p.is_file():
            folder = str(p.parent)
            files.append(p)
        elif p.is_dir():
            folder = str(p)
            for child in sorted(p.iterdir()):
                if child.is_file() and not child.name.startswith("."):
                    ext = child.suffix.lstrip(".").lower()
                    if ext in TAG_FORMATS or ext in ("mp3", "m4a", "wav", "flac", "ogg", "opus", "aac"):
                        files.append(child)
        else:
            raise HTTPException(status_code=400, detail="Path must be a file or directory.")

        if not files:
            raise HTTPException(status_code=404, detail="No supported audio files found at that path.")

        items = []
        for f in files:
            try:
                info = probe_audio(f, original_name=f.name)
                items.append({
                    "name": f.name,
                    "path": str(f),
                    "dir": str(f.parent),
                    "size": f.stat().st_size,
                    "info": info,
                    "error": None,
                })
            except Exception as e:
                items.append({
                    "name": f.name,
                    "path": str(f),
                    "dir": str(f.parent),
                    "size": f.stat().st_size,
                    "info": None,
                    "error": str(e),
                })

        return {"folder": folder, "files": items}

    @app.post("/tag/inspect", include_in_schema=False)
    def tag_inspect(file: UploadFile = File(...)) -> dict:
        """An uploaded audio file → its container, stream facts and all its
        tags, so the Tag page can show — and edit — exactly what it carries.
        Nothing is written; ffprobe only reads."""
        require_binary("ffprobe")
        with tempfile.TemporaryDirectory() as tmp:
            src = store_upload(file, tmp)
            try:
                return probe_audio(src)
            except TagError as e:
                logger.warning(f"/tag/inspect failed: {e}")
                raise HTTPException(status_code=400, detail=str(e))

    @app.post("/tag/save", include_in_schema=False)
    def tag_save(file: UploadFile = File(None), payload: str = Form("{}")) -> dict:
        """Write a labelled (and optionally converted) copy of an uploaded
        audio file into the folder of the user's choice. The multipart payload
        is JSON: {format, bitrate, sample_rate, channels, reencode, dir,
        filename, tags: {...}, cover_data, cover_name, keep_cover} →
        {path, size, format, copied, command}. With the container unchanged and
        `reencode` off the audio stream is copied, so re-tagging is lossless."""
        require_binary("ffprobe")
        try:
            opts = json.loads(payload or "{}")
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Options are not valid JSON.")
        if not isinstance(opts, dict):
            raise HTTPException(status_code=400, detail="Options must be a JSON object.")

        fmt = str(opts.get("format") or "").lower()
        if fmt not in TAG_FORMATS:
            raise HTTPException(
                status_code=400, detail=f"Format must be one of: {', '.join(TAG_FORMATS)}."
            )

        def pick_int(key: str, allowed: tuple[int, ...]) -> int | None:
            raw = opts.get(key)
            if raw in (None, ""):
                return None
            try:
                value = int(raw)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail=f"{key} must be a number.")
            if value not in allowed:
                raise HTTPException(
                    status_code=400,
                    detail=f"{key} must be one of: {', '.join(str(a) for a in allowed)}.",
                )
            return value

        bitrate = pick_int("bitrate", TAG_BITRATES)
        sample_rate = pick_int("sample_rate", TAG_SAMPLE_RATES)
        channels = pick_int("channels", TAG_CHANNELS)
        reencode = bool(opts.get("reencode"))

        local_path = str(opts.get("local_path") or "").strip()
        with tempfile.TemporaryDirectory() as tmp:
            if local_path and Path(local_path).is_file():
                src = Path(local_path).resolve()
                info = probe_audio(src, original_name=src.name)
            elif file:
                src = store_upload(file, tmp)
                original_name = Path(file.filename or "").name
                info = probe_audio(src, original_name=original_name)
            else:
                raise HTTPException(status_code=400, detail="No audio file or local path provided.")
            # Copy the stream only when the container is unchanged and the user
            # didn't ask to re-encode; anything else is a fresh encode.
            copy_audio = (not reencode) and info["format"] == fmt

            keep_cover = bool(opts.get("keep_cover")) and bool(info["cover"])
            new_cover: str | None = None
            if opts.get("cover_data") is not None:
                if fmt not in TAG_COVER_FORMATS:
                    raise HTTPException(
                        status_code=400,
                        detail="Cover art is only supported in MP3 and M4A — pick one of those, or remove the image.",
                    )
                try:
                    blob, suffix = decode_cover_b64(opts.get("cover_data"), opts.get("cover_name"))
                except TagError as e:
                    raise HTTPException(status_code=400, detail=str(e))
                cover_path = Path(tmp) / f"cover{suffix}"
                cover_path.write_bytes(blob)
                new_cover = str(cover_path)
                keep_cover = False
            if fmt not in TAG_COVER_FORMATS:
                keep_cover = False  # opus/ogg/flac/wav carry no picture channel here

            stem = sanitize_stem(opts.get("filename") or info["name"])
            raw_dir = str(opts.get("dir") or "").strip()
            if raw_dir:
                p_dir = Path(raw_dir).expanduser()
                if p_dir.is_file() or (not p_dir.is_dir() and p_dir.suffix.lower() in [f".{f}" for f in TAG_FORMATS]):
                    out_dir = p_dir.parent
                else:
                    out_dir = p_dir
            elif local_path and Path(local_path).is_file():
                out_dir = Path(local_path).resolve().parent
            else:
                out_dir = Path(detect_download_dir()).expanduser()

            out_dir.mkdir(parents=True, exist_ok=True)
            overwrite = bool(opts.get("overwrite", True))
            target = out_dir / f"{stem}.{fmt}"
            if overwrite:
                dst = Path(tmp) / f"output_tagged.{fmt}"
            else:
                dst = unique_path(target)
            args = build_tag_args(
                src,
                dst,
                fmt,
                tags=sanitize_tags(opts.get("tags")),
                copy_audio=copy_audio,
                bitrate=bitrate or TAG_DEFAULT_BITRATE,
                sample_rate=sample_rate,
                channels=channels,
                new_cover=new_cover,
                keep_cover=keep_cover,
            )
            try:
                proc = subprocess.run(
                    ["ffmpeg", *args], capture_output=True, text=True, timeout=600
                )
            except subprocess.TimeoutExpired:
                raise HTTPException(status_code=500, detail="ffmpeg timed out.")
            if proc.returncode != 0:
                logger.warning(f"/tag/save ffmpeg failed: {proc.stderr[-500:]}")
                raise HTTPException(status_code=500, detail=f"ffmpeg failed: {proc.stderr.strip()[-300:]}")

            if overwrite:
                shutil.move(str(dst), str(target))
                final_dst = target
            else:
                final_dst = dst

        return {
            "path": str(final_dst),
            "size": final_dst.stat().st_size,
            "format": fmt,
            "copied": copy_audio,
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

    # Warm the default local models while the server is otherwise idle. The
    # pipeline cannot be built until its STT/TTS files exist, so on an empty cache
    # a first session would otherwise sit connected-but-silent for the length of a
    # ~660 MB download. A daemon thread keeps every HTTP route answering
    # throughout, and /models reports the state as `warming` for the clients.
    threading.Thread(target=warm_default_models, name="model-warmup", daemon=True).start()

    main()

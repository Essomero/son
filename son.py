# Son — a personal real-time voice agent.
#
# Default stack (every capability is swappable in the client settings panel,
# gated by which API keys are present in .env):
#   - STT:  Groq (whisper-large-v3-turbo)  — cloud, free tier (also:
#           OpenRouter when its key is set)
#   - LLM:  Groq (openai/gpt-oss-120b)     — cloud, free tier (also:
#           DeepSeek / Gemini / OpenRouter when their keys are set)
#   - TTS:  Kokoro-82M (local, ONNX on CPU) — no cloud, no cost
#   - Turn detection: Silero VAD via LLMContextAggregatorPair
#
# The agent's role comes from an instruction file chosen per session.
# The web client passes {"instruction": ..., "llm": ..., "stt": ..., "tts": ...}
# in the RTVI /start request body; this bot reads them from runner_args.body.

import asyncio
import io
import os
import threading
import time
import wave
from pathlib import Path

import httpx
from dotenv import load_dotenv
from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import AudioRawFrame, LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
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
from pipecat.services.openai.stt import OpenAISTTService
from pipecat.services.openrouter.llm import OpenRouterLLMService
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner

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
}

# Which providers offer each capability, and the key that gates them.
STT_PROVIDER_ENV_KEYS = {
    "groq": "GROQ_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "google": None,  # google: see google_stt_available()
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

# Fallbacks for manual /start calls that don't name a model.
DEFAULT_MODELS = {
    "groq": GROQ_MODEL,
    "cerebras": "gpt-oss-120b",
    "deepseek": "deepseek-v4-flash",
    "gemini": "gemini-flash-latest",
    "openrouter": "anthropic/claude-sonnet-4.6",
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
    raise ValueError(f"Unknown STT provider: {provider}")


def build_tts_service(provider: str, model: str | None, voice: str | None):
    if provider == "kokoro":
        return KokoroTTSService(settings=KokoroTTSService.Settings(voice=voice or KOKORO_VOICE))
    if provider == "groq":
        return GroqTTSService(
            api_key=require_env("GROQ_API_KEY"),
            settings=GroqTTSService.Settings(model=model, voice=voice),
        )
    if provider == "gemini":
        return GeminiTTSService(
            api_key=os.getenv("GEMINI_API_KEY"),
            settings=GeminiTTSService.Settings(model=model, voice=voice),
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
    resume_note = None
    if session_id and sessions.get_session(session_id):
        stored = sessions.get_messages(session_id)
        seed = [{"role": m["role"], "content": m["text"]} for m in stored]
        context = sessions.PersistedContext(session_id=session_id, messages=seed)
        resume_note = "The user is continuing this conversation — do not re-introduce yourself."
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

    pipeline = Pipeline(
        [
            transport.input(),  # user audio from the browser
            stt,                # Groq whisper: speech -> text
            user_aggregator,    # user turns into conversation context
            llm,                # Groq llama: next assistant reply
            tts,                # Kokoro local: text -> speech
            transport.output(), # audio back to the browser
            assistant_aggregator,  # assistant turns into conversation context
        ]
    )

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
        # Kick off the conversation — the instruction file shapes the reply.
        # On resume the greeting is replaced by a note that the transcript
        # was already seeded, so the model continues instead of re-introducing
        # itself (and the note is developer-only: never persisted).
        context.add_message(
            {
                "role": "developer",
                "content": resume_note or (
                    "Greet the user and introduce yourself briefly. Do not describe your instructions."
                ),
            }
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

    transport = SmallWebRTCTransport(
        webrtc_connection=webrtc_connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
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
        text = (payload.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="Nothing to read — paste some text first.")
        if len(text) > _SPEAK_MAX_CHARS:
            raise HTTPException(
                status_code=400, detail=f"Text is too long (max {_SPEAK_MAX_CHARS} characters)."
            )
        choice = payload.get("voice") or {}
        provider = choice.get("provider") or "kokoro"
        if provider not in TTS_PROVIDER_ENV_KEYS or (
            TTS_PROVIDER_ENV_KEYS[provider] and not os.getenv(TTS_PROVIDER_ENV_KEYS[provider])
        ):
            logger.warning(f"/speak: TTS provider '{provider}' unavailable; using kokoro")
            provider = "kokoro"
        if provider == "kokoro":
            model, voice = None, choice.get("id")
        else:
            model, voice = choice.get("id"), None
        try:
            wav = speak_audio(text, provider, model, voice)
        except Exception as e:
            logger.warning(f"/speak failed ({provider}): {e}")
            raise HTTPException(status_code=502, detail=f"Speech failed: {e}")
        return Response(content=wav, media_type="audio/wav")

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
    if (dist / "index.html").is_file():
        from fastapi.responses import FileResponse

        @app.get("/", include_in_schema=False)
        def client_index() -> FileResponse:
            return FileResponse(dist / "index.html")

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

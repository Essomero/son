# Son — a personal real-time voice agent.
#
# Tier 3 hybrid stack:
#   - STT:  Groq (whisper-large-v3-turbo)  — cloud, free tier
#   - LLM:  Groq (llama-3.3-70b-versatile) — cloud, free tier
#   - TTS:  Kokoro-82M (local, ONNX on CPU) — no cloud, no cost
#   - Turn detection: Silero VAD via LLMContextAggregatorPair
#
# The agent's role comes from an instruction file chosen per session.
# The web client passes {"instruction": "study-buddy.md"} in the RTVI
# /start request body; this bot reads it from runner_args.body.

import os
from pathlib import Path

from dotenv import load_dotenv
from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.types import RunnerArguments
from pipecat.services.groq.llm import GroqLLMService
from pipecat.services.groq.stt import GroqSTTService
from pipecat.services.kokoro.tts import KokoroTTSService
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner

load_dotenv(override=True)

INSTRUCTIONS_DIR = Path(__file__).parent / "instructions"
DEFAULT_INSTRUCTION = "default.md"

# Groq is OpenAI-compatible; these live on the base service.
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_STT_MODEL = os.getenv("GROQ_STT_MODEL", "whisper-large-v3-turbo")
KOKORO_VOICE = os.getenv("KOKORO_VOICE", "af_heart")


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
    instruction = load_instruction(custom_data.get("instruction"))
    logger.info(f"Starting session with instruction: {Path(instruction).name}")

    stt = GroqSTTService(
        api_key=require_env("GROQ_API_KEY"),
        settings=GroqSTTService.Settings(model=GROQ_STT_MODEL),
    )

    llm = GroqLLMService(
        api_key=require_env("GROQ_API_KEY"),
        settings=GroqLLMService.Settings(
            model=GROQ_MODEL,
            system_instruction=instruction,
        ),
    )

    tts = KokoroTTSService(
        settings=KokoroTTSService.Settings(
            voice=KOKORO_VOICE,
        ),
    )

    context = LLMContext()
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
        context.add_message(
            {"role": "developer", "content": "Greet the user and introduce yourself briefly. Do not describe your instructions."}
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


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()

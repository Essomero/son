"""The local STT cleanup model: acquisition, and the one correct way to ask it.

`s1-mini` (superwhisper) is a 0.6B Qwen3 fine-tune that does a single job: turn a
raw ASR transcript into clean written text — punctuation, casing, spoken numbers
and dates written out ("twenty five dollars" → "$25"), fillers dropped, false
starts resolved to what the speaker actually landed on. It is **not** an instruct
model: its card is explicit that it "will not follow general instructions" and
that it is steered by a *control line*, so the prompt shape lives here rather than
being improvised per call site.

Hosting: the q4_k_m GGUF (~462 MB) is served by `llama-server` (llama.cpp) on
loopback — the same shape as the whisper.cpp service the CLI already manages — so
cleanup runs locally with no LM Studio in the loop. Measured on this machine:
462 MB on disk, ~980 MB resident while serving, 126-314 ms per utterance (versus
the ~20 s timeouts a dead tailnet LM Studio was costing per turn).

Alternatives that were measured and rejected: the same model in fp16 through
transformers (1.2 GB of weights, ~2 GB resident), and a generic 0.5B instruct
model, which rewrote words the speaker said and so failed the word-survival guard
on every test input.

Stdlib only, on purpose: `scripts/son` imports this from a plain system Python
(no venv) to fetch the model and start the server.
"""

from __future__ import annotations

import os
import urllib.request
from pathlib import Path

DEFAULT_MODEL = "s1-mini"
REPO_ID = "superwhisper/s1-mini-GGUF"
GGUF_NAME = "s1-mini-q4_k_m.gguf"
DOWNLOAD_URL = f"https://huggingface.co/{REPO_ID}/resolve/main/{GGUF_NAME}"
CACHE_DIR = Path.home() / ".cache" / "son" / "s1-mini"
GGUF_PATH = CACHE_DIR / GGUF_NAME
DEFAULT_PORT = int(os.environ.get("SON_CLEANUP_PORT", "8090"))

# Verbatim from the model card: "Required. Use this exact system prompt."
SYSTEM_PROMPT = (
    "You are a text normalizer for speech-to-text transcripts. The input begins "
    "with a control line specifying the styling, structure, and context settings; "
    "clean the transcript to match those settings and output only the cleaned text."
)


def is_s1_mini(model: str | None) -> bool:
    """Does this cleanup model want the control-line contract (not a prompt)?"""
    return bool(model) and "s1-mini" in str(model).lower()


def port() -> int:
    return int(os.environ.get("SON_CLEANUP_PORT", str(DEFAULT_PORT)))


def base_url() -> str:
    """The local llama-server's OpenAI-compatible root."""
    return f"http://127.0.0.1:{port()}/v1"


def control_line(styling: str = "semi-formal", structure: str = "prose", context: str = "general") -> str:
    """The line the model reads instead of instructions.

    `structure: prose` is what Son wants everywhere: one continuous passage, no
    bullets and no blank lines (a dictation that turns into a markdown list is
    exactly what the old normalizer had to be talked out of).
    """
    return f"[Styling: {styling}] [Structure: {structure}] [Context: {context}]"


def messages(
    transcript: str,
    *,
    styling: str = "semi-formal",
    structure: str = "prose",
    context: str = "general",
) -> list[dict]:
    """The chat messages s1-mini was trained on: system, control line, transcript."""
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"{control_line(styling, structure, context)}\n{transcript}"},
    ]


def ensure_gguf(*, log=print) -> Path:
    """Return the GGUF's path, downloading it once if needed.

    Streamed to `.part` and renamed, so an interrupted download never leaves a
    half file that llama-server would try (and fail) to load.
    """
    if GGUF_PATH.is_file():
        return GGUF_PATH
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    partial = GGUF_PATH.with_suffix(GGUF_PATH.suffix + ".part")
    log(f"  fetching {GGUF_NAME} (~462 MB, one time) → {CACHE_DIR}")
    with urllib.request.urlopen(DOWNLOAD_URL, timeout=120) as response, partial.open("wb") as out:
        total = int(response.headers.get("content-length") or 0)
        done = 0
        step = 32 * 1024 * 1024
        while True:
            chunk = response.read(1024 * 256)
            if not chunk:
                break
            out.write(chunk)
            done += len(chunk)
            if total and done // step != (done - len(chunk)) // step:
                log(f"    {done / 1e6:.0f} / {total / 1e6:.0f} MB")
    partial.replace(GGUF_PATH)
    log(f"  ok {GGUF_NAME} ({GGUF_PATH.stat().st_size / 1e6:.0f} MB)")
    return GGUF_PATH


def server_installed() -> str | None:
    """Path to `llama-server`, or None. `SON_LLAMA_SERVER` overrides the lookup."""
    override = os.environ.get("SON_LLAMA_SERVER")
    if override:
        return override if Path(override).is_file() else None
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        candidate = Path(directory) / "llama-server"
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None

#!/usr/bin/env python3
"""A/B the quiet-speech captures across local STT models.

Feeds every ~/.cache/son/debug/quiet-* capture (pre- and post-filter) to a
model and prints its transcript per capture, so the quiet-speech failures
in docs/RESEARCH-QUIET-SPEECH.md can be re-judged per model. Models share
one interface: (wav_path) -> text. No API keys, no audio leaving the box;
model weights download on first use.

    uv run python scripts/bench_stt_models.py parakeet   # the in-repo Parakeet TDT v3

GLM-ASR-Nano-2512 and FunASR-Nano-2512 had runners here until the
2026-08-20 A/B ruled them out (see docs/RESEARCH-QUIET-SPEECH.md §4) — the
harness keeps only models still in contention.

Captures whose reference phrase is known (docs/RESEARCH-QUIET-SPEECH.md §2)
are scored with WER; the rest print the raw transcript for a human verdict.
"""

import argparse
import wave
from pathlib import Path

import numpy as np

# Ground truth from docs/RESEARCH-QUIET-SPEECH.md §2, by capture timestamp.
# Only the rows whisper heard CORRECTLY are included — 171839/174654 are
# whisper's mishears (no known ground truth), so scoring a model against
# them would credit whoever repeats whisper's mistake.
REFERENCE = {
    "174756": "I'm just swimming with a flow",
    "175059": "I don't know much, just chilling.",
    "175228": "Nothing more, just chilling.",
}

DEFAULT_CAPTURES = Path.home() / ".cache" / "son" / "debug"


def load_wav(path: Path, rate: int = 16000) -> np.ndarray:
    """Read a mono int16 WAV and return float32 in [-1, 1] at `rate` Hz."""
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        n = w.getnframes()
        data = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    if sr != rate:
        # resample_poly keeps the phase right for speech; captures are
        # 48 kHz (pre-chain mic) or 16 kHz (post-chain), so this is a
        # straight 1/3 or 1/1 step.
        from scipy.signal import resample_poly

        gcd = np.gcd(sr, rate)
        data = resample_poly(data, rate // gcd, sr // gcd)
    return data


def wer(reference: str, hypothesis: str) -> float:
    from jiwer import wer as jiwer_wer

    return jiwer_wer(reference, hypothesis)


# --- model runners: each returns (text, note) ---------------------------------


def run_parakeet(path: Path) -> tuple[str, str]:
    from parakeet_stt import PARAKEET_MODELS, _get_recognizer

    model_id = next(iter(PARAKEET_MODELS))
    recognizer, _ = _get_recognizer(model_id)
    samples = load_wav(path)
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, samples)
    recognizer.decode_stream(stream)
    return stream.result.text.strip(), "parakeet-tdt-0.6b-v3 int8 (cpu)"


RUNNERS = {
    "parakeet": run_parakeet,
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("model", choices=[*RUNNERS, "all"], nargs="?", default="all")
    ap.add_argument("--dir", type=Path, default=DEFAULT_CAPTURES)
    args = ap.parse_args()

    picks = list(RUNNERS) if args.model == "all" else [args.model]
    for pick in picks:
        fn = RUNNERS[pick]
        print(f"\n== {pick} ==")
        # Both the raw mic audio (pre) and the enhanced chain output (post)
        # — pre shows whether the model survives raw quiet audio on its own.
        for wav in sorted(args.dir.glob("quiet-*.wav")):
            # quiet-20260820-171839-post.wav -> parts[2] = HHMMSS stamp
            stamp, which = wav.name.split("-")[2], "pre" if "-pre." in wav.name else "post"
            ref = REFERENCE.get(stamp)
            text, note = fn(wav)
            tag = f"WER {wer(ref, text):.2f}" if ref else "no reference"
            print(f"{stamp} {which:4s}  {note}  {tag}  {text!r}")


if __name__ == "__main__":
    main()

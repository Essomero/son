#!/usr/bin/env python3
"""Offline A/B of SON_DENOISE=0 on the quiet captures.

Replays each ~/.cache/son/debug/quiet-*-pre.wav (raw 16 kHz mic audio)
through the live enhancement chain frame-by-frame in two variants — the
full chain (RNNoise -> multiband AGC, what the recorder does today) and
the chain with the RNNoise stage skipped (SON_DENOISE=0) — writing both
16 kHz outputs to --out. Both variants start cold (gain 1.0), so the
comparison is fair *within* the sim; the transcripts the .txt notes
record for the 17:xx captures predate the multiband AGC (commit a904fe0,
18:18) and only the 18:xx batch replays the current chain faithfully
(docs/RESEARCH-QUIET-SPEECH.md §3A.4). Transcribe the outputs yourself:

    uv run python scripts/ab_denoise.py --out <dir>
    <whisper-cli> -m ggml-whisper-small-son-soft.bin -f <dir>/quiet-*-nodenoise.wav
"""

import argparse
import asyncio
import sys
import wave
from pathlib import Path

import numpy as np

from audio_filters import MultibandAGCFilter, RNNoiseFilter

# Live pipeline feeds the filter chain 20 ms audio-in frames; RNNoise
# buffers internally to 480 samples anyway, and the AGC adapts per frame.
SAMPLE_RATE = 16000  # the transport's rate — captures and chain output are 16 kHz
FRAME_SAMPLES = 320  # 20 ms @ 16 kHz

WHISPER = (
    Path.home() / ".cache" / "son" / "whisper.cpp" / "build" / "bin" / "whisper-cli"
)
MODEL = (
    Path.home() / ".cache" / "son" / "whisper.cpp" / "models"
    / "ggml-whisper-small-son-soft.bin"
)


def load_pre(path: Path) -> np.ndarray:
    """int16 mono samples of a raw pre-chain capture (16 kHz)."""
    with wave.open(str(path), "rb") as w:
        assert w.getframerate() == SAMPLE_RATE, (
            f"{path.name}: {w.getframerate()} Hz, not {SAMPLE_RATE}"
        )
        assert w.getnchannels() == 1, f"{path.name}: expected mono"
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return data


async def run_chain(samples: np.ndarray, denoise: bool) -> np.ndarray:
    """Feed `samples` through the live chain; return the int16 result."""
    filters: list = []
    if denoise:
        filters.append(RNNoiseFilter())
    filters.append(MultibandAGCFilter())
    for f in filters:
        await f.start(SAMPLE_RATE)

    out = bytearray()
    for i in range(0, len(samples), FRAME_SAMPLES):
        chunk = samples[i : i + FRAME_SAMPLES].astype(np.int16).tobytes()
        for f in filters:
            chunk = await f.filter(chunk)  # RNNoise may buffer; AGC passes through
        out += chunk
    return np.frombuffer(bytes(out), dtype=np.int16) if out else np.empty(0, dtype=np.int16)


def write_wav(path: Path, samples: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(samples.tobytes())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--captures",
        type=Path,
        default=Path.home() / ".cache" / "son" / "debug",
    )
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    for pre in sorted(args.captures.glob("quiet-*-pre.wav")):
        stamp = pre.name.split("-")[2]
        samples = load_pre(pre)
        for variant, denoise in (("denoise", True), ("nodenoise", False)):
            enhanced = asyncio.run(run_chain(samples, denoise))
            if not len(enhanced):
                print(f"{stamp} {variant}: EMPTY chain output", file=sys.stderr)
                continue
            out = args.out / f"quiet-{stamp}-{variant}.wav"
            write_wav(out, enhanced)
            print(f"{stamp} {variant:9s} -> {out.name} ({len(enhanced)} samples)")
            # Sanity: where the output sits relative to whisper's input range.
            rms = float(np.sqrt(np.mean((enhanced.astype(np.float64) / 32768.0) ** 2)))
            print(f"              rms {20*np.log10(rms + 1e-12):+.1f} dBFS")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Offline A/B of enhancement-chain variants on the quiet captures.

Replays each ~/.cache/son/debug/quiet-*-pre.wav (raw 16 kHz mic audio)
through the enhancement chain frame-by-frame in three variants, writing
the 16 kHz outputs to --out:

- denoise    — RNNoise -> multiband AGC (what the recorder does today)
- nodenoise  — multiband AGC only (the SON_DENOISE=0 question, §3A.4)
- hp-scalar  — 90 Hz HP + ONE scalar gain (the lever-1 simplification of
               the user's "min amplitude, just scale gain" idea — the old
               single-band AGC had no high-pass, which is why its gain
               went to the rumble; this is the never-tested version)

All variants start cold (gain 1.0), so comparisons are fair *within* the
sim; the transcripts the .txt notes record for the 17:xx captures
predate the multiband AGC (commit a904fe0, 18:18) and only the 18:xx
batch replays the current chain faithfully (docs/RESEARCH-QUIET-SPEECH.md
§3A.4). Transcribe the outputs yourself:

    uv run python scripts/ab_denoise.py --out <dir>
    <whisper-cli> -m ggml-whisper-small-son-soft.bin -f <dir>/quiet-*-nodenoise.wav
"""

import argparse
import asyncio
import sys
import wave
from pathlib import Path

import numpy as np
from pipecat.audio.filters.base_audio_filter import BaseAudioFilter
from pipecat.frames.frames import FilterControlFrame, FilterEnableFrame

from audio_filters import MultibandAGCFilter, RNNoiseFilter, _BiquadChain

# Live pipeline feeds the filter chain 20 ms audio-in frames; RNNoise
# buffers internally to 480 samples anyway, and the AGC adapts per frame.
SAMPLE_RATE = 16000  # the transport's rate — captures and chain output are 16 kHz
FRAME_SAMPLES = 320  # 20 ms @ 16 kHz


class ScalarAGC(BaseAudioFilter):
    """90 Hz high-pass + one scalar gain (the lever-1 simplification).

    The pre-multiband GainAGCFilter (git history, commit a904fe0^) was
    exactly "measure RMS, scale gain" — with NO high-pass — and the
    captures show why it failed: the 0-250 Hz band sat 20-40 dB above the
    speech band, so the RMS measurement spent the gain budget on the
    rumble and the intelligibility band stayed below whisper's mel floor.
    This variant strips the rumble first (the same one-pole 90 Hz HP the
    multiband chain uses) and then applies the multiband's per-frame
    attack/release/gate + peak limiter to the whole signal: target
    -18 dBFS, max +24 dB, gate -45 dB.
    """

    def __init__(
        self,
        target_db: float = -18.0,
        max_gain_db: float = 24.0,
        gate_db: float = -45.0,
    ) -> None:
        self._target = 10 ** (target_db / 20)
        self._max_gain = 10 ** (max_gain_db / 20)
        self._gate = 10 ** (gate_db / 20)
        self._gain = 1.0
        self._filtering = True
        self._hp = None

    async def start(self, sample_rate: int):
        fs = float(sample_rate)
        r = np.exp(-2.0 * np.pi * 90.0 / fs)
        self._hp = _BiquadChain([(1.0, -1.0, 0.0, -r, 0.0)])
        self._gain = 1.0

    async def stop(self):
        pass

    async def process_frame(self, frame: FilterControlFrame):
        if isinstance(frame, FilterEnableFrame):
            self._filtering = frame.enable

    async def filter(self, audio: bytes) -> bytes:
        if not self._filtering or len(audio) < 2 or self._hp is None:
            return audio
        x = np.frombuffer(audio, dtype=np.int16).astype(np.float64) / 32768.0
        x = self._hp.process(x)
        rms = float(np.sqrt(np.mean(x ** 2) + 1e-12))
        if rms >= self._gate:
            desired = min(self._target / rms, self._max_gain)
            # attack faster than release: normalize quickly, let go slowly
            rate = 0.6 if desired > self._gain else 0.08
            self._gain = (1 - rate) * self._gain + rate * desired
        else:
            # Below the gate: slowly release the held gain so pauses
            # don't sit with the floor boosted.
            self._gain = 1.0 + (self._gain - 1.0) * 0.95
        out = x * self._gain
        # Same peak-aware limiter as the multiband chain (-1 dBFS).
        peak = float(np.max(np.abs(out)))
        if peak > 1e-6:
            out = out * min(1.0, 10 ** (-1.0 / 20) / peak)
        return (np.clip(out, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()

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


# Variant name -> filter chain (fresh instance per capture).
VARIANTS: dict[str, list] = {
    "denoise": [RNNoiseFilter, MultibandAGCFilter],
    "nodenoise": [MultibandAGCFilter],
    "hp-scalar": [ScalarAGC],
}


async def run_chain(samples: np.ndarray, filter_classes: list) -> np.ndarray:
    """Feed `samples` through a chain; return the int16 result."""
    filters = [cls() for cls in filter_classes]
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
        for variant, filter_classes in VARIANTS.items():
            enhanced = asyncio.run(run_chain(samples, filter_classes))
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

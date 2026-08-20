#!/usr/bin/env python3
"""Prepare Nigerian-accented English training data for whisper fine-tuning.

Round 1 sources:
  - AfriSpeech-200 (intronhealth/afrispeech-200, CC-BY-NC-SA-4.0 — personal
    use only; a published model must be trained on permissive data instead)
    The corpus is ~75% Nigerian accents; we take the largest ones, subsample
    each to a per-accent budget, and resample to 16 kHz mono WAV for whisper.

Per-accent configs download only that accent's tar shards (the "all" config
would stream the whole 200h corpus). Budgets cap yoruba/igbo/hausa so the
tail accents still get a voice.

Output (data_dir/): wav/*.wav, train.jsonl, dev.jsonl — one JSON line per
clip: {"path": <abs wav path>, "text": <transcript>, "duration": s,
"accent": <accent>}. Dev clips come from AfriSpeech's own dev split (its
speakers are separate from train's).
"""

import argparse
import json
import math
from pathlib import Path

import soxr
import soundfile as sf
from datasets import load_dataset
from loguru import logger

DATASET = "intronhealth/afrispeech-200"
SAMPLE_RATE = 16000
AVG_CLIP_S = 10.0  # AfriSpeech train clips average ~10.8s; used to size strides

# Accent -> train cap in minutes. Big three dominate the corpus; the rest get
# enough to add speaker/region diversity without diluting the signal.
CAP_MINUTES = {
    "yoruba": 40, "igbo": 40, "hausa": 40, "ijaw": 25, "idoma": 20,
    "igala": 12, "ebira": 10, "urhobo": 10, "ibibio": 10, "izon": 10,
    "pidgin": 10, "isoko": 8, "fulani": 8, "efik": 6, "esan": 6,
    "english": 5,
}


def _rows(accent: str, split: str):
    """All rows of one accent/split (tar is downloaded once, cached by HF)."""
    return load_dataset(DATASET, accent, split=split)


def _save(accent: str, row, idx: int, wav_dir: Path) -> float | None:
    """Decode the row's audio (44.1 kHz float32) to 16 kHz PCM_16 WAV.

    Returns the written duration, or None when the clip is unusable.
    """
    try:
        audio = row["audio"]
        arr, sr = audio["array"], audio["sampling_rate"]
        if arr.ndim > 1:
            arr = arr.mean(axis=1)
        if sr != SAMPLE_RATE:
            arr = soxr.resample(arr, sr, SAMPLE_RATE)
        sf.write(wav_dir / f"{accent}_{idx}.wav", arr, SAMPLE_RATE, subtype="PCM_16")
        return float(len(arr)) / SAMPLE_RATE
    except Exception as e:
        logger.warning(f"skip {accent}/{idx}: {e}")
        return None


def _strided(rows, cap_sec: float, out: list, tag: str, wav_dir: Path, offset: int = 0):
    """Decode rows with a deterministic stride until the cap (or rows run out).

    The stride spreads the sample across the accent's speakers instead of
    taking the first N clips from the tar.
    """
    target = max(1, int(cap_sec / AVG_CLIP_S))
    step = max(1, math.ceil(len(rows) / target))
    accrued = 0.0
    n = 0
    for i in range(0, len(rows), step):
        if accrued >= cap_sec:
            break
        dur = _save(tag, rows[i], offset + n, wav_dir)
        if dur is None:
            continue
        text = (rows[i].get("transcript") or "").strip()
        if not text or dur < 0.5 or dur > 28.0:
            continue
        out.append({"path": str(wav_dir / f"{tag}_{offset + n}.wav"),
                    "text": text, "duration": dur, "accent": tag})
        accrued += dur
        n += 1
    logger.info(f"{tag}: kept {n} clips ({accrued / 60:.1f} min)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", type=Path,
                    default=Path.home() / ".cache" / "son" / "finetune" / "round1")
    ap.add_argument("--budget-hours", type=float, default=6.0)
    ap.add_argument("--dev-clips", type=int, default=40)
    args = ap.parse_args()

    budget_sec = args.budget_hours * 3600
    caps = {a: min(CAP_MINUTES[a] * 60, budget_sec) for a in CAP_MINUTES}
    total = sum(caps.values())
    if total > budget_sec:  # scale caps so the mix hits the total budget
        scale = budget_sec / total
        caps = {a: c * scale for a, c in caps.items()}
    logger.info("Train caps (min): " +
                ", ".join(f"{a}={c / 60:.1f}" for a, c in sorted(caps.items(), key=lambda x: -x[1])))

    wav_dir = args.data_dir / "wav"
    wav_dir.mkdir(parents=True, exist_ok=True)

    train, dev = [], []
    dev_budget = args.dev_clips / max(1, len(CAP_MINUTES))
    for accent, cap in caps.items():
        train_rows = _rows(accent, "train")
        _strided(train_rows, cap, train, accent, wav_dir)
        dev_rows = _rows(accent, "dev")
        _strided(dev_rows, dev_budget * AVG_CLIP_S, dev, accent, wav_dir,
                 offset=1_000_000)

    with open(args.data_dir / "train.jsonl", "w") as f:
        for r in train:
            f.write(json.dumps(r) + "\n")
    with open(args.data_dir / "dev.jsonl", "w") as f:
        for r in dev:
            f.write(json.dumps(r) + "\n")

    t_h = sum(r["duration"] for r in train) / 3600
    d_h = sum(r["duration"] for r in dev) / 3600
    logger.info(f"Done: {len(train)} train clips ({t_h:.2f}h), "
                f"{len(dev)} dev clips ({d_h:.2f}h) -> {args.data_dir}")


if __name__ == "__main__":
    main()

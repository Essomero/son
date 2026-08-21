#!/usr/bin/env python3
"""Fine-tune openai/whisper-small.en on the user's recorded voice.

Data: the studio's recordings/ tree (~/.cache/son/finetune/recordings/) —
per-batch manifests under recordings/batch-*/manifest.jsonl, rows
{id, text, duration, path} (+ batch). SON_BATCHES (comma-separated ids)
restricts which batches train; empty = all. Rows with an empty transcript
(ad-lib free talk) are unsupervised and skipped. Clips are already
16 kHz mono 16-bit WAV.

Runs on CUDA when available (GCP T4), else MPS (Apple Silicon), else CPU.
5 epochs over ~500 short clips is minutes on a T4, tens of minutes on MPS.

Output: finetune/out/whisper-small-son/ (HF format, ready for
whisper.cpp's models/convert-h5-to-ggml.py).

Run:  uv run python finetune/train_whisper.py
"""

import json
import os
import random
from dataclasses import dataclass
from pathlib import Path

import jiwer
import numpy as np
import soundfile as sf
import torch
from loguru import logger
from transformers import (
    Seq2SeqTrainer,
    Seq2SeqTrainingArguments,
    TrainerCallback,
    WhisperForConditionalGeneration,
    WhisperProcessor,
)

# SON_RECORDINGS_DIR overrides the data root (the studio server uses the
# same override, so tests can point training at a scratch dir).
RECORDINGS = Path(os.environ.get(
    "SON_RECORDINGS_DIR",
    str(Path.home() / ".cache" / "son" / "finetune" / "recordings"),
))
# SON_BATCHES restricts training to a comma-separated set of batch ids
# (e.g. "batch-1-normal,batch-2-quiet"); empty = all batches.
SON_BATCHES = os.environ.get("SON_BATCHES", "")
# SON_OUT_DIR overrides the output name (e.g. the augmented retrain writes
# whisper-small-son-soft so the live model is never clobbered).
OUT_DIR = Path(os.environ.get(
    "SON_OUT_DIR",
    str(Path(__file__).resolve().parent / "out" / "whisper-small-son"),
))
MODEL_ID = "openai/whisper-small.en"
SEED = 42
DEV_FRAC = 0.05          # hold out for WER
MAX_EPOCHS = 5
BATCH = 4                # per device; grad accumulation 4 -> effective 16
                         # fp16 halves the 30 s-padded activations (~10 GiB fp32
                         # at batch 4 thrashed the 16 GiB machine; ~5 GiB fp16
                         # fits comfortably, and fp16 GEMMs are 2x faster)

device = ("cuda" if torch.cuda.is_available()
          else "mps" if torch.backends.mps.is_available()
          else "cpu")
logger.info(f"device: {device}")


# ————— soft-speech augmentation —————
# The real-use failure mode is quiet speech against a constant room-noise
# floor (SNR collapse). Plain gain attenuation does not reproduce it —
# verified on the dev set: 0.15x clean audio still transcribes perfectly,
# because the noise floor scales down with the speech. So the quiet
# variants mix noise at realistic SNRs: the REAL room tone when a take
# exists (recordings/noise/noise_0000.wav — measured floor ~-61 dBFS,
# quiet speech lands 14-27 dB above it), pink noise otherwise. Deterministic
# per clip id (one rng per variant), so reruns are reproducible. Dev rows
# are never augmented — the held-out WER stays comparable across runs.
AUG_VARIANTS = [
    (1.00, None),   # original
    (0.50, None),   # half volume, clean
    (0.35, None),   # soft voice, clean
    (0.35, 15.0),   # soft voice, room noise at 15 dB SNR
    (0.20, 10.0),   # very soft, 10 dB SNR
    (0.12, 5.0),    # whisper-quiet, 5 dB SNR
]


def load_room_tone():
    """The real room floor (recordings/noise/noise_0000.wav), or None.

    Landed by the recorder's room-tone modal; travels with the GCP bundle
    (train_on_gcp.sh tars the whole recordings/ dir). Falls back to pink
    noise in augment() when absent.
    """
    p = RECORDINGS / "noise" / "noise_0000.wav"
    if not p.exists():
        return None
    arr, sr = sf.read(p, dtype="float32")
    if sr != 16000:
        logger.warning(f"room tone sample rate {sr} != 16000; using pink noise")
        return None
    logger.info(f"room tone: {p.name} {len(arr) / sr:.0f}s "
                f"RMS {20 * np.log10(np.sqrt(np.mean(arr ** 2))):.1f} dBFS")
    return arr


ROOM_TONE = load_room_tone()


def pink_noise(n: int, rng: random.Random) -> np.ndarray:
    """White noise shaped to a 1/sqrt(f) spectrum — room-like ambience."""
    np_rng = np.random.default_rng(rng.randrange(2 ** 32))
    spec = np.fft.rfft(np_rng.standard_normal(n))
    freqs = np.fft.rfftfreq(n)
    freqs[0] = freqs[1]          # avoid the DC divide
    return np.fft.irfft(spec / np.sqrt(freqs), n)


def augment(arr: np.ndarray, variant, rng: random.Random) -> np.ndarray:
    """Gain, plus optional noise (real room tone, else pink) at a target SNR."""
    gain, snr_db = variant
    arr = arr * gain
    if snr_db is not None:
        rms = float(np.sqrt(np.mean(arr ** 2)))
        if ROOM_TONE is not None and len(ROOM_TONE) >= len(arr):
            off = rng.randrange(len(ROOM_TONE) - len(arr))
            noise = ROOM_TONE[off:off + len(arr)]
        else:
            noise = pink_noise(len(arr), rng)
        noise = noise / np.sqrt(np.mean(noise ** 2))      # RMS -> 1
        arr = arr + noise * (rms / 10 ** (snr_db / 20))
    return np.clip(arr, -1.0, 1.0).astype(np.float32)


# ————— data —————
def _batch_sources() -> list[tuple[str, Path]]:
    """Recorded batches: any recordings/ subdir with a manifest.jsonl (the
    studio names dirs by batch id — batch-1-normal, quiet, …). The noise
    cell uses noise_manifest.jsonl, so it can never match. A legacy flat
    manifest (pre-migration) is treated as batch-1-normal so no data is
    silently skipped. SON_BATCHES restricts the set; empty = all."""
    want = {b.strip() for b in SON_BATCHES.split(",") if b.strip()}
    sources = []
    if (RECORDINGS / "manifest.jsonl").exists() and (
            not want or "batch-1-normal" in want):
        sources.append(("batch-1-normal", RECORDINGS))
    for d in sorted(p for p in RECORDINGS.iterdir()
                    if p.is_dir() and (p / "manifest.jsonl").exists()):
        if not want or d.name in want:
            sources.append((d.name, d))
    if want:
        found = {name for name, _ in sources}
        missing = sorted(want - found)
        if missing:
            raise SystemExit(
                f"SON_BATCHES names unknown batches: {', '.join(missing)}")
    return sources


def _rows_for(batch: str, d: Path) -> list[dict]:
    rows = []
    for line in (d / "manifest.jsonl").read_text().splitlines():
        r = json.loads(line)
        if not r["text"].strip() or not 0.5 <= r["duration"] <= 30:
            continue
        r["batch"] = batch
        # The manifest records absolute paths from the machine that recorded
        # them (the Mac). When training elsewhere (GCP VM), the clips sit
        # next to the manifest instead — resolve by basename within the
        # batch dir. Clip names are unique per batch (clip_XXXX.wav), so
        # the fallback is unambiguous.
        if not Path(r["path"]).exists():
            r["path"] = str(d / Path(r["path"]).name)
        rows.append(r)
    return rows


def load_rows():
    sources = _batch_sources()
    rows = []
    for idx, (batch, d) in enumerate(sources):
        batch_rows = _rows_for(batch, d)
        for r in batch_rows:
            r["_batch_idx"] = idx  # stable per-batch key for augmentation rng
            rows.append(r)
        logger.info(f"batch {batch}: {len(batch_rows)} clips")
    rows.sort(key=lambda r: (r["batch"], r["id"]))
    rng = random.Random(SEED)
    rng.shuffle(rows)
    n_dev = max(1, round(len(rows) * DEV_FRAC))
    return rows[n_dev:], rows[:n_dev]


def prep(processor):
    def fn(row, variant=None):
        arr, sr = sf.read(row["path"], dtype="float32")
        if variant is not None:
            # Seeded per (batch, id): clip ids repeat across batches, so a
            # bare-id seed would give different batches identical noise.
            seed = SEED * 1000 + row.get("_batch_idx", 0) * 100000 + row["id"]
            arr = augment(arr, variant, random.Random(seed))
        # WhisperModel.forward hard-requires exactly 3000 mel frames
        # (modeling_whisper.py:613, != check), so keep the extractor's default
        # max_length padding — variable-length features are impossible. Memory
        # control therefore lives in the batch size (BATCH=4, fp32).
        feats = processor.feature_extractor(arr, sampling_rate=sr).input_features[0]
        labels = processor.tokenizer(row["text"]).input_ids
        return {"input_features": feats, "labels": labels}
    return fn


def prep_batch(processor, rows, augment_rows=False):
    """Pre-extract features + labels; train rows get soft-speech variants."""
    if augment_rows:
        rows = [(r, v) for r in rows for v in AUG_VARIANTS]
        return [prep(processor)(r, v) for r, v in rows]
    return [prep(processor)(r) for r in rows]


# ————— collator (DataCollatorSpeechSeq2SeqWithPadding was removed in
# transformers 5.x, so this is the canonical padding logic inline) —————
@dataclass
class SpeechCollator:
    def __call__(self, batch):
        feat_lens = [len(x["input_features"][0]) for x in batch]
        fmax = max(feat_lens)
        n = len(batch)
        feats = np.zeros((n, 80, fmax), dtype=np.float32)
        for i, x in enumerate(batch):
            feats[i, :, : len(x["input_features"][0])] = x["input_features"]
        lbl_lens = [len(x["labels"]) for x in batch]
        lmax = max(lbl_lens)
        labels = np.full((n, lmax), -100, dtype=np.int64)
        for i, x in enumerate(batch):
            labels[i, : len(x["labels"])] = x["labels"]
        return {
            "input_features": torch.from_numpy(feats),
            "labels": torch.from_numpy(labels),
        }


class LogCallback(TrainerCallback):
    """Quiet-ish training log: one line per epoch."""
    def __init__(self):
        self.last_epoch = -1

    def on_log(self, args, state, control, logs=None, **kwargs):
        logs = logs or {}
        epoch = int(state.epoch) if state.epoch is not None else -1
        if epoch != self.last_epoch:
            self.last_epoch = epoch
            # The first log event of an epoch carries eval metrics (no loss
            # key) — don't print a fake NaN; report the eval result instead.
            if "loss" in logs:
                logger.info(f"epoch {epoch + 1} — loss {logs['loss']:.4f}")
            elif "eval_wer" in logs:
                logger.info(
                    f"epoch {epoch} — eval wer {logs['eval_wer']:.4f} "
                    f"(loss {logs.get('eval_loss', 0):.4f})"
                )

    def on_train_end(self, args, state, control, **kwargs):
        logger.info(f"training finished after {state.global_step} steps")


def main() -> None:
    processor = WhisperProcessor.from_pretrained(MODEL_ID)
    tokenizer = processor.tokenizer
    model = WhisperForConditionalGeneration.from_pretrained(MODEL_ID)

    train_rows, dev_rows = load_rows()
    logger.info(f"train: {len(train_rows)} clips ({sum(r['duration'] for r in train_rows) / 60:.1f} min)")
    logger.info(f"dev:   {len(dev_rows)} clips ({sum(r['duration'] for r in dev_rows) / 60:.1f} min)")
    train = prep_batch(processor, train_rows, augment_rows=True)
    dev = prep_batch(processor, dev_rows)
    logger.info(f"augmented train: {len(train)} samples x {len(AUG_VARIANTS)} variants")
    logger.info(f"samples written to {OUT_DIR}")

    def compute_metrics(pred):
        pred_ids = pred.predictions
        label_ids = pred.label_ids
        label_ids[label_ids == -100] = tokenizer.pad_token_id
        pred_str = tokenizer.batch_decode(pred_ids, skip_special_tokens=True)
        label_str = tokenizer.batch_decode(label_ids, skip_special_tokens=True)
        try:
            wer = jiwer.wer(label_str, pred_str)
        except Exception as e:
            logger.warning(f"WER failed: {e}")
            wer = float("nan")
        return {"wer": wer}

    args = Seq2SeqTrainingArguments(
        output_dir=str(OUT_DIR),
        per_device_train_batch_size=BATCH,
        gradient_accumulation_steps=4,
        learning_rate=1e-5,
        warmup_steps=30,            # ~10% of ~315 steps (5.x renamed warmup_ratio)
        num_train_epochs=MAX_EPOCHS,
        predict_with_generate=True,
        generation_max_length=64,
        logging_steps=10,
        save_strategy="epoch",
        eval_strategy="epoch",      # 5.x renamed evaluation_strategy
        metric_for_best_model="wer",
        greater_is_better=False,
        load_best_model_at_end=True,
        fp16=True,                  # MPS: fp32 activations (~10 GiB @ batch 4)
                                    # thrash a 16 GiB machine; fp16 + GradScaler
                                    # is the standard MPS whisper recipe
        bf16=False,
        seed=SEED,
        dataloader_num_workers=0,
    )

    trainer = Seq2SeqTrainer(
        model=model,
        args=args,
        train_dataset=train,
        eval_dataset=dev,
        data_collator=SpeechCollator(),
        compute_metrics=compute_metrics,
        callbacks=[LogCallback()],
    )

    # SON_RESUME=<checkpoint dir> resumes a preempted run (HF restores
    # model/optimizer/scheduler/rng and replays up to the saved step).
    trainer.train(resume_from_checkpoint=os.environ.get("SON_RESUME") or None)
    logger.info(f"best WER: {trainer.state.best_metric:.3f}")

    trainer.save_model(str(OUT_DIR))
    processor.save_pretrained(str(OUT_DIR))
    logger.info(f"saved -> {OUT_DIR}")


if __name__ == "__main__":
    main()

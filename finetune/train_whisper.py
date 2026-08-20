#!/usr/bin/env python3
"""Fine-tune openai/whisper-small.en on the user's recorded voice.

Data: the recorder's manifest.jsonl (~/.cache/son/finetune/recordings/),
rows {id, text, duration, path}. Rows with an empty transcript (ad-lib free
talk) are unsupervised and skipped. Clips are already 16 kHz mono 16-bit WAV.

Runs on CUDA when available (GCP T4), else MPS (Apple Silicon), else CPU.
5 epochs over ~500 short clips is minutes on a T4, tens of minutes on MPS.

Output: finetune/out/whisper-small-son/ (HF format, ready for
whisper.cpp's models/convert-h5-to-ggml.py).

Run:  uv run python finetune/train_whisper.py
"""

import json
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

RECORDINGS = Path.home() / ".cache" / "son" / "finetune" / "recordings"
MANIFEST = RECORDINGS / "manifest.jsonl"
OUT_DIR = Path(__file__).resolve().parent / "out" / "whisper-small-son"
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


# ————— data —————
def load_rows():
    rows = [json.loads(l) for l in MANIFEST.read_text().splitlines()]
    rows = [r for r in rows if r["text"].strip() and 0.5 <= r["duration"] <= 30]
    for r in rows:
        # The manifest records absolute paths from the machine that recorded
        # them (the Mac). When training elsewhere (GCP VM), the clips sit
        # next to the manifest instead — resolve by basename. Clip names are
        # unique (clip_XXXX.wav), so the fallback is unambiguous.
        if not Path(r["path"]).exists():
            r["path"] = str(RECORDINGS / Path(r["path"]).name)
    rows.sort(key=lambda r: r["id"])
    rng = random.Random(SEED)
    rng.shuffle(rows)
    n_dev = max(1, round(len(rows) * DEV_FRAC))
    return rows[n_dev:], rows[:n_dev]


def prep(processor):
    def fn(row):
        arr, sr = sf.read(row["path"], dtype="float32")
        # WhisperModel.forward hard-requires exactly 3000 mel frames
        # (modeling_whisper.py:613, != check), so keep the extractor's default
        # max_length padding — variable-length features are impossible. Memory
        # control therefore lives in the batch size (BATCH=4, fp32).
        feats = processor.feature_extractor(arr, sampling_rate=sr).input_features[0]
        labels = processor.tokenizer(row["text"]).input_ids
        return {"input_features": feats, "labels": labels}
    return fn


def prep_batch(processor, rows):
    """Pre-extract features + labels for a list of rows (training/dev)."""
    out = [prep(processor)(r) for r in rows]
    return out


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
    train = prep_batch(processor, train_rows)
    dev = prep_batch(processor, dev_rows)

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

    trainer.train()
    logger.info(f"best WER: {trainer.state.best_metric:.3f}")

    trainer.save_model(str(OUT_DIR))
    processor.save_pretrained(str(OUT_DIR))
    logger.info(f"saved -> {OUT_DIR}")


if __name__ == "__main__":
    main()

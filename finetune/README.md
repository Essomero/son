# Voice fine-tune

How Son's local STT model was made, end to end: record your own voice →
fine-tune `whisper-small.en` on it → convert to GGML → serve through
whisper.cpp → pick it in Son. The result is **whisper-small-son**, served
entirely on this machine, no API keys.

- Dataset: 517 clips / 19.8 min of the author's voice (16 kHz mono),
  95/5 train/dev split, deterministic shuffle seed 42
- Best dev WER: **14.4%** (26 held-out clips) after 5 epochs on a GCP T4
- Weights: `finetune/out/whisper-small-son/` (HF format) and
  `~/.cache/son/whisper.cpp/models/ggml-whisper-small-son.bin` (GGML f16,
  465 MB). Neither is in git.

```
record  ──────────►  train  ──────────►  convert  ──────────►  serve
recorder/server.py   train_whisper.py   convert-h5-to-ggml.py  whisper-server
reading_list.jsonl   (local or GCP T4)  + gen_mel.py           + whisper_local.py shim
```

## 1. Record

The recorder page captures clips of you reading a 517-prompt reading list.

```bash
uv run python finetune/recorder/server.py     # then open the printed URL
```

- Clips land in `~/.cache/son/finetune/recordings/` as 16 kHz mono PCM_16
  WAV (`clip_XXXX.wav`) with a `manifest.jsonl` alongside:
  `{"id", "text", "duration", "path"}`. Re-recording a prompt overwrites
  its clip in place.
- The reading list is `finetune/prompts/reading_list.jsonl`; regenerate it
  with `finetune/prompts/generate_prompts.py`.
- ⚠️ `recordings/` + `manifest.jsonl` are user data. Never delete the
  manifest; if it's lost, rebuild it from the WAVs + the reading list
  (`clip_XXXX.wav` ↔ `reading_list.jsonl` id `XXXX`). Audio never enters
  git (`.gitignore`).

## 2. Train

`finetune/train_whisper.py` fine-tunes `openai/whisper-small.en` (244M
params). Hyperparameters live at the top of the file: batch 4 × grad-accum
4 (effective 16), LR 1e-5, warmup 30 steps, fp16, 5 epochs = 155 steps.
Whisper hard-requires exactly 3000 mel frames per sample, so variable-
length features are impossible — memory control lives in the batch size.
Output is the best checkpoint (by dev WER) saved in HF format.

### Locally (MPS/CPU)

```bash
uv run python finetune/train_whisper.py
```

Works on a 16 GB M1 Pro, but fp16 whisper under memory pressure crawls —
that's why the GCP path exists.

### On GCP (preemptible T4, ~6.5 min, costs cents)

```bash
bash finetune/gcp/train_on_gcp.sh
```

The script is fully SSH-free (the DL image ships sshd broken):

1. Tars the recordings, creates a temp GCS bucket, uploads bundle + script
   (~27 MB of voice data leaves the machine for the run, then the bucket
   is deleted).
2. Creates a preemptible T4 (`n1-standard-4`, 100 GB boot disk, DL image
   `pytorch-2-9-cu129-ubuntu-2204-nvidia-580`) in the first zone with
   capacity (`ZONES=` env var overrides the default list).
3. `startup-script.sh` runs autonomously on the VM: finds a Python with
   torch, installs `transformers accelerate soundfile jiwer loguru`, aligns
   torchaudio, trains, and **rsyncs checkpoints to GCS every 60 s** — a
   preemption loses at most a minute. A `DONE` marker carries the exit code.
4. The launcher polls for `DONE`, pulls the model down (excluding
   intermediate checkpoints), then deletes VM + bucket.

One-time setup, and the gotchas that cost real time:

- **GPU quota is 0 by default.** `GPUS-ALL-REGIONS-per-project` starts at
  0 and surfaces as a confusing "no capacity in all zones". Request it via
  the Cloud Quotas API (`quotaPreferences`) — the POST requires a
  `contactEmail` field.
- **Don't try to SSH.** The DL image's sshd never comes up (port 22
  dropped, IAP fails). Everything above flows through GCS + the serial
  console; `say()` lines in the startup script are your log.
- T4 is Turing: fp16 + GradScaler, no bf16. `torchaudio` on the image is
  compiled against a different torch — the startup script reinstalls the
  matching wheel (training never uses torchaudio, but `import transformers`
  crashes on the mismatch).

## 3. Convert to GGML

whisper.cpp serves GGML, not safetensors:

```bash
git clone https://github.com/ggml-org/whisper.cpp ~/.cache/son/whisper.cpp
cd ~/.cache/son/whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j

# Regenerate the mel filterbank — v1.9.2 doesn't vendor it (no whisper/
# submodule) and the converter hard-requires it. Must match OpenAI's
# feature extractor bit-for-bit (htk mel scale + slaney norm), else the
# model transcribes garbage.
uv run python finetune/convert/gen_mel.py ~/.cache/son/whisper.cpp

# The trainer's save_model output lacks vocab.json / added_tokens.json —
# copy them from the HF hub cache snapshot of openai/whisper-small.en.
python3 models/convert-h5-to-ggml.py \
    ~/Dev/Personal/son/finetune/out/whisper-small-son \
    ~/.cache/son/whisper.cpp/whisper \
    models
mv models/ggml-model.bin models/ggml-whisper-small-son.bin   # 465 MB, f16
```

`Skipping proj_out.weight` during conversion is benign — it's the tied
embedding's duplicate output.

## 4. Serve + wire into Son

Two local processes, then Son finds it in the STT picker:

```bash
# 1. whisper.cpp server (model backend, :8081)
cd ~/.cache/son/whisper.cpp && ./build/bin/whisper-server \
    -m models/ggml-whisper-small-son.bin --host 127.0.0.1 --port 8081 --threads 8

# 2. OpenAI-compat shim (:8083, from the repo root) — pipecat speaks
#    OpenAI multipart, whisper.cpp only speaks /inference; the shim
#    bridges and strips whisper.cpp's trailing "\n" from each transcript.
uv run python whisper_local.py
```

In Son, choose **whisper-small-son (voice fine-tune)** in the STT model
picker (it's listed when the :8081 probe succeeds), or
`/start whisper-local whisper-small-son`. It's keyless — the "local" API
key is a dummy the OpenAI SDK requires; whisper-server ignores
Authorization entirely.

Smoke-test without Son:

```bash
curl -F "file=@~/.cache/son/finetune/recordings/clip_0000.wav" \
     -F "model=whisper-small-son" \
     http://127.0.0.1:8083/v1/audio/transcriptions
# {"text": "How are you doing today", ...}
```

## 5. Beyond the author's voice

`finetune/prepare_data.py` builds accented-English sets from public
corpora for a generalization round. License matters if the result is
published: AfriSpeech-200 is CC-BY-NC-SA-4.0 (personal use only) — a
publishable model must train on permissive sources like Common Voice
`en_KE` / `en_UG` (CC0).

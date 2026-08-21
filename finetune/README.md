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
- **Room-tone cell**: the page also has a "room tone" booth below the take
  sheet — record ~3 minutes of silence with the mic as-is (no AGC / noise
  suppression, so the real room floor comes through). Saves to
  `recordings/noise/noise_0000.wav` + its own `noise_manifest.jsonl`,
  deliberately separate from the speech manifest (used for gen3 quiet-speech
  augmentation).
- The reading list is `finetune/prompts/reading_list.jsonl`; regenerate it
  with `finetune/prompts/generate_prompts.py`.
- ⚠️ `recordings/` + `manifest.jsonl` (and the `noise/` subdir) are user
  data. Never delete the manifests; if one is lost, rebuild it from the WAVs
  + the reading list (`clip_XXXX.wav` ↔ `reading_list.jsonl` id `XXXX`).
  Audio never enters git (`.gitignore`).
- `SON_RECORDINGS_DIR` overrides the recordings root — used for isolated
  test runs and pointing the recorder at a shared bundle dir.

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

### GCP one-time setup

The pipeline assumes: gcloud CLI installed + authed, a project with
billing enabled, and GPU quota. New projects fail at step 3 until the
quota exists.

```bash
# 1. Auth + project (billing must be enabled on the project)
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# 2. Enable the APIs the pipeline touches
gcloud services enable compute.googleapis.com cloudquotas.googleapis.com
```

3. **Request GPU quota.** New projects start with
   `GPUS-ALL-REGIONS-per-project = 0` — every instance create then dies
   with the opaque "no capacity in all zones". A request for 1 GPU is
   auto-approved (seconds to minutes; no human review). The Cloud Quotas
   API rejects the POST without a `contactEmail` field:

```bash
curl -X POST \
  "https://cloudquotas.googleapis.com/v1/projects/YOUR_PROJECT_ID/locations/global/quotaPreferences?quota_preference_id=son-gpu-t4" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d '{
    "service": "compute.googleapis.com",
    "quotaId": "GPUS-ALL-REGIONS-per-project",
    "preferredValue": 1,
    "dimensions": {"region": "global"},
    "contactEmail": "you@example.com"
  }'
```

Verify the grant landed:

```bash
curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://cloudquotas.googleapis.com/v1/projects/YOUR_PROJECT_ID/locations/global/quotaPreferences/son-gpu-t4" \
  | grep -E '"state"|"preferredValue"'
```

4. **Storage — nothing to provision.** `train_on_gcp.sh` creates a
   temporary regional bucket (`gsutil mb -l us-central1`, using the same
   `gcloud auth login` credentials) and deletes it at the end; the VM gets
   `--scopes storage-full` from the script. The ~27 MB of voice data lives
   in the bucket only for the run.

5. **Cost — cents.** The VM is preemptible (`n1-standard-4` + T4 ≈
   $0.20/hr); ~15 min of boot + training is a few cents, and the ~465 MB
   model download is negligible GCS egress.

### On GCP (preemptible T4, ~6.5 min)

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

Gotchas that cost real time during the first run:

- **"No capacity in all zones" usually means quota, not capacity.** See
  the quota request in [GCP one-time setup](#gcp-one-time-setup) above.
- **Don't try to SSH.** The DL image's sshd never comes up (port 22
  dropped, IAP fails). Everything above flows through GCS + the serial
  console; `say()` lines in the startup script are your log.
- T4 is Turing: fp16 + GradScaler, no bf16. `torchaudio` on the image is
  compiled against a different torch — the startup script reinstalls the
  matching wheel (training never uses torchaudio, but `import transformers`
  crashes on the mismatch).

### Soft-speech retrain (whisper-small-son-soft)

A second generation aimed at the failure mode that actually mattered:
soft/noisy mic audio. Same pipeline as above plus a 6-way augmentation in
`train_whisper.py` (volume attenuation ×6, pink noise, both) — ~15% of the
dev set was soft+noisy. Result: HF dev WER 15.3% vs 14.4% for v1 (worse on
clean clips, as designed), but through the whisper.cpp serving path it
scores 8.5% vs 8.9% on the 78-clip dev set and fixes several live soft
mishears. This is the model Son's launcher serves now.

- Weights: `finetune/out/whisper-small-son-soft/` (HF) and
  `~/.cache/son/whisper.cpp/models/ggml-whisper-small-son-soft.bin` (GGML
  f16, 465 MB). v1's files are kept for rollback.

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
# 1. whisper.cpp server (model backend, :8081). The decode flags are the
#    quiet-speech fail-safes from docs/RESEARCH-QUIET-SPEECH.md §3B (keep
#    in sync with scripts/Son.applescript).
cd ~/.cache/son/whisper.cpp && ./build/bin/whisper-server \
    -m models/ggml-whisper-small-son-soft.bin --host 127.0.0.1 --port 8081 --threads 8 -bs 5 \
    --no-speech-thold 0.75 --logprob-thold -0.5 -nt

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

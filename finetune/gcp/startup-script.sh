#!/bin/bash
# Fine-tune whisper-small on user voice — autonomous startup script for a
# preemptible GCE GPU VM. No SSH needed (the DL image ships sshd broken;
# the pipeline below uses only GCS + the serial console).
#
#   - Every line goes to the serial console (say()) for live watching.
#   - Checkpoints rsync to GCS every 60 s, so preemption loses <= 1 min.
#   - Writes gs://__BUCKET__/DONE with the training exit code when finished.
#
# train_on_gcp.sh substitutes __BUCKET__ and passes this via
# --metadata-from-file startup-script=...
set -u
BUCKET="__BUCKET__"
say() { echo "$(date -u +%H:%M:%S) $*" > /dev/console; }

say "=== son-train boot: $(hostname) ==="

# The image ships sshd disabled; try to restore it as a debugging
# convenience only — nothing below needs SSH.
{ service ssh start || sshd || true; } >/dev/null 2>&1
iptables -F 2>/dev/null; iptables -P INPUT ACCEPT 2>/dev/null

# Pick a python that actually has torch. The DL image keeps it in
# /opt/conda, but startup scripts run with a bare PATH and conda activate
# failed silently (training died with exit 127 = python not found).
PY=""
for c in /opt/conda/bin/python /opt/python/bin/python /usr/local/bin/python3 /usr/bin/python3; do
    [ -x "$c" ] && "$c" -c "import torch" >/dev/null 2>&1 && { PY="$c"; break; }
done
[ -z "$PY" ] && { say "NO_PYTHON_WITH_TORCH"; exit 1; }
say "using $PY"
"$PY" -c "import torch; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())" > /dev/console 2>&1

say "pip install..."
"$PY" -m pip install --quiet transformers accelerate soundfile jiwer loguru && say "deps ok" || say "PIP_FAIL=$?"

# The image ships a torchaudio binary that doesn't match its torch
# (_torchaudio.abi3.so: undefined symbol: torch_library_impl), which
# crashes `import transformers`. Reinstall the matching build, or drop
# torchaudio entirely — the training pipeline never uses it and
# transformers guards all of its uses.
say "aligning torchaudio..."
TA="$("$PY" -c "import torch; print(torch.__version__.split('+')[0])" 2>/dev/null)"
if [ -n "$TA" ] && "$PY" -m pip install --quiet "torchaudio==$TA" --index-url https://download.pytorch.org/whl/cu129; then
    say "torchaudio reinstalled to match torch $TA"
else
    say "matching wheel unavailable - removing broken torchaudio"
    "$PY" -m pip uninstall -y --quiet torchaudio
fi
"$PY" -c "import transformers, accelerate, soundfile, jiwer, loguru; print('imports ok')" > /dev/console 2>&1 && say "IMPORT_OK" || { say "IMPORT_FAIL"; exit 1; }

say "fetching bundle..."
mkdir -p /root/.cache/son/finetune /root/out
{ echo "gsutil: $(gsutil version 2>&1 | head -1)"; } > /dev/console 2>&1
curl -s -m 10 -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
    2>&1 | head -c 90 > /dev/console; echo > /dev/console
for try in 1 2 3; do
    gsutil -q cp "gs://$BUCKET/son-recordings.tar.gz" /tmp/recordings.tar.gz 2>&1 \
        | while IFS= read -r l; do say "GSERR: $l"; done
    rc=${PIPESTATUS[0]}
    say "BUNDLE_TRY$try=$rc"
    [ "$rc" -eq 0 ] && break
    sleep 10
done
[ "$rc" -ne 0 ] && exit 1
gsutil -q cp "gs://$BUCKET/train_whisper.py" /root/train_whisper.py 2>&1 \
    | while IFS= read -r l; do say "GSERR: $l"; done
rc=${PIPESTATUS[0]}; say "SCRIPT_RC=$rc"
[ "$rc" -ne 0 ] && exit 1
tar xzf /tmp/recordings.tar.gz -C /root/.cache/son/finetune
say "clips: $(ls /root/.cache/son/finetune/recordings | wc -l)"

say "training..."
cd /root
# Augmented retrain writes to its own dir so the live model (whisper-small-son)
# is never clobbered — the rsync below ships whatever lands in /root/out.
# __OUT_NAME__ is substituted by train_on_gcp.sh (SON_OUT_NAME env, default
# whisper-small-son-soft), so a gen3 run can land in its own dir.
SON_OUT_DIR=/root/out/__OUT_NAME__ SON_BATCHES="__BATCHES__" "$PY" train_whisper.py > /tmp/train.log 2>&1 &
TPID=$!
( tail -f /tmp/train.log | while IFS= read -r l; do say "TRAIN: $l"; done ) &
TLOG=$!
while kill -0 "$TPID" 2>/dev/null; do
    gsutil -q rsync -r /root/out "gs://$BUCKET/out" 2>/dev/null || true
    gsutil -q cp /tmp/train.log "gs://$BUCKET/train.log" 2>/dev/null || true
    sleep 60
done
wait "$TPID"; EXIT=$?
kill "$TLOG" 2>/dev/null
gsutil -q rsync -r /root/out "gs://$BUCKET/out"
say "TRAIN_EXIT=$EXIT"
echo "exit=$EXIT" | gsutil -q cp - "gs://$BUCKET/DONE"
say "=== son-train done ==="

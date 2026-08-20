#!/usr/bin/env bash
# One-shot fine-tune on a preemptible GCP T4, then pull the result back.
#
# Why: whisper-small fp16 training on a 16 GB M1 Pro under memory pressure
# crawled at minutes-per-step. A T4 (16 GB VRAM) + CUDA runs this exact job
# in ~15-25 min. Preemptible T4 costs cents.
#
# Flow: bundle recordings -> temp GCS bucket -> preemptible T4 with an
# autonomous startup script (no SSH anywhere — the DL image ships sshd
# broken) -> VM trains and rsyncs checkpoints to GCS every 60 s -> writes a
# DONE marker -> we download from GCS and delete VM + bucket. A preemption
# mid-run loses at most a minute of training and the VM never survives
# without the checkpoint being safe in GCS first.
#
# Requires: gcloud CLI authed. ~40 MB of voice data leaves the machine for
# the duration of the run and is deleted from GCP afterwards.
#
# Run:  bash finetune/gcp/train_on_gcp.sh
# Output lands in finetune/out/ (the startup script sets SON_OUT_DIR —
# whisper-small-son-soft for the augmented retrain).

set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
ZONES="${ZONES:-us-central1-a us-west1-b us-east1-d}"
BUNDLE=/tmp/son-recordings.tar.gz
STAMP="$(date +%s)"
VM="son-train-$STAMP"
BUCKET="son-train-$STAMP"

cd "$REPO"

if ! gcloud config get-value account >/dev/null 2>&1; then
    echo "ERROR: no active gcloud account (gcloud auth list)" >&2
    exit 1
fi
PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
echo "Project: ${PROJECT:-<default>}  Account: $(gcloud config get-value account)"

# 1. Bundle the recordings (user data leaves the machine only for the run).
tar czf "$BUNDLE" -C "$HOME/.cache/son/finetune" recordings
echo "Bundle: $BUNDLE ($(du -h "$BUNDLE" | cut -f1))"

# 2. Staging bucket + upload (GCS is the only transport, no SSH).
gsutil mb -l us-central1 "gs://$BUCKET"
gsutil cp "$BUNDLE" "gs://$BUCKET/son-recordings.tar.gz"
gsutil cp finetune/train_whisper.py "gs://$BUCKET/train_whisper.py"
echo "Staged -> gs://$BUCKET/"

# 3. Preemptible T4 with the autonomous startup script baked in. Boot disk
#    must be >= 100GB (the DL image is 100GB; smaller disks are rejected).
#    Create errors are NOT suppressed: they are the diagnosis.
sed "s/__BUCKET__/$BUCKET/" finetune/gcp/startup-script.sh > /tmp/startup-script.sh
for ZONE in $ZONES; do
    echo "Trying $ZONE..."
    if gcloud compute instances create "$VM" \
        --zone "$ZONE" \
        --machine-type n1-standard-4 \
        --accelerator type=nvidia-tesla-t4,count=1 \
        --maintenance-policy TERMINATE \
        --image-family pytorch-2-9-cu129-ubuntu-2204-nvidia-580 \
        --image-project deeplearning-platform-release \
        --boot-disk-size 100GB \
        --preemptible \
        --scopes storage-full \
        --metadata-from-file startup-script=/tmp/startup-script.sh; then
        break
    fi
done
gcloud compute instances describe "$VM" --zone "$ZONE" >/dev/null || {
    echo "ERROR: instance create failed in all zones (last: $ZONE)" >&2
    exit 1
}
echo "VM $VM up in $ZONE"

# 4. Poll GCS until the VM writes DONE (checkpoints stream every 60 s).
#    100 min cap: the augmented dataset is 6x the clips, so feature
#    extraction + 5 epochs can take well past the old 60 min.
echo "Waiting for training (checkpoints stream to GCS every 60s)..."
for i in $(seq 1 300); do   # 100 min cap
    if gsutil -q ls "gs://$BUCKET/DONE" >/dev/null 2>&1; then break; fi
    sleep 20
done
if ! gsutil -q ls "gs://$BUCKET/DONE" >/dev/null 2>&1; then
    echo "ERROR: no DONE marker after 100 min (check VM status / serial console)" >&2
    exit 1
fi
echo "Done marker: $(gsutil cat "gs://$BUCKET/DONE")"

# 5. Download the final model (skip per-epoch checkpoints — the final save
#    is the best model, via load_best_model_at_end).
mkdir -p finetune/out
# rsync, not cp — cp has no -x. The pattern is matched against the full
# object name (re.match), so it needs the leading ".*" to skip the
# per-epoch checkpoint dirs (checkpoints are ~2.9 GB each).
gsutil -m rsync -r -x ".*checkpoint-[0-9]*" "gs://$BUCKET/out" finetune/out/

# 6. VM and staging bucket are no longer needed.
gcloud compute instances delete "$VM" --zone "$ZONE" --quiet
gsutil rm -r "gs://$BUCKET"
echo "Done -> finetune/out/whisper-small-son/ (temp bucket deleted)"

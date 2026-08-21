#!/usr/bin/env python3
"""One-time migration: flat recordings/ -> batch-1-normal/.

The pre-batch recorder wrote clips + manifest.jsonl directly into
recordings/. The studio app reads recordings/batch-<id>/ dirs instead.
This moves the legacy data into batch-1-normal/ (pure moves, filenames
preserved — the old layout is fully restorable), copies the reading list
in as the batch's prompts, and writes the batches.json registry.

Reruns are safe: an already-migrated layout is detected and left alone,
and a crash after the move but before the registry is written completes
the tail (prompts copy + batches.json) on the next run.

Run:  uv run python finetune/recorder/migrate.py           # plan only
      uv run python finetune/recorder/migrate.py --apply   # do it
"""

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

DATA_DIR = Path(os.environ.get(
    "SON_RECORDINGS_DIR",
    Path.home() / ".cache" / "son" / "finetune" / "recordings",
))
MANIFEST = DATA_DIR / "manifest.jsonl"          # the legacy flat manifest
TARGET = DATA_DIR / "batch-1-normal"
TARGET_MANIFEST = TARGET / "manifest.jsonl"
BATCHES = DATA_DIR / "batches.json"
PROMPTS = Path(__file__).resolve().parent.parent / "prompts" / "reading_list.jsonl"

BATCH_1 = {
    "id": "batch-1-normal",
    "name": "Batch 1 — normal",
    "kind": "normal",
    "description": "Migrated from the original flat recorder session",
    "max_duration": 30,
    "prompt_source": "reading_list",
    "include_in_training": True,
    "archived": False,
    "created": "",
}


def migrated() -> bool:
    """True when the batch layout is already in place (wholly or in tail)."""
    return BATCHES.exists() and (TARGET_MANIFEST.exists() or TARGET.is_dir())


def plan() -> None:
    if migrated():
        print("already migrated (batches.json present) — nothing to do")
        return
    if not MANIFEST.exists():
        print(f"no legacy manifest at {MANIFEST} — nothing to migrate")
        return
    clips = sorted(DATA_DIR.glob("clip_*.wav"))
    n_records = sum(1 for _ in MANIFEST.open())
    print(f"would move {len(clips)} clips + manifest.jsonl ({n_records} records)")
    print(f"  -> {TARGET}")
    print("noise/ left in place (shared room tone)")
    print(f"prompts.jsonl copied from {PROMPTS.name} (the reading list)")
    print(f"batches.json written with a single entry: {BATCH_1['id']}")
    print("pure moves, filenames preserved — the old layout is restorable")
    print("run with --apply to do it")


def apply() -> None:
    if migrated():
        print("already migrated — nothing to do")
        return
    if TARGET_MANIFEST.exists():
        # Crash tail: clips + manifest already moved, registry never written.
        _finish_tail()
        return
    if not MANIFEST.exists():
        sys.exit(f"no legacy manifest at {MANIFEST} — nothing to migrate")

    TARGET.mkdir(parents=True, exist_ok=True)
    clips = sorted(DATA_DIR.glob("clip_*.wav"))
    created = None  # snapshot mtimes BEFORE the move — the old paths die
    for w in clips:
        mt = w.stat().st_mtime
        created = mt if created is None else min(created, mt)
        shutil.move(str(w), str(TARGET / w.name))

    records = []
    for line in MANIFEST.read_text().splitlines():
        r = json.loads(line)
        r["path"] = str(TARGET / Path(r["path"]).name)
        r["batch"] = "batch-1-normal"
        records.append(r)
    TARGET_MANIFEST.write_text(
        "".join(json.dumps(r) + "\n" for r in records))
    MANIFEST.unlink()

    if records:
        BATCH_1["created"] = records[0].get("created") or _fmt_mtime(created)
    else:
        BATCH_1["created"] = _fmt_mtime(created)
    _finish_tail()
    print(f"migrated: {len(clips)} clips, {len(records)} records -> {TARGET}")


def _finish_tail() -> None:
    """Prompts copy + registry — the idempotent tail shared by the full
    migration and a crash-tail rerun."""
    if not (TARGET / "prompts.jsonl").exists():
        shutil.copyfile(PROMPTS, TARGET / "prompts.jsonl")
    if not BATCHES.exists():
        BATCHES.write_text(json.dumps([BATCH_1], indent=2) + "\n")


def _fmt_mtime(ts: float | None) -> str:
    import datetime
    if not ts:
        return ""
    return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--apply", action="store_true",
        help="perform the migration (default: print the plan)")
    args = ap.parse_args()
    if args.apply:
        apply()
    else:
        plan()


if __name__ == "__main__":
    main()

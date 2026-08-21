#!/usr/bin/env python3
"""Recording studio for the voice fine-tune — React app + batch API.

Serves the studio app (finetune/recorder/dist when built) and the batch
recording API. Data lives in recordings/ under
~/.cache/son/finetune/recordings/ (SON_RECORDINGS_DIR overrides):

    batches.json        registry: one entry per batch
    batch-<id>/         per batch: prompts.jsonl, manifest.jsonl, clip_*.wav
    noise/              room tone (shared across batches — it's the room)

Clips are 16 kHz mono PCM_16 (whisper's native rate), ~1.9 MB/min. One
clip per prompt id; re-recording a prompt overwrites its clip in place
(the retake feature). The room-tone take lands in recordings/noise/ with
its own noise_manifest.jsonl — separate from the speech manifests on
purpose, so the training script never sees them.

A legacy flat layout (manifest.jsonl directly in recordings/) is detected
at startup and warns: run finetune/recorder/migrate.py to move it into
batch-1-normal/. The app itself never auto-migrates user data.

SON_PORT overrides the port (default 8082).

Run:  uv run python finetune/recorder/server.py   (then open the printed URL)
"""

import json
import os
import re
import shutil
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

PROMPTS = Path(__file__).resolve().parent.parent / "prompts" / "reading_list.jsonl"
DATA_DIR = Path(os.environ.get(
    "SON_RECORDINGS_DIR",
    Path.home() / ".cache" / "son" / "finetune" / "recordings",
))
BATCHES_FILE = DATA_DIR / "batches.json"
LEGACY_MANIFEST = DATA_DIR / "manifest.jsonl"
NOISE_DIR = DATA_DIR / "noise"
NOISE_MANIFEST = NOISE_DIR / "noise_manifest.jsonl"
PORT = int(os.environ.get("SON_PORT", "8082"))

app = FastAPI(title="Son fine-tune studio")


@app.middleware("http")
async def no_store(request, call_next):
    """Never cache: the manifests are the source of truth and change constantly."""
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


def _ensure_layout() -> None:
    """Warn when the legacy flat layout is still in place — the app needs
    batch dirs, migrate.py moves it. Never auto-migrates user data."""
    if LEGACY_MANIFEST.exists() and not BATCHES_FILE.exists():
        print("WARNING: legacy flat recordings/ detected — run "
              "finetune/recorder/migrate.py to move it into batch-1-normal/")


# ————— registry —————
def _load_batches() -> dict[str, dict]:
    if not BATCHES_FILE.exists():
        return {}
    return {b["id"]: b for b in json.loads(BATCHES_FILE.read_text())}


def _save_batches(batches: dict[str, dict]) -> None:
    BATCHES_FILE.write_text(
        json.dumps(list(batches.values()), indent=2) + "\n")


def _batch_dir(bid: str) -> Path:
    """Resolve a batch id to its data dir, refusing anything that could
    escape recordings/ (ids are slugs, but never trust user input)."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", bid or ""):
        raise HTTPException(400, f"bad batch id: {bid!r}")
    d = DATA_DIR / bid
    if not d.is_dir():
        raise HTTPException(404, f"no such batch: {bid}")
    return d


def _batch_prompts(bid: str) -> list[dict]:
    p = _batch_dir(bid) / "prompts.jsonl"
    if not p.exists():
        return []
    return [json.loads(l) for l in p.read_text().splitlines()]


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "batch"


def _unique_id(batches: dict[str, dict], base: str) -> str:
    bid, n = base, 2
    while bid in batches:
        bid = f"{base}-{n}"
        n += 1
    return bid


def _split_custom(text: str) -> list[dict]:
    """Pasted text -> prompts. Blank lines delimit paragraphs; each
    paragraph (its lines joined with a space) becomes one prompt, read in
    a single take — so pasted prose stays whole instead of shattering."""
    prompts = []
    for para in re.split(r"\n\s*\n", text.strip()):
        line = " ".join(l.strip() for l in para.splitlines() if l.strip())
        if line:
            prompts.append(
                {"id": len(prompts), "category": "custom", "text": line})
    return prompts


def _stats(batch: dict, prompts: list[dict],
           records: dict[int, dict]) -> dict:
    return {
        "prompts": len(prompts),
        "done": len(records),
        "tape_s": round(sum(r["duration"] for r in records.values()), 1),
    }


# ————— manifests —————
def _load_manifest(path: Path) -> dict[int, dict]:
    records = {}
    if path.exists():
        for line in path.read_text().splitlines():
            r = json.loads(line)
            records[r["id"]] = r
    return records


def _save_manifest(records: dict[int, dict], path: Path) -> None:
    path.write_text(
        "".join(json.dumps(records[i]) + "\n" for i in sorted(records)))


def _wav_error(data: bytes, duration: float) -> str | None:
    """Reject non-WAV and wildly size-inconsistent uploads."""
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return "not a WAV file"
    expect = duration * 32000  # 16 kHz mono 16-bit ≈ 32000 B/s
    if duration > 0 and abs(len(data) - expect) / expect > 0.15:
        return f"size/duration mismatch ({len(data)}B vs {duration:.1f}s)"
    return None


# ————— batches —————
@app.get("/batches")
def list_batches():
    out = []
    for b in _load_batches().values():
        records = _load_manifest(_batch_dir(b["id"]) / "manifest.jsonl")
        out.append({
            **b, "stats": _stats(b, _batch_prompts(b["id"]), records),
        })
    return {"batches": out}


class BatchCreate(BaseModel):
    name: str
    kind: str = "normal"
    description: str = ""
    max_duration: int = 30
    prompt_source: str = "reading_list"
    custom_text: str = ""


@app.post("/batches")
def create_batch(body: BatchCreate):
    _ensure_layout()
    batches = _load_batches()
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "name is required")
    if body.kind not in ("normal", "quiet", "other"):
        raise HTTPException(400, f"bad kind: {body.kind!r}")
    if body.max_duration not in (30, 60, 90):
        raise HTTPException(400, "max_duration must be 30, 60 or 90")
    if body.prompt_source not in ("reading_list", "custom"):
        raise HTTPException(400, f"bad prompt_source: {body.prompt_source!r}")
    if body.prompt_source == "custom" and not body.custom_text.strip():
        raise HTTPException(400, "custom_text is required for custom prompts")
    bid = _unique_id(batches, _slug(name))
    d = DATA_DIR / bid
    d.mkdir(parents=True)
    if body.prompt_source == "reading_list":
        shutil.copyfile(PROMPTS, d / "prompts.jsonl")
    else:
        prompts = _split_custom(body.custom_text)
        (d / "prompts.jsonl").write_text(
            "".join(json.dumps(p) + "\n" for p in prompts))
    batch = {
        "id": bid, "name": name, "kind": body.kind,
        "description": body.description, "max_duration": body.max_duration,
        "prompt_source": body.prompt_source,
        "include_in_training": True, "archived": False,
        "created": time.strftime("%Y-%m-%d %H:%M"),
    }
    batches[bid] = batch
    _save_batches(batches)
    return {"ok": True, "batch": batch}


@app.get("/batch/{bid}")
def get_batch(bid: str):
    batches = _load_batches()
    if bid not in batches:
        raise HTTPException(404, f"no such batch: {bid}")
    records = _load_manifest(_batch_dir(bid) / "manifest.jsonl")
    return {
        "meta": batches[bid],
        "prompts": _batch_prompts(bid),
        "done": {i: r["duration"] for i, r in records.items()},
    }


@app.post("/batch/{bid}/clip")
async def batch_clip(
    bid: str,
    id: int = Form(...),
    text: str = Form(""),
    duration: float = Form(0.0),
    file: UploadFile = File(...),
):
    d = _batch_dir(bid)
    data = await file.read()
    err = _wav_error(data, duration)
    if err:
        return JSONResponse({"ok": False, "error": err}, status_code=400)
    path = d / f"clip_{id:04d}.wav"
    path.write_bytes(data)
    records = _load_manifest(d / "manifest.jsonl")
    records[id] = {
        "id": id, "text": text, "duration": round(duration, 2),
        "path": str(path), "batch": bid,
    }
    _save_manifest(records, d / "manifest.jsonl")
    return {"ok": True, "id": id, "duration": duration}


@app.get("/batch/{bid}/clip/{clip_id}")
def get_batch_clip(bid: str, clip_id: int) -> FileResponse:
    d = _batch_dir(bid)
    records = _load_manifest(d / "manifest.jsonl")
    if clip_id not in records:
        return JSONResponse(
            {"ok": False, "error": "no take for this prompt"}, status_code=404)
    path = Path(records[clip_id]["path"])
    if not path.exists():
        path = d / f"clip_{clip_id:04d}.wav"
    if not path.exists():
        return JSONResponse(
            {"ok": False, "error": "audio file missing"}, status_code=404)
    return FileResponse(path, media_type="audio/wav")


class BatchPatch(BaseModel):
    name: str | None = None
    kind: str | None = None
    description: str | None = None
    max_duration: int | None = None
    include_in_training: bool | None = None
    archived: bool | None = None  # restore = archive it again off


@app.patch("/batch/{bid}")
def patch_batch(bid: str, body: BatchPatch):
    batches = _load_batches()
    if bid not in batches:
        raise HTTPException(404, f"no such batch: {bid}")
    b = batches[bid]
    for k, v in body.model_dump(exclude_none=True).items():
        if v != b.get(k):
            b[k] = v
    _save_batches(batches)
    return {"ok": True, "batch": b}


@app.post("/batch/{bid}/archive")
def archive_batch(bid: str):
    """Archive = out of the active list and out of training. Files stay —
    nothing in this app deletes user data."""
    batches = _load_batches()
    if bid not in batches:
        raise HTTPException(404, f"no such batch: {bid}")
    batches[bid]["archived"] = True
    _save_batches(batches)
    return {"ok": True}


# ————— room-tone (noise) cell —————
# One slot, retake semantics like speech: re-recording overwrites
# noise_0000.wav in place. Stored separately from the speech manifests so
# train_whisper.py (which filters on text) can never pick it up.

def _load_noise() -> dict[int, dict]:
    records = {}
    if NOISE_MANIFEST.exists():
        for line in NOISE_MANIFEST.read_text().splitlines():
            r = json.loads(line)
            records[r["id"]] = r
    return records


@app.get("/noise")
def list_noise():
    return {"takes": [
        {"id": i, "duration": r["duration"]}
        for i, r in sorted(_load_noise().items())
    ]}


@app.post("/noise")
async def noise_clip(duration: float = Form(0.0), file: UploadFile = File(...)):
    data = await file.read()
    err = _wav_error(data, duration)
    if err:
        return JSONResponse({"ok": False, "error": err}, status_code=400)
    NOISE_DIR.mkdir(parents=True, exist_ok=True)
    path = NOISE_DIR / "noise_0000.wav"
    path.write_bytes(data)
    _save_manifest({0: {
        "id": 0, "kind": "noise", "duration": round(duration, 2),
        "path": str(path),
    }}, path=NOISE_MANIFEST)
    return {"ok": True, "id": 0, "duration": duration}


@app.get("/noise/{noise_id}")
def get_noise(noise_id: int) -> FileResponse:
    """Serve the stored room-tone take for playback."""
    records = _load_noise()
    if noise_id not in records:
        return JSONResponse({"ok": False, "error": "no noise take"}, status_code=404)
    path = Path(records[noise_id]["path"])
    if not path.exists():
        return JSONResponse(
            {"ok": False, "error": "audio file missing"}, status_code=404)
    return FileResponse(path, media_type="audio/wav")


# ————— studio app (built React bundle) —————
# Mounted last so the API routes above always win; html=True serves
# index.html for "/" (the app has no client-side routes — views are
# React state). Skipped when the bundle isn't built (vite dev proxy).

DIST = Path(__file__).resolve().parent / "dist"

if DIST.is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=DIST, html=True), name="studio")


if __name__ == "__main__":
    _ensure_layout()
    print(f"studio -> http://127.0.0.1:{PORT}  (data: {DATA_DIR})")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")

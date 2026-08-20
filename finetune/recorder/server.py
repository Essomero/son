#!/usr/bin/env python3
"""Local recording studio for the voice fine-tune.

Serves the recorder page + reading list, and receives WAV clips — one per
prompt id; re-recording a prompt overwrites its clip in place (the retake
feature). Clips are 16 kHz mono PCM_16 (whisper's native rate), ~1.9 MB/min,
written under ~/.cache/son/finetune/recordings/ with a manifest.jsonl in the
same format the training script reads.

Run:  uv run python finetune/recorder/server.py   (then open the printed URL)
"""

import json
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import FileResponse, JSONResponse

PROMPTS = Path(__file__).resolve().parent.parent / "prompts" / "reading_list.jsonl"
DATA_DIR = Path.home() / ".cache" / "son" / "finetune" / "recordings"
MANIFEST = DATA_DIR / "manifest.jsonl"
PORT = 8082

app = FastAPI(title="Son voice recorder")


@app.middleware("http")
async def no_store(request, call_next):
    """Never cache: the manifest is the source of truth and changes constantly."""
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


def _load_manifest() -> dict[int, dict]:
    records = {}
    if MANIFEST.exists():
        for line in MANIFEST.read_text().splitlines():
            r = json.loads(line)
            records[r["id"]] = r
    return records


def _save_manifest(records: dict[int, dict]) -> None:
    MANIFEST.write_text(
        "".join(json.dumps(records[i]) + "\n" for i in sorted(records))
    )


@app.get("/")
def index() -> FileResponse:
    return FileResponse(Path(__file__).resolve().parent / "recorder.html")


@app.get("/list")
def list_prompts():
    prompts = [json.loads(l) for l in PROMPTS.read_text().splitlines()]
    records = _load_manifest()
    # done: prompt id -> recorded seconds (the page shows a live tape counter)
    return {"prompts": prompts, "done": {i: r["duration"] for i, r in records.items()}}


@app.post("/clip")
async def clip(
    id: int = Form(...),
    text: str = Form(""),
    duration: float = Form(0.0),
    file: UploadFile = File(...),
):
    data = await file.read()
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return JSONResponse({"ok": False, "error": "not a WAV file"}, status_code=400)
    # Sanity: 16 kHz mono 16-bit is ~32000 bytes/sec; allow +10% slack.
    expect = duration * 32000
    if duration > 0 and abs(len(data) - expect) / expect > 0.15:
        return JSONResponse(
            {"ok": False, "error": f"size/duration mismatch ({len(data)}B vs {duration:.1f}s)"},
            status_code=400,
        )
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / f"clip_{id:04d}.wav"
    path.write_bytes(data)
    records = _load_manifest()
    records[id] = {
        "id": id,
        "text": text,
        "duration": round(duration, 2),
        "path": str(path),
    }
    _save_manifest(records)
    return {"ok": True, "id": id, "duration": duration}


@app.get("/clip/{clip_id}")
def get_clip(clip_id: int) -> FileResponse:
    """Serve a stored take so the page can replay any recorded prompt."""
    records = _load_manifest()
    if clip_id not in records:
        return JSONResponse({"ok": False, "error": "no take for this prompt"}, status_code=404)
    path = Path(records[clip_id]["path"])
    if not path.exists():
        return JSONResponse({"ok": False, "error": "audio file missing"}, status_code=404)
    return FileResponse(path, media_type="audio/wav")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")

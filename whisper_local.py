#!/usr/bin/env python3
"""Local OpenAI-compatible transcription endpoint backed by whisper.cpp.

Son's pipecat stack talks to STT through the OpenAI SDK (multipart POST to
{base_url}/audio/transcriptions), but whisper.cpp's server only exposes
/inference. This shim bridges the two: it accepts the OpenAI-shaped request
and forwards the audio to the whisper.cpp server, returning the same JSON
whisper.cpp already produces ({"text": ...}).

Two local processes, both on 127.0.0.1:
  whisper.cpp:  whisper-server -m <model.ggml> --port 8081 --threads 8
  this shim:   uv run python whisper_local.py        (port 8083)

Run:  uv run python whisper_local.py
"""

import httpx
import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

WHISPER_CPP_URL = "http://127.0.0.1:8081/inference"
PORT = 8083

app = FastAPI(title="Son whisper-local shim")


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(""),          # accepted for OpenAI-compat; model is
    language: str = Form(None),     # fixed by the whisper.cpp server's loaded
    response_format: str = Form("json"),  # model; language auto-detects
):
    data = await file.read()
    files = {"file": (file.filename or "audio.wav", data, file.content_type or "audio/wav")}
    form = {"response_format": "json"}
    if language:
        form["language"] = language
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            r = await client.post(WHISPER_CPP_URL, files=files, data=form)
    except httpx.ConnectError:
        return JSONResponse(
            {"error": "whisper.cpp server not running on 127.0.0.1:8081"},
            status_code=503,
        )
    if r.status_code != 200:
        return JSONResponse({"error": f"whisper.cpp returned {r.status_code}"}, status_code=502)
    out = r.json()                  # already {"task", "language", "duration", "text", ...}
    # whisper.cpp ends every transcription with "\n" (legacy cli behavior).
    # Son's live bubble prints the text verbatim, so strip it here.
    if isinstance(out.get("text"), str):
        out["text"] = out["text"].strip()
    return out


if __name__ == "__main__":
    # uvicorn's warning log level prints nothing on boot; say something so
    # the Terminal window doesn't look hung.
    print(f"whisper shim on 127.0.0.1:{PORT} -> {WHISPER_CPP_URL}")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")

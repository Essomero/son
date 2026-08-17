# Son ·

A personal real-time voice agent. Pick a role (instruction file), talk to it in your browser, hear it answer — with live speech, barge-in, and near-conversational latency.

**Stack (Tier 3 — hybrid, ~$0/month):**

| Piece | Tool | Where it runs |
|---|---|---|
| Speech-to-text | Groq · whisper-large-v3-turbo | Cloud (free tier) |
| Brain | Groq · llama-3.3-70b-versatile | Cloud (free tier) |
| Text-to-speech | Kokoro-82M | **Local** (ONNX on CPU) |
| Voice pipeline | Pipecat 1.7 (BSD-2) | Local |
| Turn detection | Silero VAD | Local |

Only your speech audio and text go to Groq; the voice you hear is synthesized on your machine.

## Prerequisites

- macOS / Linux, Python 3.11+ ([uv](https://docs.astral.sh/uv/))
- Node.js 18+ (for the client bundle, build once)
- A free Groq API key: https://console.groq.com

## Setup

```bash
# 1. Bot dependencies
uv sync

# 2. API key
cp .env.example .env      # then edit .env and set GROQ_API_KEY

# 3. Client (one-time build)
cd client && npm install && npm run build && cd ..

# 4. Roles (only needed when you add instruction files)
uv run scripts/gen_roles.py
```

## Run

```bash
# Terminal 1 — the agent server (Pipecat dev runner)
uv run python son.py

# Terminal 2 — the web page
cd client/dist && python3 -m http.server 8000
```

Open <http://localhost:8000>, pick a role, hit **Connect**, and talk. (First launch downloads the Kokoro model files — a few MB, cached after that.)

## Adding a role

Drop a new file in `instructions/` with optional frontmatter, then regenerate the picker:

```markdown
---
name: Morning Coach
description: Plans your day and keeps you on track.
---

You are Son in the role of a morning coach. ...
```

```bash
uv run scripts/gen_roles.py
```

That's it — the role shows up in the picker on reload.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `GROQ_API_KEY` | — | Required. Free at console.groq.com |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq LLM model |
| `GROQ_STT_MODEL` | `whisper-large-v3-turbo` | Groq STT model |
| `KOKORO_VOICE` | `af_heart` | Kokoro voice id |

## Cost

Groq's free tier covers personal use: 30 requests/min, 14,400/day across STT + LLM, plus a daily Whisper transcription quota. Kokoro is free (local). See `docs/HANDOFF.md` for the numbers and the paid tier, which starts at ~$0.05/M tokens.

## How it works

```
browser (mic/speakers, WebRTC)
   │  audio up / audio down
   ▼
Pipecat runner (:7860) — Silero VAD turn detection
   │
   ├─ audio → Groq whisper → text
   ├─ text  → Groq llama (system prompt = instruction file) → reply text
   └─ reply text → Kokoro (local ONNX) → audio back to browser
```

The chosen role's instruction file is passed from the web page in the RTVI `/start` request and becomes the LLM's system instruction for that session. Sessions are ephemeral — no memory persists between them.

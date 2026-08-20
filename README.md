# Son ·

A personal real-time voice agent. Pick a role (instruction file), talk to it in your browser, hear it answer — with live speech, barge-in, and near-conversational latency.

**Stack (Tier 3 — hybrid, ~$0/month):**

| Piece | Tool (default) | Where it runs |
|---|---|---|
| Speech-to-text | Groq · whisper-large-v3-turbo (or **Parakeet TDT** / **whisper-small-son** local) | Cloud (free tier) / Local |
| Brain | Groq · openai/gpt-oss-120b | Cloud (free tier) |
| Text-to-speech | Kokoro-82M | **Local** (ONNX on CPU) |
| Voice pipeline | Pipecat 1.7 (BSD-2) | Local |
| Turn detection | Silero VAD | Local |

Every capability is swappable from the **⚙ settings panel**: add a DeepSeek, Cerebras, Gemini, or OpenRouter key and those providers appear in the picker too — or point it at a local LM Studio server (see `LMSTUDIO_*` below). Only your speech audio and text go to the provider you pick; the default voice is synthesized on your machine. Conversations persist in `son.db` and can be resumed from the sessions rail (see below).

## Prerequisites

- macOS / Linux, Python 3.11+ ([uv](https://docs.astral.sh/uv/))
- Node.js 20.19+ (Vite 7 requirement — for the client bundle, build once)
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
# One process — the bot AND the web page (son.py serves the built client)
uv run python son.py
```

Open <http://localhost:7860>, pick a role, hit **Start talking**, and talk. (First launch downloads the Kokoro model files — ~354MB one-time, cached after that.) No second server: the same app serves the UI, `/models`, `/sessions`, and the realtime endpoints. Rebuild the UI after client changes with `cd client && npm run build`.

Prefer a double-click over a terminal? `scripts/make_son_app.sh` builds **Son.app** in `~/Applications` — it starts the bot in a Terminal window (or reuses the running instance) and opens the page in your browser.

During client development, `cd client && npm run dev` serves the page with hot reload at <http://localhost:5173> (it still talks to the bot on :7860). `npm start` (build + preview on :8000) also still works if you want the page served separately.

## Ubuntu

Son runs on Ubuntu out of the box — no GPU, no audio drivers. The `uv sync` above resolves on Linux (manylinux wheels for both x86_64 and aarch64, Python 3.11–3.14), and both local models run on CPU: Parakeet STT idles around 480 MB RAM with short CPU bursts during a turn, Kokoro TTS the same. The server does no local audio I/O — the browser handles mic and speakers over WebRTC — so nothing ALSA/PulseAudio-related needs installing.

Run it the same way: `uv run python son.py` (wrap it in systemd or tmux if you want it daemonized; `scripts/make_son_app.sh` is macOS-only). Two footguns worth knowing:

- If `import sherpa_onnx` fails with a missing `libgomp.so`, fix it with `sudo apt install libgomp1`.
- The `sherpa-onnx-core==1.13.5` pin in `pyproject.toml` exists because the *macOS* wheel ships without its C++ core; on Linux the wheel is self-contained, so the pin is just an extra package (harmless — leave it so the same file keeps working on both).

## Read out (no AI)

The **Read** toggle in the header opens a text-to-speech page: paste anything, pick a voice, press **Speak** — it reads it back with a little media player (play/pause, ±10 s, speed 0.75–2×, download as WAV). No AI, no mic, no session. Voices are the same roster as the settings panel (Kokoro runs locally on your machine; the voice you pick here is also the chat voice), and speed is a playback control — it applies instantly without re-synthesizing.

The page has **Write** and **Preview** tabs — the textarea keeps whatever you paste (including raw markdown), and Preview renders it the way you'd read it in a Markdown viewer, math included (KaTeX for `$…$`, `$$…$$` and the `\(…\)` forms). A **Clean** toggle (on by default) strips the parts that don't read well aloud — code blocks, math, links, table cells, heading and list markers — before the text goes to the speech API, so a pasted technical article comes out as plain prose. Toggle it off to read the raw text as-is.

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
uv run scripts/gen_roles.py && cd client && npm run build && cd ..
```

`gen_roles.py` writes `client/public/roles.json`; the Vite build copies it into `dist/` (the dev server picks it up on reload). That's it — the role shows up in the picker on reload.

**Custom personas** — no file on disk, no regenerate: the picker's **Add persona** card creates a role from any markdown file of instructions (load a `.md`/`.txt` or paste it in; a `name:`/`description:` frontmatter block fills the fields, the rest becomes the instructions). Personas live in the browser (`localStorage`) and work like built-in roles — pick, talk, resume sessions — they're just not shared across browsers or machines.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `GROQ_API_KEY` | — | Required. Free at console.groq.com |
| `CEREBRAS_API_KEY` | — | Optional. Enables Cerebras brains (`gpt-oss-120b`, `zai-glm-4.7`) — cloud.cerebras.ai |
| `DEEPSEEK_API_KEY` | — | Optional. Enables DeepSeek brains (e.g. `deepseek-v4-flash`) |
| `GEMINI_API_KEY` | — | Optional. Enables Gemini brains, Google speech-to-text, and Gemini voices |
| `OPENROUTER_API_KEY` | — | Optional. Enables the curated OpenRouter brains (Claude, GPT, Grok…) and speech-to-text |
| `LMSTUDIO_API_KEY` | — | Optional. Enables local brains served by [LM Studio](https://lmstudio.ai) — any value if server auth is disabled |
| `LMSTUDIO_BASE_URL` | `http://127.0.0.1:1234/v1` | OpenAI-compatible root of the LM Studio server (use a tailnet IP to reach a remote machine) |
| `LMSTUDIO_MODEL` | `ornith-1.5-9b-mlx` | Default local LLM model |
| `STT_CLEANUP_MODEL` | — | Optional. Rewrite each final STT utterance through a local text-normalizer model (e.g. `s1-mini`) before the brain sees it — cleans Parakeet's raw transcript (punctuation, fillers, repeats). Empty = off |
| `STT_CLEANUP_BASE_URL` | `LMSTUDIO_BASE_URL` | OpenAI-compatible root for the cleanup model; auth reuses `LMSTUDIO_API_KEY` |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Default Groq LLM model |
| `GROQ_REASONING_EFFORT` | `medium` | gpt-oss reasoning effort: `low` (fastest, ~0.45s first content) / `medium` / `high` (smartest, slower) |
| `GROQ_STT_MODEL` | `whisper-large-v3-turbo` | Default Groq STT model |
| `WHISPER_LOCAL_MODEL` | `whisper-small-son` | Local STT model id sent to the whisper shim |
| `WHISPER_LOCAL_BASE_URL` | `http://127.0.0.1:8083/v1` | OpenAI-compatible root of the whisper shim (`whisper_local.py`) |
| `WHISPER_LOCAL_API_KEY` | `local` | Dummy key — the OpenAI SDK requires a non-empty value; whisper.cpp ignores Authorization |
| `KOKORO_VOICE` | `af_heart` | Default Kokoro voice id |
| `SON_DENOISE` | `1` | Noise suppression on mic input (RNNoise) before VAD/STT — set `0` to disable |
| `SON_AGC` | `1` | Quiet-speech auto gain: per-band normalization toward `SON_AGC_TARGET_DB` (mid band), gated so silence isn't amplified — set `0` to disable |
| `SON_AGC_TARGET_DB` | `-18` | AGC target level (dBFS) for the 1–3.5 kHz speech band |
| `SON_AGC_LOW_TARGET_DB` | `-25` | Target for the 0–1 kHz band — kept low so room rumble doesn't consume the gain budget |
| `SON_AGC_HIGH_TARGET_DB` | `-20` | Target for the 3.5–8 kHz band (sibilants, whispered consonants) |
| `SON_AGC_MAX_DB` | `24` | AGC max gain per band (dB) — caps how far quiet speech is pushed |
| `SON_AGC_GATE_DB` | `-45` | Below this input level (dBFS) the gain releases to 1 — no VAD pumping on silence (speech bands gate 10 dB lower so the quietest speech still gets gain) |
| `SON_VAD_CONFIDENCE` | `0.5` | Silero speech-probability threshold for turn detection (pipecat default `0.7` is tuned for loud speech) |
| `SON_VAD_START_SECS` | `0.15` | Consecutive speech needed to open a turn (lower = soft onsets aren't clipped) |
| `SON_VAD_STOP_SECS` | `0.7` | Consecutive silence needed to end a turn (higher = pauses don't chop soft speech into fragments) |
| `SON_VAD_MIN_VOLUME` | `0.35` | Minimum loudness (EBU R128, 0–1) for a frame to count as speech (default `0.6` gates out soft speech) |

A provider is enabled only when its API key is present. The settings panel (⚙ in the header) lists each capability with the models that are actually available — no key, no entry.

## Model settings

Click ⚙ to pick, per session:

- **Brain** — the reasoning/chat model (Groq, Cerebras, DeepSeek, Gemini, OpenRouter, or a local LM Studio server).
- **Speech-to-text** — how your voice becomes text (Groq Whisper, Google, OpenRouter, **NVIDIA Parakeet TDT** — a fully local ONNX model, no API key; the ~660 MB model downloads once on first use into `~/.cache/son/parakeet` — or **whisper-small-son**, a whisper fine-tuned on the author's voice and served locally by whisper.cpp; its second generation was retrained on soft/noisy audio for quiet speech). Set `STT_CLEANUP_MODEL` (e.g. `s1-mini` on LM Studio) and every final utterance is run through a local text normalizer before the brain sees it — Parakeet's raw transcript (no punctuation, "um"/"uh", repeats) arrives as clean prose. Before any provider sees it, mic audio goes through a clean-and-magnify stage: RNNoise denoise plus a per-band quiet-speech AGC (90 Hz high-pass, then 0–1 / 1–3.5 / 3.5–8 kHz bands normalized to −25 / −18 / −20 dBFS) that lifts the speech band even when low-frequency energy dominates — without amplifying silence.
- **Voice** — the voice that reads replies (local Kokoro, or Groq/Gemini cloud TTS).

Choices are saved in the browser and sent with each connection; the server falls back to the defaults if a provider's key is missing. Kokoro voices are synthesized on your machine; the others stream from their provider.

**whisper-small-son runs as two small local processes** outside Son: the whisper.cpp server (`:8081`) that does the transcription, and the `whisper_local.py` shim (`:8083`) that bridges whisper.cpp's `/inference` to the OpenAI protocol pipecat sends. The **Son.app** launcher starts whichever of them isn't already listening, so a normal launch needs nothing extra. If you run `son.py` directly instead, start them yourself first (`finetune/README.md` §4 has the commands) — the picker only lists the provider while the servers are up.

## Cost

Groq's free tier covers personal use: 30 requests/min, 14,400/day across STT + LLM, plus a daily Whisper transcription quota. Kokoro is free (local). Pick **Parakeet TDT** or **whisper-small-son** in ⚙ → Speech-to-text and the whole voice path runs on your machine — only the text you send to the brain leaves it. See `docs/HANDOFF.md` for the numbers and the paid tier, which starts at ~$0.05/M tokens.

## How it works

```
browser (mic/speakers, WebRTC)
   │  audio up / audio down
   ▼
Pipecat runner (:7860) — Silero VAD turn detection
   │
   ├─ audio → Groq whisper → text
   ├─ text  → Groq gpt-oss (system prompt = instruction file) → reply text
   └─ reply text → Kokoro (local ONNX) → audio back to browser
```

The chosen role's instruction file is passed from the web page in the RTVI `/start` request and becomes the LLM's system instruction for that session.

Replies are markdown, and the transcript keeps it that way — the chat bubble renders it and `son.db` stores it verbatim for resume. Only the speech path is cleaned: a text filter inside the TTS service strips the markers from each sentence right before synthesis, so `**TS2322**` is spoken as "TS2322", not "asterisk asterisk TS2322" (the `/speak` page uses its own client-side clean for the same reason).

## Sessions

Every conversation is a session that lives in `son.db` (SQLite, next to `son.py`) — names, timestamps, and the full transcript, written live as you talk. The left rail lists past sessions: click one to **resume it** (the transcript replays and the brain gets the full history back, so it remembers what you said — try ending, reloading, then asking "what did I just say?"). Double-click a name to rename, hover for delete, and use **New** in the header to start a clean conversation. The rail collapses from the header toggle.

The open conversation is named in the URL — `/s/<session_id>` — so a **reload reopens the same chat** instead of landing home, a shared link opens that conversation directly, and browser Back/Forward walk through the chats you've had open. A fresh chat lives at the root path.

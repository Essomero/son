<p align="center">
  <img src="icon-son.png" alt="Son icon" width="128" />
</p>

# Son ·

A personal real-time voice agent. Pick a role (instruction file), talk to it in your browser, hear it answer — with live speech, barge-in, and near-conversational latency.

Son runs fully standalone: it needs none of the Essomero sister repos. Soma (the learning platform) can use Son as an oral exam voice, but neither depends on the other.

**Stack (Tier 3 — hybrid, ~$0/month):**

| Piece | Tool (default) | Where it runs |
|---|---|---|
| Speech-to-text | **Browser Web Speech** (or Groq · whisper-large-v3-turbo / whisper-small-son / Parakeet TDT local) | Browser / Cloud / Local |
| Transcript cleanup | **s1-mini** (llama.cpp, `son start cleanup`) | **Local** (462 MB, ~1 GB RAM, ~0.2 s/utterance) |
| Brain | Groq · openai/gpt-oss-120b | Cloud (free tier) |
| Text-to-speech | Kokoro-82M | **Local** (ONNX on CPU) |
| Voice pipeline | Pipecat 1.7 (BSD-2) | Local |
| Turn detection | Silero VAD | Local |

Every capability is swappable from the **⚙ settings panel**: add a DeepSeek, Cerebras, Gemini, or OpenRouter key and those providers appear in the picker too — or point it at a local LM Studio server (see `LMSTUDIO_*` below). Speech-to-text defaults to the **browser's Web Speech**, so nothing local has to run for it — but that audio goes to Google unless Chrome's on-device language pack is installed, and if recognition fails the session falls back to local Parakeet on its own. Pick **Parakeet TDT** (or whisper-small-son) in ⚙ to keep speech off the network entirely; the default voice is synthesized on your machine either way. Conversations persist in `son.db` and can be resumed from the sessions rail (see below).

## Prerequisites

- macOS / Linux, Python 3.11+ ([uv](https://docs.astral.sh/uv/))
- Node.js 20.19+ (Vite 7 requirement — for the client bundle, build once)
- A free Groq API key: https://console.groq.com
- [llama.cpp](https://github.com/ggml-org/llama.cpp) for transcript cleanup — `brew install llama.cpp` on macOS. The 462 MB `s1-mini` model is fetched on first `son start cleanup`. Without either, cleanup passes raw transcripts through and nothing else breaks.

## Setup

```bash
# 1. Bot dependencies
uv sync

# 2. API key
cp .env.example .env      # then edit .env and set GROQ_API_KEY
# 3. The CLI (once) — symlinks scripts/son into ~/.local/bin
./scripts/son install     # then: son doctor, son start, son status, …
# If `son` is not found afterwards, ~/.local/bin is not on your PATH.
# Add it once: export PATH="$HOME/.local/bin:$PATH"   (then restart your shell)

# 4. Web client, browser extension, role roster
son build                 # or narrow it: son build client / extension / roles
```

## Run

```bash
son start server     # the bot alone: the web page AND the browser extension are clients of it
son start            # everything it can: bot + local voice stack, page opened in the browser
son status           # what's running, what's keyed, what's cached — and the URLs
son stop
```

`son start server` is the one that matters for the extension — the panel talks to
:7860 and nothing else has to be running. `son start` is the CLI's version of
double-clicking **Son.app**.

Open <http://localhost:7860>, pick a role, hit **Start talking**, and talk. (First launch downloads the Kokoro model files — ~354MB one-time, cached after that.) No second server: the same app serves the UI, `/models`, `/sessions`, and the realtime endpoints. Rebuild the UI after client changes with `son build client`.

Prefer a double-click? `scripts/make_son_app.sh` builds **Son.app** in `~/Applications` — it starts the bot in a Terminal window (or reuses the running instance) and opens the page. `son-app` in the shell (`alias son-app="open ~/Applications/Son.app"`) does the same thing without leaving a terminal alias in the way of the CLI.

During client development, `cd client && npm run dev` serves the page with hot reload at <http://localhost:5173> (it still talks to the bot on :7860). `npm start` (build + preview on :8000) also still works if you want the page served separately.

## What It Costs Your Machine

No GPU needed. Everything below is CPU and one-time downloads that cache on disk.

| Piece | Size on disk | RAM while in use | Required? |
|---|---|---|---|
| Kokoro TTS voices | ~354 MB, first launch | Small, per synthesis | Yes for voice replies (default voice) |
| Piper TTS voice | ~61 MB | Small, streams first audio fast | No, alternative to Kokoro |
| s1-mini cleanup model | ~462 MB GGUF | ~1 GB while cleaning utterances | No, raw transcripts work without it |
| Parakeet TDT STT | ~660 MB in `~/.cache/son/parakeet` | ~600 MB per active session, released after | No, only if picked in settings |
| whisper-small-son | via whisper.cpp checkout | Per transcription server | No, only if picked in settings |
| llama.cpp binary | `brew install llama.cpp` | Negligible idle | Only for local s1-mini cleanup |
| ffmpeg + ffprobe | `brew install ffmpeg` | During Tag conversions | Only for the Tag (audio labeling) page |

Default path (browser Web Speech for STT, Kokoro for voice) downloads only the Kokoro files and holds no STT model on the server.

## CLI

`scripts/son` is part of the repo — `git pull` updates it, and `son install` only
ever creates the PATH symlink (`~/.local/bin/son`). So "install" is really "check
my PATH is wired up", and it is safe to re-run.

| command | what it does |
|---|---|
| `son` | `son start` — the whole stack plus the page (what Son.app does) |
| `son build [all\|roles\|client\|extension]` | compile the roster / web client / extension |
| `son start [all\|server\|voice\|cleanup] [--foreground] [--open]` | bring services up in the background (detached, logged to `.runtime/`) |
| `son stop [all\|server\|voice\|cleanup] [--force]` | take them down — including ones Son.app started; `--force` also kills strangers holding the ports |
| `son restart [all\|server\|voice\|cleanup]` | stop, then start |
| `son status` | every port and **who holds it** (pid, command, uptime, where its log goes, whether it answers), any local-model download in flight, the URLs, provider keys (never their values), model caches, session counts, and whether the extension build is current — the live model list is one flag away (`--roster`) because that route asks every provider, and a report must never wait ~12 s on it |
| `son logs [server\|whisper\|shim\|cleanup] [-n N] [-f]` | service logs |
| `son open [page\|extensions]` | open the web page, or `chrome://extensions` to reload the unpacked extension |
| `son doctor` | preflight: uv, venv (and the default voice's package), the cleanup binary + its model, `.env`, provider keys, port conflicts |
| `son install [--force]` | link `scripts/son` onto PATH, and tell you if anything shadows it |

Two design notes worth knowing:

- **Liveness never uses `/models`.** That route probes every configured provider, so on a slow or flaky network it can take minutes; `/roles` answers instantly. Using `/models` as the health check would call a healthy bot "down" and refuse to start anything.
- **`son stop` is not limited to what `son start` started.** It falls back to whoever holds :7860/:8081/:8083 *if the process looks like Son's* (`son.py`, `whisper_local.py`, `whisper-server`) — the stack is just as often started by Son.app or by hand. `--force` drops that safety for genuinely foreign processes.

Ports come from `SON_PORT` (7860), `SON_WHISPER_PORT` (8081), `SON_SHIM_PORT` (8083); the whisper.cpp checkout from `WHISPER_CPP`; the repo from `SON_REPO`.

## Ubuntu

Son runs on Ubuntu out of the box — no GPU, no audio drivers. The `uv sync` above resolves on Linux (manylinux wheels for both x86_64 and aarch64, Python 3.11–3.14), and the default voice runs on CPU: Piper TTS is a 61 MB ONNX model that streams its first audio in ~50 ms, with the bigger Kokoro available alongside. Parakeet STT — the fallback, and what you get by picking it — is ~660 MB of files whose recognizer costs ~600 MB of RAM while a session uses it, released as soon as none does; with the Web Speech default the server holds no STT model at all. The server does no local audio I/O — the browser handles mic and speakers over WebRTC — so nothing ALSA/PulseAudio-related needs installing.

Run it the same way: `uv run python son.py` (wrap it in systemd or tmux if you want it daemonized; `scripts/make_son_app.sh` is macOS-only). Two footguns worth knowing:

- If `import sherpa_onnx` fails with a missing `libgomp.so`, fix it with `sudo apt install libgomp1`.
- The `sherpa-onnx-core==1.13.5` pin in `pyproject.toml` exists because the *macOS* wheel ships without its C++ core; on Linux the wheel is self-contained, so the pin is just an extra package (harmless — leave it so the same file keeps working on both).

## Read | Speak | Tag (no AI)

The **Read | Speak | Tag switch** at the foot of the rail opens one of three pages — the highlight slides between the labels, and they are different actions, so only one page is ever on the stage:

- **Read** — paste anything, pick a voice, press **Speak**: it reads it back with a little media player (play/pause, ±10 s, speed 0.75–2×, download as WAV, save as MP3/tags to a folder). **Paste & read** does both in one click: it takes the clipboard, drops it in the box and starts speaking — a click is also the gesture the clipboard API wants. **Clean with AI** runs the **Audio prompt** through your configured brain (`POST /rewrite`): markdown, math notation and links come back as spoken prose, list items as sentences — the same job the Audio prompt button is for, without the copy-into-an-LLM round trip (one brain call per click, and **Undo** puts the original back). **Audio prompt** still copies the prompt itself, for when you want to do that cleaning outside Son. No AI in the speak path: no mic, no session. Voices are the same roster as the settings panel (Kokoro runs locally on your machine; the voice you pick here is also the chat voice), and speed is a playback control — it applies instantly without re-synthesizing.
- **Speak** — dictation: the chat's own mic ring is the control here. Web Speech hands out no audio, so the page captures the mic itself while it listens — the same double-capture the chat already runs with WebRTC — and the bars are your real spectrum, lighting as you talk. Press it and talk, and each finished sentence lands in the box (editable) **and on your clipboard**, so you can paste it wherever the words are wanted. Muting pauses recognition — the text stays, unmuting **carries on appending to it**, and **Clear** is what starts a fresh one. Recognition runs in the tab (Chrome/Edge; the same engine the chat uses when its STT is `web-speech`), nothing is sent to the Son server, and it **tidies itself the moment you mute** — the local s1-mini normalizer fixes punctuation, casing and false starts in about 0.2 s, and the tidied text is what lands on the clipboard. The **Tidy** button stays for a manual pass after you edit — it copies what it produces, since the clipboard is the record, and says which of the three things happened: tidied and copied, nothing to fix, or cleanup not answering. Switching pages clears the box, which is fine: the clipboard is the record.
- **Tag** — label and convert audio files: the season tool for a personal podcast or an album tool for music. A **Podcast | Music** toggle switches between podcast metadata (show, host, season, episode, show notes, transcript) and music tags (album, artist, album artist, track, disc, lyrics, genre). **Add audio files** takes one recording or a season's/album's worth; each becomes an episode/track whose number and title you set, while the shared fields apply to every file. A shared field left blank leaves each file's own tag alone, so files that already carry their notes keep them. **More tags** edits any other tag the file has, or adds your own. Cover art follows the selection like every other field: with an episode selected, an image picked, dropped or pasted belongs to that episode; on the **ALL** card it belongs to the release and is embedded in every file a save writes (MP3/M4A). The **Convert & save** panel writes into the folder you choose: **Keep each file's format** copies the audio stream untouched (re-tagging costs no quality and takes no time), while choosing a format — MP3, M4A, Opus, OGG, FLAC, WAV — re-encodes it, with bitrate, sample rate and channels (the **Re-encode audio** toggle forces a fresh encode even in the same container). Nothing is synthesized: the files are yours, uploaded to the server on this machine, probed with `ffprobe` and written with `ffmpeg` (`POST /tag/inspect`, `POST /tag/save`). **Save** writes only the files the pass would actually change: a shared field marks the files whose own tag differs from it, an edit made on one file marks that file alone (and wins over the shared value there), and undoing an edit takes the file back off the list. Same-named files get `" (2)"` instead of being overwritten.

The page has **Write** and **Preview** tabs — the textarea keeps whatever you paste (including raw markdown), and Preview renders it the way you'd read it in a Markdown viewer, math included (KaTeX for `$…$`, `$$…$$` and the `\(…\)` forms). A **Clean** toggle (on by default) strips the parts that don't read well aloud — code blocks, math, links, table cells, heading and list markers — before the text goes to the speech API, so a pasted technical article comes out as plain prose. Toggle it off to read the raw text as-is.

**Building a season or album.** The Tag page closes the loop the other two open: Read turns text into audio (its **Save to folder** writes the WAV/MP3), Speak turns your voice into text — and Tag names what came out. A season or album is just a folder of files tagged in one pass: pick a folder, toggle **Podcast** or **Music** to match the material, set common fields and cover art once, give each file its number and title, and save them all to one format. A field left blank is not a blank tag — it is "keep whatever that file already has", so a file you labelled earlier, or one that arrived with its own notes, survives the pass. The Tag page needs `ffprobe` and `ffmpeg` on the server machine (`brew install ffmpeg`); without them it says so, and only the Read page's WAV export still works.

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
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Optional. Path to a GCP service-account JSON (or `gcloud auth application-default login`). Only needed for Google Cloud Speech-to-Text V2, which has no API-key auth. The Gemini key does not cover it. |
| `LMSTUDIO_API_KEY` | — | Optional. Enables local brains served by [LM Studio](https://lmstudio.ai) — any value if server auth is disabled |
| `LMSTUDIO_BASE_URL` | `http://127.0.0.1:1234/v1` | OpenAI-compatible root of the LM Studio server (use a tailnet IP to reach a remote machine) |
| `LMSTUDIO_MODEL` | `ornith-1.5-9b-mlx` | Default local LLM model |
| `STT_CLEANUP_MODEL` | `s1-mini` | Rewrite each final STT utterance through a text normalizer before the brain sees it, so raw speech ("um", repeats, no punctuation) arrives as clean prose. Default is the **local** `s1-mini`, served by `son start cleanup` (462 MB GGUF under llama.cpp, ~1 GB RAM, ~0.2 s per utterance) — no LM Studio needed. It also writes spoken numbers and dates out ("twenty five dollars" → `$25`) and resolves false starts; fillers are dropped on purpose. Set a model name here with `STT_CLEANUP_BASE_URL` pointing at an OpenAI-compatible server to use that instead, or set `""` to turn cleanup off |
| `STT_CLEANUP_BASE_URL` | `http://127.0.0.1:8090/v1` | OpenAI-compatible root for the cleanup model — the local llama-server by default. Point it at LM Studio (e.g. a tailnet IP) to use a remote normalizer; auth then reuses `LMSTUDIO_API_KEY` |
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

A provider is enabled only when its API key is present. The settings panel (⚙ at the foot of the sessions rail) lists each capability with the models that are actually available — no key, no entry.

## Model settings

Click ⚙ to pick, per session:

- **Brain** — the reasoning/chat model (Groq, Cerebras, DeepSeek, Gemini, OpenRouter, or a local LM Studio server).
- **Speech-to-text** — how your voice becomes text. Default: **Browser · Web Speech** — Chrome recognizes on your behalf, so the server runs no STT model at all (nothing to download, nothing resident), and if recognition fails the session falls back to Parakeet by itself (its files are pre-fetched, so the switch is a ~1.5 s build). That audio goes to Google unless Chrome's on-device language pack is installed, so pick a local model to keep speech off the network. Also offered: Groq Whisper, Google, OpenRouter, **NVIDIA Parakeet TDT** — a fully local ONNX model, no API key; the ~660 MB files download once into `~/.cache/son/parakeet`, the recognizer is built per session and released once no session is using it — or **whisper-small-son**, a whisper fine-tuned on the author's voice and served locally by whisper.cpp; the current soup generation is a weight average of a real-quiet retrain and an augmented soft-speech retrain, best of both registers on held-out audio). Set `STT_CLEANUP_MODEL` (on by default: the local `s1-mini`, `son start cleanup`) and every final utterance is run through a local text normalizer before the brain sees it — Parakeet's raw transcript (no punctuation, "um"/"uh", repeats) arrives as clean prose. The browser's Web Speech STT bypasses the server pipeline (its finals ride send-text), so in that mode the client runs each final through the same model via `POST /cleanup` before the brain sees it — same cleanup, just reached over HTTP instead of inside the pipeline. Before any provider sees it, mic audio goes through a clean-and-magnify stage: RNNoise denoise plus a per-band quiet-speech AGC (90 Hz high-pass, then 0–1 / 1–3.5 / 3.5–8 kHz bands normalized to −25 / −18 / −20 dBFS) that lifts the speech band even when low-frequency energy dominates — without amplifying silence.
- **Voice** — the voice that reads replies (local Piper — the fast default — or Kokoro, Groq/Gemini cloud TTS, browser speechSynthesis).

Choices are saved in the browser and sent with each connection; the server falls back to the defaults if a provider's key is missing. Kokoro voices are synthesized on your machine; the others stream from their provider.

**whisper-small-son runs as two small local processes** outside Son: the whisper.cpp server (`:8081`) that does the transcription, and the `whisper_local.py` shim (`:8083`) that bridges whisper.cpp's `/inference` to the OpenAI protocol pipecat sends. The **Son.app** launcher starts whichever of them isn't already listening, so a normal launch needs nothing extra. If you run `son.py` directly instead, start them yourself first (`finetune/README.md` §4 has the commands) — the picker only lists the provider while the servers are up.

## Cost

Groq's free tier covers personal use: 30 requests/min, 14,400/day across STT + LLM, plus a daily Whisper transcription quota. Kokoro is free (local). Speech-to-text defaults to the browser's Web Speech, which sends the audio to Google; pick **Parakeet TDT** or **whisper-small-son** in ⚙ → Speech-to-text and the whole voice path runs on your machine — only the text you send to the brain leaves it. See `docs/HANDOFF.md` for the numbers and the paid tier, which starts at ~$0.05/M tokens.

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

Every conversation is a session that lives in `son.db` (SQLite, next to `son.py`) — names, timestamps, and the full transcript, written live as you talk. The left rail is the app's frame — full height, the wordmark at its head, **Chat** under that, the **Read | Speak | Tag** switch, **Status** and the ⚙ holding its foot, with the session list scrolling in between. **Status** is a panel of its own, not a field in ⚙: which server the client is talking to, whether the live model roster loaded or it fell back to the built-in list, the cleanup stage, the roster counts, and the local models' warmup state — all read from routes that cost nothing to ask, since `/models` probes every configured provider and can take minutes on a cold cache. The header above the stage belongs to the chat: Read, Speak and Tag render without it, so those pages get the whole height. The wordmark and **Chat** both start a fresh conversation (the finished one keeps its row above, so nothing is lost): click a session to **resume it** (the stage switches to the chat, the transcript replays and the brain gets the full history back, so it remembers what you said — try ending, reloading, then asking "what did I just say?"). Double-click a name to rename, hover for delete, and use **New** in the header to start a clean conversation. The rail collapses from the chevron beside the **SESSIONS** title and comes back from the strip on its edge — collapsed, the strip keeps Chat, the Read | Speak | Tag switch and the ⚙ as icons, so nothing is stranded. The choice is remembered.

The open conversation is named in the URL — `/s/<session_id>` — so a **reload reopens the same chat** instead of landing home, a shared link opens that conversation directly, and browser Back/Forward walk through the chats you've had open. A fresh chat lives at the root path.

## Browser extension — talk to the page

The Chrome extension in `extension/` is a second client of the same bot: a side panel (or a small floating window) that listens while you read, and answers out loud about **the page you're on** — plus whatever you've selected. Same roles, same model roster, same sessions as the web page; the page text is what's new.

```bash
cd extension && npm install && npm run build
# chrome://extensions → Developer mode → Load unpacked → extension/dist
```

Then click the toolbar icon, press **Start**, and ask. The chips above the transcript show exactly what Son can see right now (host, selection, page text — click one to read the text that will be attached). `Alt+Shift+S` opens the panel; right-click a selection for **"Ask Son about the selection"**; **Read aloud** speaks the selection with the server's TTS and no model involved.

How the page reaches the brain — and how it stays cheap: the panel captures the selection (plus its paragraph) and the page's main text, and POSTs **only what changed** to `POST /page-context` for its session. `PageContextInjector` — a processor between the user aggregator and the LLM in `run_bot` — attaches each block to the conversation **once**, immediately before the question it arrived with, and from then on it is plain history: later questions carry it without the panel re-sending anything, and a new selection (or a new page) *replaces* its block instead of stacking. `son.db` never sees it (the block is written with the non-persisting `set_messages` path), so a resumed session replays the conversation, not a stale page. Above the transcript, `Page` and `Selection` are chips you control: × takes a source out of the conversation, + puts it back, `↻ re-attach` re-sends it at the end of a long chat. `/roles` serves the instruction-file roster for clients that never load the web bundle.

Full details, permissions and limitations: [`extension/README.md`](extension/README.md).

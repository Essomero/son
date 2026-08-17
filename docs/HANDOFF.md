# Son — Handoff doc

Status: **v1 scaffolded, needs live verification** (see [Verify](#verify) below). Written 2026-08-17.

## What this is

A personal real-time voice agent. You pick a "role" (a markdown instruction file), the agent speaks to you live in the browser with near-conversational latency, and it can be interrupted (barge-in). Roles are just files — no code changes — so "various things" is the default workflow.

## Architecture (Tier 3 — hybrid budget)

```
┌─ Browser (client/dist) ───────────────┐        ┌─ Son bot (son.py, local) ───────────────┐
│  mic/speakers via WebRTC              │        │  Pipecat 1.7.0 pipeline                  │
│  role picker + transcript             │  RTVI  │                                          │
│  @pipecat-ai/client-js 1.13           │ ─────► │  transport.input() → GroqSTTService      │
└───────────────────────────────────────┘        │  → LLMContextAggregatorPair (Silero VAD)  │
                                                  │  → GroqLLMService (system_instruction    │
                                                  │    = chosen instruction file)            │
                                                  │  → KokoroTTSService (local ONNX)         │
                                                  │  → transport.output()                    │
                                                  └──────────────────────────────────────────┘
```

- **Server**: Pipecat's dev runner (`pipecat.runner.run.main()`), one FastAPI app on `:7860` with `/start` + `/sessions/{id}/api/offer`. The bot function `bot(runner_args)` is called once per session; `runner_args.body.custom_data.instruction` selects the role.
- **Client**: static page (`python -m http.server 8000`), `startBotAndConnect({endpoint, requestData: {transport: "webrtc", body: {custom_data: {instruction}}}})`. The transport derives the offer URL from the endpoint automatically.
- **WebRTC** means the browser owns echo cancellation — no client-side audio processing needed.
- **STT**: Groq whisper-large-v3-turbo. **LLM**: Groq openai/gpt-oss-120b (OpenAI-compatible, `system_instruction` kwarg; `reasoning_effort: low` keeps first-content latency ~0.45s). **TTS**: Kokoro-82M, local ONNX runtime, auto-downloaded to the pipecat cache on first use.

## Key decisions & trade-offs

| Decision | Choice | Why / note |
|---|---|---|
| Framework | Pipecat over LiveKit | Pipeline-first Python fits a solo project; SmartTurnDetection-style turn handling via Silero VAD in the aggregator; no LiveKit server to run. LiveKit remains the upgrade path if you later need SIP/video/multi-agent. |
| STT+LLM in cloud | Groq | ~Free at personal scale; far faster than local models on this M1 Pro (local LLM was the latency bottleneck). Trade-off: audio leaves the machine. |
| TTS local | Kokoro-82M | Free, CPU-real-time, 50+ voices; quality per parameter is best-in-class. Trade-off: ~354MB model cache (kokoro-v1.0.onnx 325MB + voices 28MB), slow first-run download. |
| Transport | SmallWebRTC (browser) | No server-side audio infra; browser handles echo cancellation. |
| Memory | Session-only | System prompt + in-session conversation only. Logs/transcripts do not persist. |
| Roles | Folder + frontmatter | New role = new `.md` file + `gen_roles.py`. No code. |

## Cost sheet (per 2026-08 research)

| Item | Free tier | Paid tier |
|---|---|---|
| Groq LLM (gpt-oss-120b) | 30 req/min, 14,400 req/day | from $0.05–0.90/M tokens |
| Groq Whisper (large-v3-turbo) | daily transcription quota | per-second-ish billing, pennies/hr |
| Kokoro TTS | local, $0 | $0 |
| Pipecat | open source, $0 | $0 (managed Pipecat Cloud optional) |

Rough ceiling for heavy daily personal use: **$0–3/month**, vs ~$1.40/hr of pure conversation on Gemini Live Audio (Gemini 3.1 Flash Live: $0.005/min in + $0.018/min out). The free tiers will almost certainly cover you; the paid tiers are the fallback if you hit rate limits.

## Latency budget

- Target: **< 1.5s** from end-of-speech to first audio. Conversational ≈ 300–800ms; the pipeline adds Groq STT (~200–400ms) + LLM TTFT (~100–300ms) + Kokoro synthesis (~real-time streaming).
- Levers if slower: Silero VAD thresholds in `LLMUserAggregatorParams` (faster endpointing), `whisper-large-v3` → `whisper-3`-class smaller models, or moving TTS to Groq's TTS API (removes local synth but adds a cloud hop).
- Barge-in comes from the VAD + aggregator; if the agent talks over you, tune Silero params (see pipecat docs on `SileroVADAnalyzer` params: activation/silence thresholds).

## Verify

Runbook for a live check (needs the real mic — do this with the user):

1. `uv run python son.py` → `Uvicorn running on http://localhost:7860`; no "disabled" transport warnings.
2. Custom UI: `cd client/dist && python3 -m http.server 8000` → `http://localhost:8000` → pick a role → Connect → talk → hear Kokoro voice. (This Pipecat runner version does not mount a prebuilt UI at `/client` — the custom page is the UI.)
3. Pick Study Buddy → confirm the agent stays in role (proves customData → system_instruction).
4. Watch the bot console: usage metrics print per session (`enable_usage_metrics`).
5. Check Groq console for request counts under free limits.

Verification notes (2026-08-17, automated): WebRTC offer/ICE, customData → system_instruction (Study Buddy prompt logged verbatim), greeting LLM (0.77s steady-state) → Kokoro TTS (1.86s TTFA) → audio + `botOutput` transcript event all verified end-to-end via a CDP-driven browser. Session teardown (client disconnect → runner cancel) verified. **STT + VAD + barge-in still need a real-mic test** — that's the one thing a fake mic can't exercise.

Gotchas found during verification:
- **client-js 1.13 transcripts are callback-only**: `user-transcription` / `bot-output` messages reach `onUserTranscript` / `onBotOutput` callbacks but are NOT emitted via `client.on(RTVIEvent.*)`. `BotTranscript` is deprecated (no longer delivered). The client's transcript handlers must live in the `callbacks` object.
- **small-webrtc-transport never plays bot audio**: the installed version (1.10.6) stores received remote tracks (`_incomingTracks`) but attaches no sink — no audio element, no `addFrame` callers. Silence is the default. The client must take the track from `onTrackStarted` and play it through its own `<audio>` element (see `client/src/app.js`).
- **`onTrackStarted` also fires for the LOCAL mic track** (with a `participant` argument) — attach that and the user hears their own voice in the speakers. Guard on the participant arg; only the remote track (`participant` undefined) belongs in the speakers.
- **Groq rotates its model roster**: `llama-3.3-70b-versatile` was removed mid-2026 (404 `model_not_found` on every LLM call, surfacing as a cryptic `Error: [object Object]` because RTVIMessage has no `.message` — read `data.message`/`data.code`). If a model 404s again, `GET https://api.groq.com/openai/v1/models` lists what's live. `gpt-oss-120b` with `reasoning_effort: low` streams first content in ~0.45s.
- **First-run model download is 354MB** (325MB onnx + 28MB voices) at GitHub speeds (~1MB/s here); a fresh browser connection can time out and reconnect during it — it recovered cleanly. Second run is instant.
- **Runner has no `/client` prebuilt UI** in this version (404) — the custom page is the UI.
- `roles.json` is generated into `client/dist/` (served dir); re-run `uv run scripts/gen_roles.py` after adding roles AND after a clean checkout.
- Python stdout → log file buffering: watch `bot.log` for flushes, or run with `PYTHONUNBUFFERED=1` for live tails.

Loose ends:
- **Groq STT latency** varies; the `ttfs_p99_latency` default (1.54s) on `GroqSTTService` may need tuning.
- **Kokoro download** happens on first session (needs internet; verify cache path in logs).

## Extension guide

- **New role**: add `instructions/<name>.md` (+ frontmatter) → `uv run scripts/gen_roles.py` → refresh picker.
- **New voice**: change `KOKORO_VOICE` in `.env` (see Kokoro voice list — `af_*`/`am_*` etc.).
- **Different LLM**: swap `GroqLLMService` for any pipecat LLM service (OpenAI, Cerebras, etc.) — same `system_instruction` pattern.
- **Record sessions**: pipe `BotTranscript`/`UserTranscript` events from the client to a file (client-side) — no server change.
- **Tool use**: `GroqLLMService` supports pipecat tool calling (function schemas) — e.g., a "fetch the news" tool later.

## Share-later roadmap (v2, not started)

1. **Ephemeral tokens** — replace the client hitting `:7860/start` directly with a token endpoint so others don't need the runner exposed.
2. **Multi-user roles** — per-role public pages; roles.json already generic.
3. **Deployment** — Docker the bot (`pipecat-ai` has container docs); host the client on any static host; CORS is already `*` by default.
4. **Gemini Live upgrade path** — if quality/understanding needs a jump later: pipecat has `GeminiLiveLLMService` (speech-to-speech, built-in barge-in); the role/instruction mechanism ports unchanged (it takes `system_instruction` in settings).
5. **Persistent memory** — pipecat has official `mem0` RAG example if sessions should remember.

## How to run (reminder)

```bash
uv run python son.py                                # terminal 1 — bot :7860
cd client/dist && python3 -m http.server 8000       # terminal 2 — page
```

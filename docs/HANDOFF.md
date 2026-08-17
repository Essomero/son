# Son — Handoff doc

Status: **v1 scaffolded, needs live verification** (see [Verify](#verify) below). Written 2026-08-17.

## What this is

A personal real-time voice agent. You pick a "role" (a markdown instruction file), the agent speaks to you live in the browser with near-conversational latency, and it can be interrupted (barge-in). Roles are just files — no code changes — so "various things" is the default workflow.

## Architecture (Tier 3 — hybrid budget)

```
┌─ Browser (client/dist) ───────────────┐        ┌─ Son bot (son.py, local) ───────────────┐
│  mic/speakers via WebRTC              │        │  Pipecat 1.7.0 pipeline                  │
│  role picker + transcript             │  RTVI  │                                          │
│  ⚙ model settings (llm/stt/tts)       │ ─────► │  transport.input() → STT service         │
│  @pipecat-ai/client-js 1.13           │  GET   │  → LLMContextAggregatorPair (Silero VAD)  │
└───────────────────────────────────────┘  /models  → LLM service (system_instruction    │
                                                  │    = chosen instruction file)            │
                                                  │  → TTS service                            │
                                                  │  → transport.output()                    │
                                                  └──────────────────────────────────────────┘
```

- **Server**: Pipecat's dev runner (`pipecat.runner.run.main()`), one FastAPI app on `:7860` with `/start` + `/sessions/{id}/api/offer`, plus a custom `/models` route mounted in `__main__` (cached 60s; key-gated roster per capability — the readme project's `api/models.js` pattern). The bot function `bot(runner_args)` is called once per session; `runner_args.body.custom_data` carries `instruction` + the per-capability picks `llm` / `stt` / `tts` (each `{provider, id}`).
- **Client**: static page (`python -m http.server 8000`), `startBotAndConnect({endpoint, requestData: {transport: "webrtc", body: {custom_data}}}}`). The transport derives the offer URL from the endpoint automatically. The ⚙ panel fetches `/models`, renders one select per capability, persists choices in `localStorage` (`son.settings`), and sends them on every connect.
- **Provider gating**: a provider only appears when its key is in `.env` (`available_providers()` checks `GROQ_API_KEY` / `DEEPSEEK_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY`). `run_bot` validates each pick, falls back to defaults (groq whisper-large-v3-turbo / groq gpt-oss-120b / kokoro af_heart) on unknown or keyless providers, and logs one line: `Session: role=… llm=… stt=… tts=…`.
- **WebRTC** means the browser owns echo cancellation — no client-side audio processing needed.
- **STT**: Groq whisper-large-v3-turbo (default) or Google (`latest_short`/`latest_long` aliases + transcribe models). **LLM**: Groq gpt-oss-120b (OpenAI-compatible, `system_instruction` kwarg; `reasoning_effort` tunable via `GROQ_REASONING_EFFORT` — default `medium`, `low` gives ~0.45s first content, `high` is smarter but slower), or DeepSeek (`deepseek-v4-flash`/`pro`), Gemini, or curated OpenRouter models. **TTS**: Kokoro-82M local ONNX (default), or Groq/Gemini cloud TTS.

## Key decisions & trade-offs

| Decision | Choice | Why / note |
|---|---|---|
| Framework | Pipecat over LiveKit | Pipeline-first Python fits a solo project; SmartTurnDetection-style turn handling via Silero VAD in the aggregator; no LiveKit server to run. LiveKit remains the upgrade path if you later need SIP/video/multi-agent. |
| STT+LLM in cloud | Groq, swappable | ~Free at personal scale; far faster than local models on this M1 Pro (local LLM was the latency bottleneck). Trade-off: audio leaves the machine. DeepSeek/Gemini/OpenRouter unlock in the ⚙ panel as keys are added — gating by key presence (readme project pattern). |
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
2. Sanity-check the roster: `curl localhost:7860/models` → llm/stt/tts lists per provider, key-gated.
3. Custom UI: `cd client/dist && python3 -m http.server 8000` → `http://localhost:8000` → open ⚙ → pick a Brain (e.g. `deepseek-v4-flash` if that key is set) → pick a role → Connect → talk → hear the voice. (This Pipecat runner version does not mount a prebuilt UI at `/client` — the custom page is the UI.)
4. Watch the bot console: the `Session: role=… llm=… stt=… tts=…` line confirms the picks reached the server; usage metrics print per session (`enable_usage_metrics`).
5. Check the provider consoles for request counts under free limits.

Verification notes (2026-08-17, automated): WebRTC offer/ICE, customData → system_instruction (Study Buddy prompt logged verbatim), greeting LLM (0.77s steady-state) → Kokoro TTS (1.86s TTFA) → audio + `botOutput` transcript event all verified end-to-end via a CDP-driven browser. Settings panel verified: ⚙ opens with the live key-gated roster (42 llm / 4 stt / 31 tts), picking `deepseek-v4-flash` persisted to `localStorage` and produced `Session: … llm=deepseek/deepseek-v4-flash stt=groq/whisper-large-v3-turbo tts=kokoro/af_heart` with a clean greeting (no error frames). Session teardown (client disconnect → runner cancel) verified. **STT + VAD + barge-in still need a real-mic test** — that's the one thing a fake mic can't exercise.

Gotchas found during verification:
- **client-js 1.13 transcripts are callback-only**: `user-transcription` / `bot-output` messages reach `onUserTranscript` / `onBotOutput` callbacks but are NOT emitted via `client.on(RTVIEvent.*)`. `BotTranscript` is deprecated (no longer delivered). The client's transcript handlers must live in the `callbacks` object.
- **small-webrtc-transport never plays bot audio**: the installed version (1.10.6) stores received remote tracks (`_incomingTracks`) but attaches no sink — no audio element, no `addFrame` callers. Silence is the default. The client must take the track from `onTrackStarted` and play it through its own `<audio>` element (see `client/src/app.js`).
- **`onTrackStarted` also fires for the LOCAL mic track** (with a `participant` argument) — attach that and the user hears their own voice in the speakers. Guard on the participant arg; only the remote track (`participant` undefined) belongs in the speakers.
- **Groq rotates its model roster**: `llama-3.3-70b-versatile` was removed mid-2026 (404 `model_not_found` on every LLM call, surfacing as a cryptic `Error: [object Object]` because RTVIMessage has no `.message` — read `data.message`/`data.code`). If a model 404s again, `GET https://api.groq.com/openai/v1/models` lists what's live. `gpt-oss-120b` with `reasoning_effort: low` streams first content in ~0.45s.
- **Custom_data picks must OVERRIDE the defaults**: `run_bot` merges `{**defaults, **custom}` — if the client's `{provider, id}` maps to `model` only when it's missing, the default model survives and the wrong model id goes to the provider (DeepSeek 400'd with "you passed openai/gpt-oss-120b"). Rule: client `id` always wins; see the mapping comments in `run_bot`.
- **/models classification is substring-based**: Groq guard models hide their names mid-id (`meta-llama/llama-prompt-guard-*`, `openai/gpt-oss-safeguard-*`); `canopylabs/orpheus-*` is Groq's TTS. Match `"prompt-guard"`/`"safeguard"`/`"orpheus"` as substrings, not prefixes.
- **Provider imports need pip extras**: `from pipecat.services.google.*` requires `uv pip install 'pipecat-ai[google]'`, groq services need `'pipecat-ai[groq]'` — missing extras crash the import with `Missing module: …`.
- **Client default ≠ first roster option**: the ⚙ selects must land on the server's defaults (groq gpt-oss-120b / whisper-large-v3-turbo / kokoro af_heart), not the roster's first item — roster order is arbitrary API order (whisper-large-v3 sorts before `-turbo`).
- **First-run model download is 354MB** (325MB onnx + 28MB voices) at GitHub speeds (~1MB/s here); a fresh browser connection can time out and reconnect during it — it recovered cleanly. Second run is instant.
- **Runner has no `/client` prebuilt UI** in this version (404) — the custom page is the UI.
- `roles.json` is generated into `client/dist/` (served dir); re-run `uv run scripts/gen_roles.py` after adding roles AND after a clean checkout.
- Python stdout → log file buffering: watch `bot.log` for flushes, or run with `PYTHONUNBUFFERED=1` for live tails.

Loose ends:
- **Groq STT latency** varies; the `ttfs_p99_latency` default (1.54s) on `GroqSTTService` may need tuning.
- **Kokoro download** happens on first session (needs internet; verify cache path in logs).

## Extension guide

- **New role**: add `instructions/<name>.md` (+ frontmatter) → `uv run scripts/gen_roles.py` → refresh picker.
- **Different LLM**: already built in — add a provider key (or a `PROVIDER_ENV_KEYS` entry + a `build_llm_service` branch) and it shows up in the ⚙ panel. Same `system_instruction` pattern for any pipecat LLM service.
- **New voice**: add to `KOKORO_VOICES` (or any TTS provider's roster) — or just pick one in ⚙.
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

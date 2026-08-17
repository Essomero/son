# Son — Handoff doc

Status: **v2 — React client shipped and verified end-to-end** (see [Verify](#verify) below). Written 2026-08-17.

## What this is

A personal real-time voice agent. You pick a "role" (a markdown instruction file), the agent speaks to you live in the browser with near-conversational latency, and it can be interrupted (barge-in). Roles are just files — no code changes — so "various things" is the default workflow.

## Architecture (Tier 3 — hybrid budget)

```
┌─ Browser (client/dist) ───────────────┐        ┌─ Son bot (son.py, local) ───────────────┐
│  React 19 + Vite 7 client             │        │  Pipecat 1.7.0 pipeline                  │
│  mic/speakers via WebRTC              │        │                                          │
│  role cards + markdown transcript     │  RTVI  │  transport.input() → STT service         │
│  ⚙ model settings (llm/stt/tts)       │ ─────► │  → LLMContextAggregatorPair (Silero VAD)  │
│  @pipecat-ai/client-js 1.13           │  GET   │  → LLM service (system_instruction    │
└───────────────────────────────────────┘  /models  → TTS service                            │
                                                  │  → transport.output()                    │
                                                  └──────────────────────────────────────────┘
```

- **Server**: Pipecat's dev runner (`pipecat.runner.run.main()`), one FastAPI app on `:7860` with `/start` + `/sessions/{id}/api/offer`, plus custom `/models` (cached 60s; key-gated roster per capability — the readme project's `api/models.js` pattern) and `/sessions` (list/get/rename/delete) routes mounted in `__main__`. The bot function `bot(runner_args)` is called once per session; `runner_args.body.custom_data` carries `instruction`, `session_id`, and the per-capability picks `llm` / `stt` / `tts` (each `{provider, id}`).
- **Client**: React 19 + Vite 7 single-page app (`client/src/`, built to `client/dist/`, served with `python -m http.server`; `npm run dev` for hot reload). All session state lives in `useSonSession` — `startBotAndConnect({endpoint, requestData: {transport: "webrtc", body: {custom_data}}}})`, with the transport deriving the offer URL from the endpoint automatically. Transcript is markdown-rendered (react-markdown + remark-gfm); voice is visualized through a shared Web Audio analyser (`useAudioAnalyzer` — the mic button's ring and the speaking bot message's ring subscribe to the same rAF loop, no per-frame React state). All pickers are custom components (`Picker.tsx`: searchable list for brains/STT, avatar cards for voices) — zero native `<select>`s. The ⚙ panel fetches `/models`, persists choices in `localStorage` (`son.settings`), and sends them on every connect.
- **Provider gating**: a provider only appears when its key is in `.env` (`available_providers()` checks `GROQ_API_KEY` / `DEEPSEEK_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY`). `run_bot` validates each pick, falls back to defaults (groq whisper-large-v3-turbo / groq gpt-oss-120b / kokoro af_heart) on unknown or keyless providers, and logs one line: `Session: role=… llm=… stt=… tts=…`.
- **WebRTC** means the browser owns echo cancellation — no client-side audio processing needed.
- **STT**: Groq whisper-large-v3-turbo (default), OpenRouter (19 models via `output_modalities=transcription` — Whisper, GPT-Transcribe, Deepgram, Voxtral, Qwen3-ASR…), or Google (`latest_short`/`latest_long` aliases + transcribe models). OpenRouter rides `OpenAISTTService` with `base_url="https://openrouter.ai/api/v1"` — their `/audio/transcriptions` is OpenAI-compatible multipart, same request shape as Whisper. **LLM**: Groq gpt-oss-120b (OpenAI-compatible, `system_instruction` kwarg; `reasoning_effort` tunable via `GROQ_REASONING_EFFORT` — default `medium`, `low` gives ~0.45s first content, `high` is smarter but slower), or DeepSeek (`deepseek-v4-flash`/`pro`), Cerebras (`gpt-oss-120b`, `zai-glm-4.7` — chat-only, OpenAI-compatible, `CerebrasLLMService`), Gemini, or curated OpenRouter models. **TTS**: Kokoro-82M local ONNX (default), or Groq/Gemini cloud TTS.

## Key decisions & trade-offs

| Decision | Choice | Why / note |
|---|---|---|
| Framework | Pipecat over LiveKit | Pipeline-first Python fits a solo project; SmartTurnDetection-style turn handling via Silero VAD in the aggregator; no LiveKit server to run. LiveKit remains the upgrade path if you later need SIP/video/multi-agent. |
| STT+LLM in cloud | Groq, swappable | ~Free at personal scale; far faster than local models on this M1 Pro (local LLM was the latency bottleneck). Trade-off: audio leaves the machine. DeepSeek/Gemini/OpenRouter unlock in the ⚙ panel as keys are added — gating by key presence (readme project pattern). |
| TTS local | Kokoro-82M | Free, CPU-real-time, 50+ voices; quality per parameter is best-in-class. Trade-off: ~354MB model cache (kokoro-v1.0.onnx 325MB + voices 28MB), slow first-run download. |
| Transport | SmallWebRTC (browser) | No server-side audio infra; browser handles echo cancellation. |
| Memory | Sessions in SQLite | Transcripts persist (`son.db`) and resume with the full context seeded back into the brain. Ephemeral only when the client sends no `session_id`. |
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

## Sessions (SQLite persistence + resume)

`son.db` (next to `son.py`, WAL mode) holds `sessions` (id, name, role_file, role_name, timestamps, message_count, preview) and `messages` (role user/assistant, text, created_at, FK cascade).

- **Capture is write-through, zero pipeline changes**: `sessions_store.PersistedContext(LLMContext)` overrides `add_message`/`add_messages`/`set_messages`. The context aggregators commit every finalized turn through those (`push_aggregation` for speech at `llm_response_universal.py:838`, `_handle_llm_messages_append` for typed send-text at `:1115`, the assistant commit at `:1601`), so one DB row per turn lands live — no final dump needed after disconnect. `set_messages` is not persisted (the pipeline never replaces wholesale in this app). Only `user`/`assistant` with string content persist; developer messages (greeting, resume note) never do, so they can't replay as transcript.
- **The client owns the session id**: `runner_args.session_id` is a fresh server uuid per `/start` (`runner/run.py:704`), useless for resuming. The client sends `crypto.randomUUID()` in `custom_data.session_id`; `run_bot` creates the row if unknown, or seeds `PersistedContext(messages=[stored…])` and swaps the greeting for a developer note — *"The user is continuing this conversation — do not re-introduce yourself."* (its reply audibly confirms the resume and is a separate transcript row). No `session_id` → fully ephemeral, pre-sessions behavior.
- **REST**: `GET /sessions` (updated_at DESC), `GET /sessions/{id}` (meta + messages), `PATCH {name}` (400 on empty), `DELETE` (404 if absent). sqlite3 stdlib, one connection per operation (async loop + FastAPI threadpool), `PRAGMA busy_timeout=3000`, foreign_keys ON.
- **Client**: `useSessions` refetches on every phase change (connect creates the row, disconnect bumps updated_at → reorder) and patches the active row's preview/count live; `SessionsPanel` = resume (click), rename (double-click → inline input), delete (hover trash). `newSession()` disconnects, drops the transcript, mints a fresh id. Panel open-state persists in `localStorage` (`son.panel`).
- **Gotcha — bot rows at connection boundaries**: on resume the bot speaks without an intervening user row, so `mergeBotText` would fold its reply into the last stored bubble. `connect()` sets a `freshBotRowRef` flag; the first `onBotOutput` opens a new row (covers greeting, resume continuation, "Talk again"). Within one reply, subsequent segments merge as before.

## Verify

Runbook for a live check (needs the real mic — do this with the user):

1. `uv run python son.py` → `Uvicorn running on http://localhost:7860`; no "disabled" transport warnings.
2. Sanity-check the roster: `curl localhost:7860/models` → llm/stt/tts lists per provider, key-gated.
3. Custom UI: `cd client && npm start` → `http://localhost:8000` → open ⚙ → pick a Brain (e.g. `deepseek-v4-flash` if that key is set — the search box filters) → pick a role card → Start talking → talk → hear the voice. (This Pipecat runner version does not mount a prebuilt UI at `/client` — the custom page is the UI.)
4. Watch the bot console: the `Session: role=… llm=… stt=… tts=…` line confirms the picks reached the server; usage metrics print per session (`enable_usage_metrics`).
5. Check the provider consoles for request counts under free limits.

Verification notes (2026-08-17, automated): WebRTC offer/ICE, customData → system_instruction (Study Buddy prompt logged verbatim), greeting LLM (0.77s steady-state) → Kokoro TTS (1.86s TTFA) → audio + `botOutput` transcript event all verified end-to-end via a CDP-driven browser. Settings panel verified: ⚙ opens with the live key-gated roster (42 llm / 4 stt / 31 tts), picking `deepseek-v4-flash` persisted to `localStorage` and produced `Session: … llm=deepseek/deepseek-v4-flash stt=groq/whisper-large-v3-turbo tts=kokoro/af_heart` with a clean greeting (no error frames). Session teardown (client disconnect → runner cancel) verified. **STT + VAD + barge-in still need a real-mic test** — that's the one thing a fake mic can't exercise.

React rewrite verified (same day, CDP against the built `dist/`): hero + role cards → connect → Bro greeting (STT→LLM→Kokoro→speakers) → markdown transcript (bold/code/list render) → typed sendText round-trip (server answers `run_immediately` turns) → custom pickers (Brain groups by provider + live search filter "deepseek" → 3 options; voice grid renders decoded kokoro avatars — Alloy🇺🇸 / Alice🇬🇧 / Lily — with `🛰️` for cloud TTS) → `localStorage` persistence (`{"tts":{"provider":"kokoro","id":"bf_lily"}}`) → mute toggle (track-level `enabled=false` + best-effort `enableMic`; ring canvas cleared when muted, drawing analyser bars when live) → End session → "Talk again" reconnect (greeting + fresh mic state). `npm run typecheck` clean.

Gotchas found during verification:
- **client-js 1.13 transcripts are callback-only**: `user-transcription` / `bot-output` messages reach `onUserTranscript` / `onBotOutput` callbacks but are NOT emitted via `client.on(RTVIEvent.*)`. `BotTranscript` is deprecated (no longer delivered). The client's transcript handlers must live in the `callbacks` object.
- **small-webrtc-transport never plays bot audio**: the installed version (1.10.6) stores received remote tracks (`_incomingTracks`) but attaches no sink — no audio element, no `addFrame` callers. Silence is the default. The client must take the track from `onTrackStarted` and play it through its own `<audio>` element (a hidden one in `App.tsx`, ref into `useSonSession`). Note: feeding that element into the analyser uses `createMediaElementSource`, which reroutes the element's output — it must be connected to `ctx.destination` or the bot goes silent.
- **`onTrackStarted` also fires for the LOCAL mic track** (with a `participant` argument) — attach that and the user hears their own voice in the speakers. Guard on the participant arg; only the remote track (`participant` undefined) belongs in the speakers.
- **Groq rotates its model roster**: `llama-3.3-70b-versatile` was removed mid-2026 (404 `model_not_found` on every LLM call, surfacing as a cryptic `Error: [object Object]` because RTVIMessage has no `.message`). RTVIMessage error text lives in DIFFERENT data fields by origin: server error frames (pipeline ErrorFrame → `RTVI.Error`) carry it in `data.error` (`data = {error, fatal}` — see `rtvi/processor.py`), while client-side failures from `startBotAndConnect`/`_sendMessage` put a string in `data.message`. The client's `errorMessage()` unwraps `data.error ?? data.message ?? data.code` (JSON.stringify for object-valued messages). If a model 404s again, `GET https://api.groq.com/openai/v1/models` lists what's live. `gpt-oss-120b` with `reasoning_effort: low` streams first content in ~0.45s.
- **Groq models can need per-org terms acceptance**: `canopylabs/orpheus-v1-english` (the Groq TTS voice in the ⚙ picker) 400s with `model_terms_required` until the org accepts terms at `https://console.groq.com/playground?model=canopylabs/orpheus-v1-english` — the models list API does NOT surface this, so the picker cannot know. The error is non-fatal per sentence (greeting audio dies, session survives); the client now shows the real message including the link.
- **Custom_data picks must OVERRIDE the defaults**: `run_bot` merges `{**defaults, **custom}` — if the client's `{provider, id}` maps to `model` only when it's missing, the default model survives and the wrong model id goes to the provider (DeepSeek 400'd with "you passed openai/gpt-oss-120b"). Rule: client `id` always wins; see the mapping comments in `run_bot`.
- **OpenRouter STT roster**: `/models?output_modalities=transcription` filters server-side — the per-model `output_modalities` field is `[]` even on the filtered path (verified live 2026-08-17), so don't classify from the field; trust the query param. Same for OpenAI's roster endpoint.
- **/models classification is substring-based**: Groq guard models hide their names mid-id (`meta-llama/llama-prompt-guard-*`, `openai/gpt-oss-safeguard-*`); `canopylabs/orpheus-*` is Groq's TTS. Match `"prompt-guard"`/`"safeguard"`/`"orpheus"` as substrings, not prefixes. Gemini: the models list endpoint never fills `outputModalities` (always `None`), so "text-only" is a keyword filter over id+displayName — display names like "Nano Banana Pro" carry the modality when the id doesn't. The stable-text/no-preview filter applies to the **brain list only**: classify capability models (speech→stt, tts→tts) FIRST so Gemini TTS/STT models always land in their own pickers (the only modern one, `gemini-3.1-flash-tts-preview`, is itself a preview).
- **Provider imports need pip extras**: `from pipecat.services.google.*` requires `uv pip install 'pipecat-ai[google]'`, groq services need `'pipecat-ai[groq]'` — missing extras crash the import with `Missing module: …`.
- **Google STT has no API-key auth**: pipecat's `GoogleSTTService` is Cloud Speech-to-Text V2 only — it needs a GCP service account (`GOOGLE_APPLICATION_CREDENTIALS`) or `gcloud auth application-default login`; the `api_key=` kwarg is silently swallowed by `**kwargs`. Gating the picker on `GEMINI_API_KEY` lets users pick a Google STT model that then fails at auth ("Reauthentication is needed…"). It's gated on `google_stt_available()` instead: env var or ADC file PLUS a token-refresh probe — an expired ADC token (RefreshError "Reauthentication is needed") otherwise slips an existence check and still 503s at request time. `gcloud auth application-default login` re-unlocks it automatically. Gemini TTS (`GeminiTTSService`) DOES take `api_key`, so it stays gated on `GEMINI_API_KEY`.
- **Typed input rides RTVI `send-text`**: client-js `sendText(content, {run_immediately})` — the server appends a user turn (`LLMMessagesAppendFrame`) with zero bot-side changes; `run_immediately: true` interrupts the bot like speech barge-in. Typed text has NO outbound transcription event, so the client mirrors it into the transcript itself, through the same `mergeUserText` path as STT. Consecutive user turns share one "You" row via a `base` field (finalized text) — the new-row path must initialize base too, or a follow-up message replaces the previous one instead of appending (that bug shipped in the vanilla client and was caught in CDP verify; the rule carries over 1:1 in `client/src/lib/son.ts`).
- **Mute is a client-side trap**: client-js `enableMic()` returns nothing and the small-webrtc-transport's live-mic MediaManager doesn't implement it — the naive `const muted = await enableMic(...)` toggle is inverted (first click calls `enableMic(true)`, a no-op) AND one-way (undefined return keeps the state stuck). Mute at the track level (`localMicTrack.enabled = false` — the encoder then emits silence, so server VAD/STT hears nothing) and treat `enableMic` as best-effort signaling wrapped in try/catch. The local mic track arrives in `onTrackStarted` with a participant arg.
- **Client default ≠ first roster option**: the ⚙ pickers must land on the server's defaults (groq gpt-oss-120b / whisper-large-v3-turbo / kokoro af_heart), not the roster's first item — roster order is arbitrary API order (whisper-large-v3 sorts before `-turbo`). Resolution is `resolveChoice(cap, roster, saved)`: saved → server default → first; this bug hit the React rewrite as the transcript avatars showing the fallback 🎙️ glyph because `tts[0]` was a cloud voice.
- **client-js `Serializable` rejects interfaces and `undefined`**: `custom_data` is typed against a non-exported `Serializable` that requires an index signature — TS interfaces (`Choice`) don't satisfy it, and optional fields (`id?: string`) break it too. Pass inline object literals (`{provider, id}`), and send absent picks as `null` (which IS `Serializable`; the server treats it as unset via `or {}`).
- **Bot transcript merge rules (streaming + session reconnect)**: `mergeBotText` keeps a row when the new text is a prefix/suffix of it (duplicate segment), replaces it when it starts with the current text (cumulative growth), appends a new row otherwise. Bot rows merge into the LAST bot row only — a late-arriving greeting on reconnect (the bot's greeting pipeline can outlive the connect handshake) lands as its own row after the previous session's text, it does not clobber it. `mergeBotText(msgs, text, fresh)` forces a new row at connection boundaries (see Sessions above) — without it, a resumed session's first reply silently merges into the last stored bubble.
- **First-run model download is 354MB** (325MB onnx + 28MB voices) at GitHub speeds (~1MB/s here); a fresh browser connection can time out and reconnect during it — it recovered cleanly. Second run is instant.
- **Runner has no `/client` prebuilt UI** in this version (404) — the custom page is the UI.
- `roles.json` is generated into `client/public/` and the Vite build copies it to `client/dist/`; after adding roles re-run `uv run scripts/gen_roles.py && cd client && npm run build`. The client fetches it with `cache: "no-store"` — plain `python -m http.server` sends no cache headers, so browsers heuristically cache it and a new role otherwise never shows up on reload.
- Python stdout → log file buffering: watch `bot.log` for flushes, or run with `PYTHONUNBUFFERED=1` for live tails.

Loose ends:
- **Groq STT latency** varies; the `ttfs_p99_latency` default (1.54s) on `GroqSTTService` may need tuning.
- **Kokoro download** happens on first session (needs internet; verify cache path in logs).

## Extension guide

- **New role**: add `instructions/<name>.md` (+ frontmatter) → `uv run scripts/gen_roles.py` → refresh picker.
- **Different LLM**: already built in — add a provider key (or a `PROVIDER_ENV_KEYS` entry + a `build_llm_service` branch) and it shows up in the ⚙ panel. Same `system_instruction` pattern for any pipecat LLM service.
- **New voice**: add to `KOKORO_VOICES` (or any TTS provider's roster) — or just pick one in ⚙.
- **Record sessions**: done — every turn lands in `son.db` live (see Sessions above).
- **Tool use**: `GroqLLMService` supports pipecat tool calling (function schemas) — e.g., a "fetch the news" tool later.

## Share-later roadmap (v2, not started)

1. **Ephemeral tokens** — replace the client hitting `:7860/start` directly with a token endpoint so others don't need the runner exposed.
2. **Multi-user roles** — per-role public pages; roles.json already generic.
3. **Deployment** — Docker the bot (`pipecat-ai` has container docs); host the client on any static host; CORS is already `*` by default.
4. **Gemini Live upgrade path** — if quality/understanding needs a jump later: pipecat has `GeminiLiveLLMService` (speech-to-speech, built-in barge-in); the role/instruction mechanism ports unchanged (it takes `system_instruction` in settings).
5. **Cross-session memory** — sessions now recall their own transcripts; the next step would be memory that spans sessions (pipecat has an official `mem0` RAG example).

## Serving the web client (one process, one URL)

The built client is served by son.py itself — no second server:

- `__main__` registers `GET /` → `client/dist/index.html`, `GET /roles.json`,
  and mounts `/assets` **before** calling `main()`. That ordering matters:
  the runner registers its own routes (`/start`, `/ws`, `/status`, its `/`
  redirect to the prebuilt `/client` UI) inside `main()`, and Starlette
  matches routes in registration order — first match wins. A catch-all
  `app.mount("/", StaticFiles(...))` is ruled out for the same reason: it
  claims every path and shadows the runner's endpoints (StaticFiles answers
  non-GET with 405, missing files with 404).
- The client talks to the bot same-origin (`BOT_ENDPOINT` defaults to
  `http://localhost:7860/start`), so CORS is unused here; dev mode (:5173)
  still crosses origins and relies on the runner's CORS middleware.
- After UI changes: `cd client && npm run build`. Vite's dist layout is
  fixed (index.html + assets/ + roles.json), which is exactly what the three
  registrations serve.

## The read-out page (POST /speak)

The header's **Read** toggle swaps the stage for a text-to-speech page: paste
text, pick a voice from the same `/models` roster the settings panel uses,
get a WAV back. No AI, no mic, no session — a pure one-shot synthesis.

- `POST /speak` (registered in `__main__` with the other routes) takes
  `{text, voice: {provider, id}}` and returns `audio/wav`. Voice mapping
  mirrors `run_bot`'s: for kokoro the id is the voice id; for groq/gemini the
  id is the model name (their voice stays the service default). Unavailable
  providers fall back to kokoro, same as the chat path.
- All three providers yield `AudioRawFrame` (TTSAudioRawFrame subclasses it),
  so one collector gathers PCM chunks and `wave` wraps them — the client
  never deals with codecs.
- **Caching**: services are cached per `(provider, voice)` — building
  KokoroTTSService loads the ONNX model (~1 GB RAM, seconds) — with a
  per-service lock: `run_tts` streams through the service's own resampler,
  which isn't safe under concurrency. Different voices load separate models.
- **Sample-rate gotcha**: a TTS service adopted its output rate from the
  pipeline's StartFrame; standalone it stays 0 and soxr raises "Sample rate
  should be over 0". `_get_tts_service` sets `svc._sample_rate = 24000`
  (kokoro's native rate, no-op resample; cloud voices answer at it too).
  Groq is exempt — it reports the rate from its own API WAV.
- The client's speed control is `playbackRate` only, never a re-synthesis:
  pipecat's kokoro service hardcodes `speed=1.0` (`create_stream`), and one
  playback control works uniformly across providers.
- **Cleaning**: the textarea keeps the raw paste; when the Clean toggle is on
  (default), `cleanText` (`client/src/lib/clean.ts`) strips code blocks, math,
  links, table cells and heading/list markers — in that order, removals only,
  never rewrites — and *that* string is what `speak()` POSTs. The meta line
  shows "N chars · M will be read" so you can see the difference before
  speaking. Inline `$…$` spans are stripped wholesale (a pasted article's
  dollar pairs are equations, not prices — an earlier operator sniff let
  `$\alpha$` and long equations through as literal "dollar … dollar"); a
  lone `$` survives only as a price prefix, so "costs $5 per unit" keeps
  its five dollars.
- **Preview**: the Write/Preview tabs render the *raw* text with
  react-markdown + remark-gfm + remark-math + rehype-katex (safe by
  default — raw HTML is escaped), not the cleaned version; cleaning
  affects only what's spoken. `normalizeMath` runs on the text first:
  remark-math's flow math is fence-based (a single-line `$$…$$` would
  parse as inline), and `\(…\)`/`\[…\]` aren't parsed at all — the four
  common forms are rewritten to the ones remark-math understands. Use
  function replacements there, not `$`-strings — `$$` in a replacement
  string collapses to a literal `$`.
- **Download**: the player's download button saves the in-memory blob URL
  under a slug of the first four cleaned words (`audioName`), e.g.
  `scaling-rust-web-services.wav`. Blob URLs are revoked on unmount and on
  re-Speak; the player bar only exists while a blob is loaded.
- Client: `components/Reader.tsx` (tabs + textarea + Picker grid + player
  bar), `lib/clean.ts`, `SPEAK_URL` in `lib/son.ts`. The picker writes
  `settings.tts`, so a voice chosen here is also the chat voice.

## How to run (reminder)

```bash
uv run python son.py    # one process — bot + built web client on :7860
```

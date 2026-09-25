# Son — talk to the page

A Chrome extension that puts Son on whatever you're reading: press start, ask out
loud, hear the answer. The page you're on — plus anything you've selected — rides
along as context, so "what does this bit mean?" has something to point at.

Everything server-side is the existing bot (`son.py`). The extension is a second
client of it, like the web page in `client/`.

## Requirements

- The bot running locally: `son start server` (or `uv run python son.py`) — see the root
  `README.md`. That is all this extension needs; the web client and the local voice stack are
  optional. The extension talks to `http://localhost:7860` by default.
- Chrome 121+ (side panel + `tabs.lastAccessed`).

## Build + install

```bash
cd extension
npm install
npm run build          # typecheck + bundle → extension/dist
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → pick `extension/dist`. Pin the toolbar icon, and click it: the panel
opens as a side panel (it floats alongside the page and survives tab switches).
`Alt+Shift+S` opens it too.

Chrome will ask for microphone access the first time you start a session — the
panel only works with it allowed.

## Using it

- **Start** — connects to the bot and starts listening (server-side VAD decides
  when you're done talking; you can interrupt the answer by speaking).
- **Status dots** — `● server` and `● models` next to the name. Green means
  connected / roster loaded, amber means connecting or still loading, red means
  down, grey means nothing asked for yet; hover for the detail, and the `models`
  dot is a button that re-fetches the roster. Two slow things explain themselves
  here: the server's first `/models` call asks *every* configured provider (so it
  can sit in "loading" for a while), and a first-ever session needs local model
  files — while the server fetches those, `models` reads `models…` and its tooltip
  names what is downloading. Both are the server working, not a broken panel.
- **Chips** — what the conversation is carrying: the host, the page text, and the
  selection. The number is the size actually attached, and `in context` means the
  server has that exact text. Click the text to read what was attached, × to take
  a source out (later questions stop carrying it), + to put the current page or
  selection back, and `↻ re-attach` to send what's attached again — the move when
  a page question needs the page near the end of a long conversation.
- **Pause** — mutes the mic without dropping the session.
- **Read aloud** — speaks the selection (or the page) with the server's TTS and no
  model involved. The tired-eyes path: select, click, listen.
- **Type instead** — the same conversation by keyboard; the page context is
  attached exactly as it is for speech.
- **New conversation** — rotates the session id; the old one stays in `son.db` and
  in the web client's sessions rail.
- **Pop out** (⧉) — the same panel as a small floating window, drag it anywhere.
  Only one instance owns the conversation: the other stands aside.
- **Right-click → "Ask Son about the selection"** — opens the panel (connecting it
  if needed) and asks about what you highlighted.

## Settings

The gear icon opens, per install: the server URL, the role (the same
`instructions/*.md` roster the web client shows), and the **Brain / Speech-to-text
/ Voice** picks from the server's live `/models` list — the same key-gated roster
as the web panel. Speech-to-text starts on **Browser · Web Speech**, pinned rather
than left to the server: this panel is the half that runs the recognition, so it
never guesses what the session got. Brain and Voice stay on *Server default*
(sends `null`, `run_bot` chooses) until you pick.

Context is configurable too: how many characters of page text to carry (2k–40k,
20k by default; the server caps a block at 40,000 chars and a trimmed capture says
so on the chip). Which sources ride along is not a setting but the chips: × / + on
`Page` and `Selection`, so the choice is per source and visible while you talk.

## How the page gets into the answer

```
panel (extension page)                 bot (son.py)
  │ chrome.scripting → capture         │
  │  selection + block + page text     │
  │ POST /page-context (deltas) ──────►│ pending: session_id → [page, selection]
  │  …unchanged parts are not sent     │
  │ mic audio ──WebRTC───────────────► │ VAD → STT → user turn
  │                                    │   PageContextInjector attaches each
  │                                    │   block to the conversation, once
  │ ◄── bot audio + transcript ─────── │ LLM → TTS
```

Worth knowing:

- **Speech-to-text runs in the panel by default.** The session's STT is the
  browser's Web Speech, so the mic track stays closed — the server runs no STT
  service and receives text (`send-text`), each utterance first cleaned through
  `POST /cleanup` when `STT_CLEANUP_MODEL` is set. If recognition fails (no
  permission, no service, no recognizer — only Chrome and Edge ship the API) the
  panel reconnects the same conversation on local Parakeet and says so, naming the
  cause; a new chat tries Web Speech again.

- **Attached once, not re-sent.** The blocks enter the conversation when the panel
  first reports them, and from then on they *are* history: later questions carry
  them as part of the conversation rather than as a freshly inserted copy, and the
  panel only pushes a part when that part changed. Nothing changed → no request at
  all. That is what keeps a long chat from re-paying for the page every turn (and
  the unchanged prefix is what provider prompt caching can discount).
- **Each source is a chip you control.** `Page` and `Selection` sit above the
  transcript with a ×/+ switch, like Gemini's removable tab chip: × takes a source
  out of the conversation (later questions stop carrying it — the block is deleted,
  not just hidden), + attaches the current page or selection again. A new selection
  replaces the previous selection block and navigating replaces the page block, so
  the conversation holds at most one of each and the newest is what "this" and
  "this page" mean. `↻ re-attach` re-sends what's attached, which is the move when
  a page question needs the page back at the end of a long conversation.
- **Never persisted.** Blocks are written with `set_messages`, the documented
  replace-without-persisting path, so `son.db` holds the conversation and nothing
  else: a resumed session doesn't replay last week's page, and detaching a source
  really removes it. Drop the `Page` chip and the block leaves the live context
  while the transcript you already have stays intact.
- **The mic is not Daily's.** `client-js`'s transports default to Daily's media
  manager, which fetches and evaluates a remote bundle — forbidden under Manifest
  V3's CSP, and fatal before `/start` is ever sent. `src/lib/mediaManager.ts`
  supplies a getUserMedia-based manager instead (see the file for the details).

## Permissions, and why

| Permission | Used for |
|---|---|
| `sidePanel`, `tabs`, `contextMenus`, `storage`, `scripting` | the panel itself, knowing which tab you're on, the right-click entry, saved settings, reading the page |
| `audioCapture` | the microphone, in the panel |
| host `*://*/*` | reading the page you're on, and (as an extension page) calling `localhost:7860` without CORS |

Nothing is sent anywhere except your own bot: capture stays local until the panel
POSTs the text to `localhost:7860`, which is where the page text already has to go
for the model to see it.

## Limitations (by platform, not by choice)

- Chrome's own pages, the Web Store, and the **PDF viewer** can't be read —
  `chrome.scripting` refuses, and the chip says so. Local `file://` pages need
  *Allow access to file URLs* on the extension's details page.
- **Only the active tab** is attached; other tabs, your screen, and page audio are
  not. (The chip names the host so it's never ambiguous which page Son means.)
- First runs download the Piper voice (~60 MB) and Parakeet's files (~660 MB,
  pre-fetched at startup so the Web Speech fallback is a ~1.5 s build rather than
  a download) — subsequent sessions start instantly. The Parakeet recognizer
  itself is built only while a session needs it, and released when none does.
- Selecting across iframes can capture only the part the page itself holds.
- Page text is capped (12,000 chars server-side, plus whatever you set for the
  page budget): long articles are trimmed, selection first, with a `…[truncated]`
  marker.

## Troubleshooting

- **"Couldn't reach Son at http://localhost:7860"** — the bot isn't running.
  Start it, then press Start again. The notice links straight to the full web UI.
- **The model pickers say "Start the server to list the models"** — `/models`
  probes every configured provider, so one unreachable local server (LM Studio
  down, a tailnet IP that stopped answering) can push the first call past the
  timeout. The panel retries on its own; *reload* in Settings is the manual nudge.
- **"Can't read this page"** — see Limitations above. If a page you can read shows
  this after you pop the panel out, the chip's note says whether the last page Son
  could read is still attached.
- **No audio** — the panel needs one click in itself before it may play (browser
  autoplay policy); pressing Start is that click. If the bot answers in text only,
  check the Voice pick in Settings.

## Development

```bash
npm run watch     # rebuild dist/ on change
```

Rebuild → `chrome://extensions` → the reload arrow on the Son card. Files:

- `src/background.ts` — MV3 service worker: which tab to read, capture, the
  in-page selection watcher, context-menu/command entry points.
- `src/lib/capture.ts` — the two functions injected into pages (`capturePage`,
  `watchSelection`). Self-contained by contract: `chrome.scripting` serializes
  their source, so no imports or closures.
- `src/lib/mediaManager.ts` — getUserMedia mic manager for the WebRTC transport.
- `src/lib/merge.ts` — transcript merge rules, ported from `client/src/lib/son.ts`.
- `src/sidepanel/` — the React panel (`useSon.ts` is the whole voice session:
  connect, transcript, page-context pushes, mute, read-aloud).

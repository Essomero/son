// Son — web client. Picks a role (instruction file), connects to the bot
// over WebRTC, and shows the live transcript.
//
// The page is served statically; the bot runs on :7860 (Pipecat runner).
// Endpoint can be overridden with ?endpoint=http://host:7860/start

import { PipecatClient } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";

const params = new URLSearchParams(location.search);
const BOT_ENDPOINT = params.get("endpoint") || "http://localhost:7860/start";
const MODELS_URL = BOT_ENDPOINT.replace(/\/start$/, "") + "/models";

const state = {
  client: null,
  role: null,
  connected: false,
  botAudio: null, // <audio> element playing the bot's WebRTC audio track
  localMicTrack: null, // the user's live mic track, for track-level muting
};

// Lightweight test hook: ?debug exposes internal state for CDP verification.
if (new URLSearchParams(location.search).has("debug")) window.__son = state;

// --- DOM refs ---------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const roleGrid = $("roles");
const statusEl = $("status");
const transcriptEl = $("transcript");
const connectBtn = $("connect");
const muteBtn = $("mute");
const disconnectBtn = $("disconnect");
const controlsEl = $("controls");
const textInput = $("text-input");
const sendBtn = $("send");
const settingsBtn = $("settings-btn");
const settingsModal = $("settings-modal");
const settingsClose = $("settings-close");

// --- Transcript -------------------------------------------------------------

function addTranscript(role, text) {
  if (!text) return;
  const row = document.createElement("div");
  row.className = `row ${role}`;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = role === "user" ? "You" : "Son";
  const body = document.createElement("span");
  body.className = "text";
  body.textContent = text;
  row.append(who, body);
  transcriptEl.append(row);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return row;
}

function lastRow() {
  return transcriptEl.querySelector(".row:last-child");
}

// One "You" row per consecutive user run: a new utterance (an STT segment or
// a typed message) that follows a completed user row continues that row
// instead of opening another — consecutive user turns share one identifier.
// Partial STT frames grow the current utterance in place; the finalized text
// is kept in dataset.base so the next utterance can append to it (partials of
// a fresh utterance only ever replace their own span, not earlier ones).
function addUserText(text, final) {
  if (!text) return;
  const last = lastRow();
  if (last?.classList.contains("user")) {
    const el = last.querySelector(".text");
    const base = last.dataset.base || "";
    el.textContent = base ? `${base} ${text}` : text;
    if (final) {
      last.dataset.base = el.textContent;
      last.dataset.final = "1";
    }
    return last;
  }
  const row = addTranscript("user", text);
  if (final) {
    // Keep the finalized text in base (same as the merge path) so a follow-up
    // message appends to it instead of replacing it.
    row.dataset.base = text;
    row.dataset.final = "1";
  }
  return row;
}

function stopBotAudio() {
  if (!state.botAudio) return;
  state.botAudio.pause();
  state.botAudio.srcObject = null;
  state.botAudio = null;
}

// Autoplay-policy insurance: if the audio element's first play() was blocked
// (no user gesture yet), retry on the next click on the page.
document.addEventListener("pointerdown", () => {
  if (state.botAudio?.paused) state.botAudio.play().catch(() => {});
});

// --- Roles ------------------------------------------------------------------

async function loadRoles() {
  try {
    // no-store: python -m http.server sends no cache headers, so browsers
    // heuristically cache roles.json and a new role never shows up on a
    // plain reload.
    const res = await fetch("roles.json", { cache: "no-store" });
    return await res.json();
  } catch {
    return [];
  }
}

function renderRoles(roles) {
  if (!roles.length) {
    roleGrid.innerHTML =
      '<p class="empty">No roles found. Add a .md file to the instructions folder and run <code>uv run scripts/gen_roles.py</code>.</p>';
    return;
  }
  for (const role of roles) {
    const card = document.createElement("button");
    card.className = "role-card";
    card.dataset.file = role.file;
    const name = document.createElement("span");
    name.className = "role-name";
    name.textContent = role.name;
    const desc = document.createElement("span");
    desc.className = "role-desc";
    desc.textContent = role.description;
    card.append(name, desc);
    card.addEventListener("click", () => selectRole(role, card));
    roleGrid.append(card);
  }
}

function selectRole(role, card) {
  state.role = role;
  roleGrid.querySelectorAll(".role-card").forEach((c) => c.classList.remove("selected"));
  card.classList.add("selected");
  setStatus(`Ready to talk as “${role.name}”`);
  connectBtn.disabled = false;
}

// --- Model settings ---------------------------------------------------------
// The ⚙ gear opens a modal with one select per capability (llm/stt/tts),
// populated from the bot's live /models endpoint. Choices are persisted in
// localStorage and sent in custom_data on connect; the server validates them
// (a provider whose key is missing falls back to the default).

const SETTINGS_KEY = "son.settings";
const SETTINGS_CAPS = ["llm", "stt", "tts"];

// What the picker lands on with no saved choice — must mirror the server's
// run_bot defaults, not just "the first option in the roster".
const DEFAULT_CHOICES = {
  llm: { provider: "groq", id: "openai/gpt-oss-120b" },
  stt: { provider: "groq", id: "whisper-large-v3-turbo" },
  tts: { provider: "kokoro", id: "af_heart" },
};

// If the bot isn't running the page still needs a usable picker.
const FALLBACK_MODELS = {
  llm: [{ provider: "groq", id: "openai/gpt-oss-120b", label: "openai/gpt-oss-120b" }],
  stt: [{ provider: "groq", id: "whisper-large-v3-turbo", label: "whisper-large-v3-turbo" }],
  tts: [
    { provider: "kokoro", id: "af_heart", label: "af_heart" },
    { provider: "kokoro", id: "af_bella", label: "af_bella" },
    { provider: "kokoro", id: "am_adam", label: "am_adam" },
    { provider: "kokoro", id: "bm_george", label: "bm_george" },
  ],
};

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// Each option's value is JSON.stringify({provider, id}) — ids can contain
// slashes (openrouter "anthropic/claude-sonnet-4.6"), so no delimiter tricks.
function populateSelect(sel, models, current, fallback) {
  sel.innerHTML = "";
  const byProvider = {};
  for (const m of models) (byProvider[m.provider] ??= []).push(m);
  for (const [provider, list] of Object.entries(byProvider)) {
    const group = document.createElement("optgroup");
    group.label = provider;
    for (const m of list) {
      const opt = document.createElement("option");
      opt.value = JSON.stringify({ provider: m.provider, id: m.id });
      opt.textContent = m.label && m.label !== m.id ? `${m.label} — ${m.id}` : m.id;
      group.append(opt);
    }
    sel.append(group);
  }
  // Restore the saved choice if it's still offered; else the default for this
  // capability; else the first option.
  const wanted = current ?? fallback;
  const wantedVal = JSON.stringify({ provider: wanted?.provider, id: wanted?.id });
  sel.value = [...sel.options].some((o) => o.value === wantedVal)
    ? wantedVal
    : sel.querySelector("option")?.value || "";
}

function currentChoices() {
  const choices = {};
  for (const cap of SETTINGS_CAPS) {
    const v = $(`set-${cap}`).value;
    if (v) choices[cap] = JSON.parse(v);
  }
  return choices;
}

function persistSettings() {
  saveSettings(currentChoices());
}

async function initSettings() {
  let models;
  try {
    const res = await fetch(MODELS_URL, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    models = await res.json();
  } catch {
    console.warn("[Son] /models unreachable — using fallback list");
    models = FALLBACK_MODELS;
  }
  const saved = readSettings();
  for (const cap of SETTINGS_CAPS) {
    const sel = $(`set-${cap}`);
    populateSelect(sel, models[cap] || [], saved[cap], DEFAULT_CHOICES[cap]);
    sel.addEventListener("change", persistSettings);
  }
  settingsBtn.addEventListener("click", () => {
    settingsModal.hidden = false;
  });
  settingsClose.addEventListener("click", () => {
    settingsModal.hidden = true;
  });
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) settingsModal.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") settingsModal.hidden = true;
  });
}

// --- Bot connection ---------------------------------------------------------

function setStatus(text) {
  statusEl.textContent = text;
}

// client-js hands errors (in the onError callback AND in promise rejections)
// an RTVIMessage whose readable text lives in different data fields depending
// on where the error came from:
//   - server error frames (a pipeline ErrorFrame → RTVI Error message):
//       data = { error: <text>, fatal: <bool> }
//   - client-side failures (startBotAndConnect HTTP/network):
//       data = { message: <text>, fatal: true }
// There is no .message on the object itself, so String(err) is "[object Object]".
function errorMessage(err) {
  const data = err?.data ?? {};
  if (typeof data === "string") return data;
  const text = data.error ?? data.message ?? data.code;
  if (typeof text === "string") return text;
  if (text && typeof text === "object") return JSON.stringify(text);
  return err?.message ?? String(err);
}

// Note: in client-js 1.13, user-transcription and bot-output messages only
// reach their callbacks (onUserTranscript / onBotOutput) — they are not
// emitted via client.on(RTVIEvent.*). So both transcript paths live here.
function setupClient() {
  const client = new PipecatClient({
    transport: new SmallWebRTCTransport(),
    enableMic: true,
    enableCam: false,
    callbacks: {
      onConnected: () => {
        state.connected = true;
        setStatus("Connected — you can talk.");
        controlsEl.hidden = false;
        connectBtn.hidden = true;
        muteBtn.disabled = false;
        textInput.focus();
      },
      onDisconnected: () => {
        state.connected = false;
        setStatus("Disconnected.");
        controlsEl.hidden = true;
        connectBtn.hidden = false;
        stopBotAudio();
        // Fresh session = fresh mic state.
        state.localMicTrack = null;
        muteBtn.dataset.muted = "";
        muteBtn.textContent = "Mute";
        muteBtn.disabled = true;
      },
      onBotReady: () => setStatus("Connected — you can talk."),
      onError: (err) => {
        console.error("[Son] connect error", err);
        setStatus(`Error: ${errorMessage(err)}`);
      },
      // The small-webrtc transport receives the bot's audio track but never
      // attaches it to any sink, so nothing would be audible. We take the
      // track from onTrackStarted and play it through our own <audio> element.
      // CAUTION: this callback fires for the LOCAL mic track too (with a
      // participant arg) — only the remote bot track (participant undefined)
      // belongs in the speakers; attaching the mic track plays the user's own
      // voice back at them.
      onTrackStarted: (track, participant) => {
        // The LOCAL mic track also arrives here (with a participant arg) —
        // keep it so Mute can disable it at the track level; it never
        // belongs in the speakers (see the note above).
        if (participant) {
          if (track?.kind === "audio") state.localMicTrack = track;
          return;
        }
        if (track?.kind !== "audio" || state.botAudio) return;
        console.log("[Son] bot audio track received");
        const audio = new Audio();
        audio.autoplay = true;
        audio.srcObject = new MediaStream([track]);
        // Keep it in the DOM so it stays alive and is inspectable in devtools.
        audio.style.position = "fixed";
        audio.style.left = "-9999px";
        document.body.append(audio);
        audio.play().catch((e) => console.warn("[Son] audio play blocked:", e));
        state.botAudio = audio;
      },
      onTrackStopped: () => stopBotAudio(),
      // User speech: partials stream in (final: false) and grow the current
      // user row in place; the final transcription locks it in.
      onUserTranscript: (data) => {
        if (!data?.text) return;
        addUserText(data.text, !!data.final);
      },
      // botOutput streams each reply as the LLM generates it. A reply always
      // follows a user turn (or the greeting), so when the last row is NOT a
      // bot row, this is a new reply: start a fresh row. Otherwise grow the
      // current bot row in place — never overwrite an earlier reply.
      //
      // The server can send the same segment text more than once: per
      // sentence from the TTS side, again from the LLM-response aggregator,
      // and (for legacy clients) word-level frames — possibly out of order.
      // Merge rules, in order:
      //   - empty row: take the first chunk
      //   - data.text already present as a prefix or suffix of the row
      //     (a duplicate segment): keep the row unchanged
      //   - data.text extends the current text (cumulative growth): replace
      //   - otherwise it's a genuinely new segment: append
      onBotOutput: (data) => {
        if (!data?.text) return;
        const last = lastRow();
        // NOTE: addTranscript guards against empty text (returns undefined),
        // so a new bot row must be created with a non-empty first chunk —
        // passing "" would throw on querySelector below.
        let row = last?.classList.contains("bot") ? last : null;
        if (!row) row = addTranscript("bot", data.text);
        const el = row.querySelector(".text");
        const cur = el.textContent;
        if (!cur) {
          el.textContent = data.text;
        } else if (cur.startsWith(data.text) || cur.endsWith(data.text)) {
          // duplicate segment — already in the row
        } else if (data.text.startsWith(cur)) {
          el.textContent = data.text;
        } else {
          el.textContent = cur + " " + data.text;
        }
      },
    },
  });

  return client;
}

async function connect() {
  if (!state.role || state.connected) return;
  setStatus("Connecting…");
  try {
    state.client = setupClient();
    await state.client.startBotAndConnect({
      endpoint: BOT_ENDPOINT,
      requestData: {
        transport: "webrtc",
        body: {
          custom_data: { instruction: state.role.file, ...currentChoices() },
        },
      },
    });
  } catch (err) {
    console.error("[Son] connect rejected", err);
    setStatus(`Connection failed: ${errorMessage(err)}`);
    state.client = null;
    connectBtn.disabled = false;
  }
}

// --- Controls ---------------------------------------------------------------

// Typed messages ride the RTVI send-text message: the server appends the text
// as a user turn and (with run_immediately) answers it right away, barging in
// like speech would. The text has no outbound transcription event, so we
// mirror it into the transcript ourselves — through the same row-merging
// path as STT so consecutive typed/spoken turns share one "You" row.
function sendTextMessage() {
  const text = textInput.value.trim();
  if (!text || !state.client || !state.connected) return;
  state.client.sendText(text, { run_immediately: true }).catch((e) => {
    console.warn("[Son] sendText failed:", e);
  });
  addUserText(text, true);
  textInput.value = "";
  textInput.style.height = "auto";
  textInput.focus();
}

textInput.addEventListener("keydown", (e) => {
  // Enter sends; Shift+Enter inserts a newline (for pasted markdown you want
  // to review before sending).
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendTextMessage();
  }
});
textInput.addEventListener("input", () => {
  // Auto-grow for pasted content: fit up to ~160px, then scroll inside.
  textInput.style.height = "auto";
  textInput.style.height = Math.min(textInput.scrollHeight, 160) + "px";
});
sendBtn.addEventListener("click", sendTextMessage);

async function toggleMute() {
  if (!state.client) return;
  const mute = !muteBtn.dataset.muted; // what the user is asking for next
  // Mute at the track level: a disabled track makes the encoder emit
  // silence, so the server's VAD/STT hears nothing while the connection
  // stays up. Mirror it to client-js's enableMic for the server-side
  // trackStatus signalling — best effort; some transports return nothing
  // or throw, and that must never wedge the button.
  if (state.localMicTrack) state.localMicTrack.enabled = !mute;
  try {
    await state.client.enableMic(!mute);
  } catch (e) {
    console.warn("[Son] transport enableMic failed (track-level mute still active):", e);
  }
  muteBtn.dataset.muted = mute ? "1" : "";
  muteBtn.textContent = mute ? "Unmute" : "Mute";
}

async function disconnect() {
  if (!state.client) return;
  setStatus("Disconnecting…");
  await state.client.disconnect();
  state.client = null;
}

// --- Init -------------------------------------------------------------------

connectBtn.addEventListener("click", connect);
muteBtn.addEventListener("click", toggleMute);
disconnectBtn.addEventListener("click", disconnect);
muteBtn.disabled = true;

loadRoles().then(renderRoles).catch(() => renderRoles([]));
initSettings();

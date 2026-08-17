// Son — web client. Picks a role (instruction file), connects to the bot
// over WebRTC, and shows the live transcript.
//
// The page is served statically; the bot runs on :7860 (Pipecat runner).
// Endpoint can be overridden with ?endpoint=http://host:7860/start

import { PipecatClient } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";

const params = new URLSearchParams(location.search);
const BOT_ENDPOINT = params.get("endpoint") || "http://localhost:7860/start";

const state = {
  client: null,
  role: null,
  connected: false,
  botAudio: null, // <audio> element playing the bot's WebRTC audio track
};

// --- DOM refs ---------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const roleGrid = $("roles");
const statusEl = $("status");
const transcriptEl = $("transcript");
const connectBtn = $("connect");
const muteBtn = $("mute");
const disconnectBtn = $("disconnect");
const controlsEl = $("controls");

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
    const res = await fetch("roles.json");
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

// --- Bot connection ---------------------------------------------------------

function setStatus(text) {
  statusEl.textContent = text;
}

// client-js hands errors (in the onError callback AND in promise rejections)
// an RTVIMessage whose readable text lives in data.message / data.code —
// there is no .message on the object itself, so String(err) is "[object Object]".
function errorMessage(err) {
  const data = err?.data ?? {};
  return typeof data === "string" ? data : data?.message ?? data?.code ?? String(err);
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
      },
      onDisconnected: () => {
        state.connected = false;
        setStatus("Disconnected.");
        controlsEl.hidden = true;
        connectBtn.hidden = false;
        stopBotAudio();
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
        if (participant || track?.kind !== "audio" || state.botAudio) return;
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
        const last = lastRow();
        const inProgressUser = last?.classList.contains("user") && !last.dataset.final;
        const row = inProgressUser ? last : addTranscript("user", data.text);
        row.querySelector(".text").textContent = data.text;
        if (data.final) row.dataset.final = "1";
      },
      // botOutput streams each reply as the LLM generates it. A reply always
      // follows a user turn (or the greeting), so when the last row is NOT a
      // bot row, this is a new reply: start a fresh row. Otherwise grow the
      // current bot row in place — never overwrite an earlier reply.
      //
      // Message granularity is per-segment: with sentence-split TTS each
      // sentence can arrive as its own message whose text does not extend the
      // previous one. Merge both shapes: replace when the new text grows the
      // current text (startsWith), append when it's a new segment.
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
        el.textContent = !cur || data.text.startsWith(cur) ? data.text : cur + " " + data.text;
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
          custom_data: { instruction: state.role.file },
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

async function toggleMute() {
  if (!state.client) return;
  const muted = await state.client.enableMic(!muteBtn.dataset.muted);
  muteBtn.dataset.muted = muted ? "" : "1";
  muteBtn.textContent = muted ? "Mute" : "Unmute";
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

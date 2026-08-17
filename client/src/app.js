// Son — web client. Picks a role (instruction file), connects to the bot
// over WebRTC, and shows the live transcript.
//
// The page is served statically; the bot runs on :7860 (Pipecat runner).
// Endpoint can be overridden with ?endpoint=http://host:7860/start

import { PipecatClient, RTVIEvent } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";

const params = new URLSearchParams(location.search);
const BOT_ENDPOINT = params.get("endpoint") || "http://localhost:7860/start";

const state = {
  client: null,
  role: null,
  connected: false,
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
}

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
      },
      onBotReady: () => setStatus("Connected — you can talk."),
      onError: (err) => setStatus(`Error: ${err?.message ?? err}`),
    },
  });

  client.on(RTVIEvent.UserTranscript, (msg) => {
    const d = msg?.data ?? {};
    if (d.final === false) return; // only show finalized turns
    addTranscript("user", d.text);
  });
  client.on(RTVIEvent.BotTranscript, (msg) => {
    const d = msg?.data ?? {};
    if (d.final === false) return;
    addTranscript("bot", d.text);
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
    setStatus(`Connection failed: ${err?.message ?? err}`);
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

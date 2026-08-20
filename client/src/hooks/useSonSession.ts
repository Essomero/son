/**
 * All pipecat session state in one hook — a React port of the vanilla
 * client's app.js behavior, kept 1:1:
 *   - transcript merge rules (see lib/son.ts)
 *   - mute at the track level + best-effort enableMic signaling
 *   - typed messages ride RTVI send-text and are mirrored into the transcript
 *   - the bot's audio track is played through our own <audio> element (the
 *     small-webrtc transport never attaches a sink)
 *   - the local mic track arrives in onTrackStarted with a participant arg
 *     and must NOT go to the speakers
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { PipecatClient, type RTVIMessage } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";

import type { Choice, Msg, Models, Phase, Role, SessionMeta, Settings } from "../lib/types";
import {
  mergeBotText,
  mergeUserText,
  BOT_ENDPOINT,
  MODELS_URL,
  ROLES_URL,
  SESSIONS_URL,
  DEBUG,
  uid,
  errorMessage,
} from "../lib/son";
import { readSettings, saveSettings } from "../lib/settings";
import { loadCustomRoles, saveCustomRoles } from "../lib/customRoles";
import { pushHomeRoute, pushSessionRoute } from "../lib/chatRoute";

/** Fresh session id. uuid from crypto when available (localhost is a secure
 *  context); a timestamp fallback for non-secure contexts. The id is sent in
 *  /start custom_data so the server persists the transcript under it. */
function newId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* non-secure context — fall back */
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function loadRoles(): Promise<Role[]> {
  try {
    // no-store: python -m http.server sends no cache headers, so browsers
    // heuristically cache roles.json and a new role never shows up on a
    // plain reload.
    const res = await fetch(ROLES_URL, { cache: "no-store" });
    return await res.json();
  } catch {
    return [];
  }
}

async function loadModels(): Promise<Models | null> {
  try {
    const res = await fetch(MODELS_URL, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as Models;
  } catch {
    console.warn("[Son] /models unreachable — using fallback list");
    return null; // caller shows FALLBACK_MODELS and a retry affordance
  }
}

const SPEAKING_HINT_MS = 3000; // bot text is streaming but audio hasn't arrived yet

export function useSonSession() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [roles, setRoles] = useState<Role[]>([]);
  // Browser-local personas (lib/customRoles) — merged into the picker, their
  // content rides /start as instruction_content.
  const [customRoles, setCustomRoles] = useState<Role[]>(() => loadCustomRoles());
  const [role, setRole] = useState<Role | null>(null);
  const [models, setModels] = useState<Models | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => readSettings());
  const [messages, setMessages] = useState<Msg[]>([]);
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [status, setStatus] = useState("Pick a role to start talking.");
  const [micTrack, setMicTrack] = useState<MediaStreamTrack | null>(null);
  const [activeBotId, setActiveBotId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string>(() => newId());

  const clientRef = useRef<PipecatClient | null>(null);
  const botAudioRef = useRef<HTMLAudioElement | null>(null);
  const mutedRef = useRef(false);
  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  const messagesRef = useRef<Msg[]>([]);
  const speakingHintRef = useRef<number | null>(null);
  // sessionId read at connect() time; resumeSession sets it directly (a state
  // update wouldn't be visible to connect in the same tick).
  const sessionIdRef = useRef(sessionId);
  // Set on every connect: the bot's first utterance opens a fresh row even
  // when the transcript already ends with a bot row (greeting / resume
  // continuation / "Talk again"). Cleared by the first botOutput.
  const freshBotRowRef = useRef(false);

  useEffect(() => {
    void loadRoles().then(setRoles);
    void loadModels().then(setModels);
  }, []);

  // Keep refs in sync so event callbacks (which live outside React) see the
  // latest values without stale closures.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    micTrackRef.current = micTrack;
  }, [micTrack]);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Autoplay-policy insurance: if the audio element's first play() was
  // blocked (no user gesture yet), retry on the next click on the page.
  useEffect(() => {
    const retry = () => {
      const el = botAudioRef.current;
      if (el && el.paused && el.srcObject) void el.play().catch(() => {});
    };
    document.addEventListener("pointerdown", retry);
    return () => document.removeEventListener("pointerdown", retry);
  }, []);

  // Lightweight test hook: ?debug exposes internals for CDP verification.
  useEffect(() => {
    if (!DEBUG) return;
    (window as unknown as Record<string, unknown>).__son = {
      client: clientRef.current,
      connected: phase === "connected",
      role,
      settings,
      messages,
      muted,
      sessionId: sessionIdRef.current,
    };
  }, [phase, role, settings, messages, muted, sessionId]);

  const stopBotAudio = useCallback(() => {
    const el = botAudioRef.current;
    if (!el) return;
    el.pause();
    el.srcObject = null;
  }, []);

  const hintSpeaking = useCallback(() => {
    setSpeaking(true);
    if (speakingHintRef.current) window.clearTimeout(speakingHintRef.current);
    speakingHintRef.current = window.setTimeout(() => setSpeaking(false), SPEAKING_HINT_MS);
  }, []);

  // Audio-element events: play = audio is actually flowing, pause = the
  // sentence finished (the streamed-text hint above covers the gap before
  // audio arrives).
  const handleAudioPlay = useCallback(() => {
    setSpeaking(true);
    if (speakingHintRef.current) window.clearTimeout(speakingHintRef.current);
  }, []);
  const handleAudioPause = useCallback(() => {
    setSpeaking(false);
    // The ring on the last bot message only belongs there while the audio
    // for it is actually flowing.
    setActiveBotId(null);
  }, []);

  const selectRole = useCallback((r: Role) => {
    setRole(r);
    setPhase("ready");
    setStatus(`Ready to talk as “${r.name}”`);
  }, []);

  const addCustomRole = useCallback((r: Role) => {
    setCustomRoles((prev) => {
      const next = [...prev, r];
      saveCustomRoles(next);
      return next;
    });
  }, []);

  const removeCustomRole = useCallback((file: string) => {
    setCustomRoles((prev) => {
      const next = prev.filter((r) => r.file !== file);
      saveCustomRoles(next);
      return next;
    });
  }, []);

  /** opts overrides are for resumeSession: it picks the role (which may
   *  still be loading), the persisted session id, and must connect even if
   *  the current phase already looks connected/disconnected mid-switch. */
  const connect = useCallback(
    async (opts?: { role?: Role; sessionId?: string; force?: boolean }) => {
      const roleOverride = opts?.role ?? null;
      const r = roleOverride ?? role;
      if (!r) return;
      if (!opts?.force && (phase === "connected" || phase === "connecting")) return;
      if (opts?.sessionId) sessionIdRef.current = opts.sessionId;
      setSessionId(sessionIdRef.current);
      setPhase("connecting");
      setStatus("Connecting…");
      freshBotRowRef.current = true;

      const client = new PipecatClient({
        transport: new SmallWebRTCTransport(),
        enableMic: true,
        enableCam: false,
        callbacks: {
          onConnected: () => {
            setPhase("connected");
            setStatus("Connected — you can talk.");
          },
          onDisconnected: () => {
            setPhase("disconnected");
            setStatus("Disconnected.");
            stopBotAudio();
            setMicTrack(null); // fresh session = fresh mic state
            setMuted(false);
            mutedRef.current = false;
            setActiveBotId(null);
            setSpeaking(false);
          },
          onBotReady: () => setStatus("Connected — you can talk."),
          onError: (err: RTVIMessage) => {
            console.error("[Son] connect error", err);
            setStatus(`Error: ${errorMessage(err)}`);
          },
          onTrackStarted: (track: MediaStreamTrack, participant?: unknown) => {
            // The LOCAL mic track also arrives here (with a participant arg) —
            // keep it so Mute can disable it at the track level; it never
            // belongs in the speakers.
            if (participant) {
              if (track?.kind === "audio") setMicTrack(track);
              return;
            }
            if (track?.kind !== "audio" || botAudioRef.current?.srcObject) return;
            console.log("[Son] bot audio track received");
            const el = botAudioRef.current;
            if (!el) return;
            el.srcObject = new MediaStream([track]);
            void el.play().catch((e) => console.warn("[Son] audio play blocked:", e));
          },
          onTrackStopped: () => stopBotAudio(),
          onUserTranscript: (data: { text?: string; final?: boolean; timestamp?: string }) => {
            if (!data?.text) return;
            // timestamp lets mergeUserText swap the raw STT final for the
            // cleaned one when the cleanup stage resends it.
            const next = mergeUserText(messagesRef.current, data.text, !!data.final, data.timestamp);
            messagesRef.current = next;
            setMessages(next);
          },
          onBotOutput: (data: { text?: string }) => {
            if (!data?.text) return;
            const fresh = freshBotRowRef.current;
            freshBotRowRef.current = false;
            const next = mergeBotText(messagesRef.current, data.text, fresh);
            messagesRef.current = next;
            setMessages(next);
            const last = next[next.length - 1];
            if (last?.role === "bot") setActiveBotId(last.id);
            hintSpeaking();
          },
        },
      });

      clientRef.current = client;
      try {
        // Inline literals: client-js's Serializable requires an index
        // signature, which TS interfaces (Choice) don't satisfy. Absent picks
        // go as null (Serializable; the server treats them as unset).
        const toPlain = (c?: Choice) => (c ? { provider: c.provider, id: c.id } : null);
        await client.startBotAndConnect({
          endpoint: BOT_ENDPOINT,
          requestData: {
            transport: "webrtc",
            body: {
              custom_data: {
                instruction: r.file,
                // Custom personas send their markdown; built-in roles rely on
                // the server reading instructions/<file> (null = absent).
                instruction_content: r.content ?? null,
                session_id: sessionIdRef.current,
                llm: toPlain(settings.llm),
                stt: toPlain(settings.stt),
                tts: toPlain(settings.tts),
              },
            },
          },
        });
      } catch (err) {
        console.error("[Son] connect rejected", err);
        clientRef.current = null;
        setPhase("ready");
        setStatus(`Connection failed: ${errorMessage(err)}`);
      }
    },
    [role, phase, settings, stopBotAudio, hintSpeaking],
  );

  const toggleMute = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    const mute = !mutedRef.current; // what the user is asking for next
    mutedRef.current = mute;
    setMuted(mute);
    // Mute at the track level: a disabled track makes the encoder emit
    // silence, so the server's VAD/STT hears nothing while the connection
    // stays up. Mirror it to client-js's enableMic for the server-side
    // trackStatus signalling — best effort; some transports return nothing
    // or throw, and that must never wedge the button.
    if (micTrackRef.current) micTrackRef.current.enabled = !mute;
    try {
      await client.enableMic(!mute);
    } catch (e) {
      console.warn("[Son] transport enableMic failed (track-level mute still active):", e);
    }
  }, []);

  const sendText = useCallback((text: string) => {
    const client = clientRef.current;
    if (!client || !text.trim()) return;
    // Typed messages ride the RTVI send-text message: the server appends the
    // text as a user turn and (with run_immediately) answers it right away.
    // The text has no outbound transcription event, so we mirror it into the
    // transcript ourselves — through the same row-merging path as STT.
    client.sendText(text, { run_immediately: true }).catch((e) => {
      console.warn("[Son] sendText failed:", e);
    });
    const next = mergeUserText(messagesRef.current, text, true);
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const disconnect = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    setStatus("Disconnecting…");
    await client.disconnect();
    clientRef.current = null;
  }, []);

  /** End the current conversation (if any) and start a fresh session id. The
   *  finished session's row is already in sqlite — written live by the
   *  server's write-through context — so it stays in the panel. */
  const newSession = useCallback(async () => {
    const client = clientRef.current;
    if (client) {
      await client.disconnect().catch(() => {});
      clientRef.current = null;
    }
    sessionIdRef.current = newId();
    setSessionId(sessionIdRef.current);
    setMessages([]);
    messagesRef.current = [];
    setActiveBotId(null);
    setSpeaking(false);
    setMuted(false);
    mutedRef.current = false;
    setMicTrack(null);
    stopBotAudio();
    setPhase("ready");
    setStatus(role ? `Ready to talk as “${role.name}”` : "Pick a role to start talking.");
    pushHomeRoute(); // a fresh chat isn't any session — the URL goes back home
  }, [role, stopBotAudio]);

  /** Resume a past session from the panel: restore its transcript, switch to
   *  its role, and connect — the server seeds the brain with the stored
   *  messages, so the conversation continues where it left off. */
  const resumeSession = useCallback(
    async (meta: SessionMeta) => {
      if (meta.id === sessionIdRef.current && phase === "connected") return; // already live
      // The role may still be loading when the panel is clicked from home.
      // Custom personas live in the browser, not roles.json — check those too.
      let r = roles.find((x) => x.file === meta.role_file) ?? customRoles.find((x) => x.file === meta.role_file) ?? null;
      if (!r) {
        const loaded = await loadRoles();
        setRoles(loaded);
        r = loaded.find((x) => x.file === meta.role_file) ?? null;
      }
      // End any live call before switching — the write-through context has
      // already persisted everything finalized.
      const client = clientRef.current;
      if (client) {
        await client.disconnect().catch(() => {});
        clientRef.current = null;
      }
      if (!r) {
        setStatus(`Role “${meta.role_file}” not found — pick a role to resume.`);
        return;
      }
      let stored: Msg[] = [];
      try {
        const res = await fetch(`${SESSIONS_URL}/${meta.id}`);
        if (res.ok) {
          const data = (await res.json()) as { messages: { role: string; text: string }[] };
          stored = (data.messages ?? []).map((m) => ({
            id: uid(),
            role: m.role === "assistant" ? "bot" : "user",
            text: m.text,
            final: true,
            base: m.role === "user" ? m.text : "",
          }));
        }
      } catch (e) {
        console.warn("[Son] failed to load stored messages:", e);
      }
        setRole(r);
      setMessages(stored);
      messagesRef.current = stored;
      pushSessionRoute(meta.id); // the URL now names this chat — reload reopens it
      await connect({ role: r, sessionId: meta.id, force: true });
    },
    [roles, customRoles, connect],
  );

  const updateSettings = useCallback((next: Settings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  /** Re-fetch the /models roster on demand — the modal's reload button, so a
   *  bot that was down (or slow) at page load doesn't need a page refresh. */
  const refreshModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      setModels(await loadModels());
    } finally {
      setModelsLoading(false);
    }
  }, []);

  return {
    phase,
    roles,
    customRoles,
    addCustomRole,
    removeCustomRole,
    role,
    models,
    modelsLoading,
    settings,
    messages,
    muted,
    speaking,
    status,
    activeBotId,
    micTrack,
    botAudioRef,
    handleAudioPlay,
    handleAudioPause,
    selectRole,
    connect,
    disconnect,
    newSession,
    resumeSession,
    sessionId,
    toggleMute,
    sendText,
    updateSettings,
    refreshModels,
  };
}

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

import type { Choice, Msg, Models, Phase, Role, Settings } from "../lib/types";
import { mergeBotText, mergeUserText, BOT_ENDPOINT, MODELS_URL, DEBUG, errorMessage } from "../lib/son";
import { FALLBACK_MODELS, readSettings, saveSettings } from "../lib/settings";

async function loadRoles(): Promise<Role[]> {
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

async function loadModels(): Promise<Models> {
  try {
    const res = await fetch(MODELS_URL, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as Models;
  } catch {
    console.warn("[Son] /models unreachable — using fallback list");
    return FALLBACK_MODELS;
  }
}

const SPEAKING_HINT_MS = 3000; // bot text is streaming but audio hasn't arrived yet

export function useSonSession() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [roles, setRoles] = useState<Role[]>([]);
  const [role, setRole] = useState<Role | null>(null);
  const [models, setModels] = useState<Models | null>(null);
  const [settings, setSettings] = useState<Settings>(() => readSettings());
  const [messages, setMessages] = useState<Msg[]>([]);
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [status, setStatus] = useState("Pick a role to start talking.");
  const [micTrack, setMicTrack] = useState<MediaStreamTrack | null>(null);
  const [activeBotId, setActiveBotId] = useState<string | null>(null);

  const clientRef = useRef<PipecatClient | null>(null);
  const botAudioRef = useRef<HTMLAudioElement | null>(null);
  const mutedRef = useRef(false);
  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  const messagesRef = useRef<Msg[]>([]);
  const speakingHintRef = useRef<number | null>(null);

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
    };
  }, [phase, role, settings, messages, muted]);

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

  const connect = useCallback(async () => {
    if (!role || phase === "connected" || phase === "connecting") return;
    setPhase("connecting");
    setStatus("Connecting…");

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
        onUserTranscript: (data: { text?: string; final?: boolean }) => {
          if (!data?.text) return;
          const next = mergeUserText(messagesRef.current, data.text, !!data.final);
          messagesRef.current = next;
          setMessages(next);
        },
        onBotOutput: (data: { text?: string }) => {
          if (!data?.text) return;
          const next = mergeBotText(messagesRef.current, data.text);
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
              instruction: role.file,
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
  }, [role, phase, settings, stopBotAudio, hintSpeaking]);

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

  const updateSettings = useCallback((next: Settings) => {
    setSettings(next);
    saveSettings(next);
  }, []);

  return {
    phase,
    roles,
    role,
    models,
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
    toggleMute,
    sendText,
    updateSettings,
  };
}

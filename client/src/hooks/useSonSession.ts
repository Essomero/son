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
  cleanTranscript,
  BOT_ENDPOINT,
  MODELS_URL,
  ROLES_URL,
  SESSIONS_URL,
  DEBUG,
  uid,
  errorMessage,
} from "../lib/son";
import { readSettings, saveSettings } from "../lib/settings";
import { useBrowserSpeech } from "./useBrowserSpeech";
import { useWebSpeech } from "./useWebSpeech";
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

async function loadModels(): Promise<{ models: Models | null; cleanup: boolean }> {
  try {
    const res = await fetch(MODELS_URL, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Models & { cleanup?: boolean };
    // cleanup: the server's transcript-cleanup stage is on (STT_CLEANUP_MODEL
    // set) — the client hides raw web-speech text behind a loading bubble.
    return { models: data, cleanup: Boolean(data.cleanup) };
  } catch {
    console.warn("[Son] /models unreachable — using fallback list");
    return { models: null, cleanup: false }; // caller shows FALLBACK_MODELS and a retry affordance
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
  // The server's transcript-cleanup stage is on: web-speech finals show a
  // loading bubble instead of raw text until the cleaned version lands.
  const [cleanupOn, setCleanupOn] = useState(false);
  const [settings, setSettings] = useState<Settings>(() => readSettings());
  const [messages, setMessages] = useState<Msg[]>([]);
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [status, setStatus] = useState("Pick a role to start talking.");
  const [micTrack, setMicTrack] = useState<MediaStreamTrack | null>(null);
  const [activeBotId, setActiveBotId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string>(() => newId());

  const clientRef = useRef<PipecatClient | null>(null);
  // Connection-generation counter: every connect/disconnect/newSession/
  // resumeSession bumps it, and a connect that finds itself stale (a newer
  // flow started while it was initializing) aborts before reaching the
  // server instead of opening a second, unowned pipeline for the same chat.
  // (clientRef, the synchronous owner slot, is what the callbacks gate on;
  // the generation only covers the window before a client can be replaced.)
  // Needed because a client that is still in initDevices has no peer
  // connection, so the transport's stop() is a no-op — calling disconnect()
  // on it does NOT cancel it.
  const connectGenRef = useRef(0);
  const botAudioRef = useRef<HTMLAudioElement | null>(null);
  const mutedRef = useRef(false);
  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  /** Web-speech mode: a mic stream held ONLY for the waveform — never sent
   *  to the transport (enableMic is off). Stopped on disconnect. */
  const wsMicStreamRef = useRef<MediaStream | null>(null);
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
    void loadModels().then((m) => {
      setModels(m.models);
      setCleanupOn(m.cleanup);
    });
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
      const gen = ++connectGenRef.current; // this connect owns the lifecycle now
      if (opts?.sessionId) sessionIdRef.current = opts.sessionId;
      setSessionId(sessionIdRef.current);
      setPhase("connecting");
      setStatus("Connecting…");
      freshBotRowRef.current = true;

      const webSpeech = settings.stt?.provider === "web-speech";
      const client = new PipecatClient({
        transport: new SmallWebRTCTransport(),
        // Browser-side STT: no mic track at all — the server VAD/STT must
        // never hear this audio (text arrives via send-text instead).
        enableMic: !webSpeech,
        enableCam: false,
        callbacks: {
          onConnected: () => {
            if (clientRef.current !== client) return; // superseded — never claim the phase
            setPhase("connected");
            setStatus("Connected — you can talk.");
            if (webSpeech) {
              // No transport mic track in this mode — grab a stream purely
              // for the waveform (never sent anywhere).
              void navigator.mediaDevices
                .getUserMedia({ audio: true })
                .then((stream) => {
                  wsMicStreamRef.current = stream;
                  const t = stream.getAudioTracks()[0];
                  if (t) setMicTrack(t);
                })
                .catch((e) => console.warn("[Son] waveform mic unavailable:", e));
            }
          },
          onDisconnected: () => {
            // A superseded client's teardown isn't ours to run (its close
            // events can arrive while a newer client owns the lifecycle).
            if (clientRef.current !== client) return;
            setPhase("disconnected");
            setStatus("Disconnected.");
            browserSpeech.cancel();
            flushPending();
            wsMicStreamRef.current?.getTracks().forEach((t) => t.stop());
            wsMicStreamRef.current = null;
            stopBotAudio();
            setMicTrack(null); // fresh session = fresh mic state
            setMuted(false);
            mutedRef.current = false;
            setActiveBotId(null);
            setSpeaking(false);
          },
          onBotReady: () => {
            if (clientRef.current !== client) return;
            setStatus("Connected — you can talk.");
          },
          onError: (err: RTVIMessage) => {
            if (clientRef.current !== client) return; // a newer flow owns the status now
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
            // Browser TTS speaks the text itself — never play the (silent)
            // server audio track.
            if (browserTTS) return;
            if (track?.kind !== "audio" || botAudioRef.current?.srcObject) return;
            console.log("[Son] bot audio track received");
            const el = botAudioRef.current;
            if (!el) return;
            el.srcObject = new MediaStream([track]);
            void el.play().catch((e) => console.warn("[Son] audio play blocked:", e));
          },
          onTrackStopped: () => stopBotAudio(),
          onUserTranscript: (data: { text?: string; final?: boolean; timestamp?: string }) => {
            if (clientRef.current !== client) return; // superseded — its events aren't ours
            if (!data?.text) return;
            // timestamp lets mergeUserText swap the raw STT final for the
            // cleaned one when the cleanup stage resends it.
            const next = mergeUserText(messagesRef.current, data.text, !!data.final, data.timestamp);
            messagesRef.current = next;
            setMessages(next);
          },
          onBotOutput: (data: { text?: string }) => {
            if (clientRef.current !== client) return; // superseded — its events aren't ours
            if (!data?.text) return;
            const fresh = freshBotRowRef.current;
            freshBotRowRef.current = false;
            if (browserTTS) {
              // Speak only what's new: events are cumulative per row, but
              // duplicates and appended segments also occur.
              if (fresh) botSpokenRef.current = "";
              const prev = botSpokenRef.current;
              const t = data.text;
              let delta: string;
              let nextSpoken: string;
              if (!prev) {
                delta = t;
                nextSpoken = t;
              } else if (t.startsWith(prev)) {
                delta = t.slice(prev.length); // cumulative growth
                nextSpoken = t;
              } else if (prev.startsWith(t) || prev.endsWith(t)) {
                delta = ""; // duplicate segment
                nextSpoken = prev;
              } else {
                delta = t; // genuinely new segment
                nextSpoken = t;
              }
              botSpokenRef.current = nextSpoken;
              if (delta.trim()) browserSpeech.speak(delta);
            }
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
        const toPlain = (c?: Choice) =>
          c ? { provider: c.provider, id: c.id, ...(c.voice ? { voice: c.voice } : {}) } : null;
        // client-js's needsInit() returns false when enableMic AND enableCam
        // are false, so device init gets skipped and the audio output context
        // is created lazily AFTER the /start round-trip — outside Chrome's
        // autoplay gesture window — where resume() never resolves and the
        // session hangs in "connecting" forever. Init explicitly here, inside
        // the click gesture.
        if (webSpeech) await client.initDevices();
        if (gen !== connectGenRef.current) {
          // A newer connect/disconnect/resume took over while we were
          // initializing. A client this early has no peer connection, so
          // disconnect() alone would be a no-op — bail before /start, or this
          // orphaned connect opens a second pipeline for the same chat.
          await client.disconnect().catch(() => {});
          if (clientRef.current === client) clientRef.current = null;
          return;
        }
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
        if (gen !== connectGenRef.current) {
          // Superseded while the connection was being established: the peer
          // connection now exists, so disconnect() tears it down for real.
          await client.disconnect().catch(() => {});
          if (clientRef.current === client) clientRef.current = null;
        }
      } catch (err) {
        if (gen !== connectGenRef.current) {
          await client.disconnect().catch(() => {});
          if (clientRef.current === client) clientRef.current = null;
          return;
        }
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

  const sendText = useCallback((text: string, commit = true) => {
    const client = clientRef.current;
    if (!client || !text.trim()) return;
    // Typed messages ride the RTVI send-text message: the server appends the
    // text as a user turn and (with run_immediately) answers it right away.
    // The text has no outbound transcription event, so we mirror it into the
    // transcript ourselves — through the same row-merging path as STT.
    client.sendText(text, { run_immediately: true }).catch((e) => {
      console.warn("[Son] sendText failed:", e);
    });
    // flushPending already committed its row (possibly cleaned); a second
    // merge would duplicate the text or swallow a newer row.
    if (!commit) return;
    const next = mergeUserText(messagesRef.current, text, true);
    messagesRef.current = next;
    setMessages(next);
  }, []);

  // Browser-side STT (Chrome's Web Speech API): finals ride send-text into
  // the LLM (sendText mirrors them into the transcript); interims preview
  // live through the same merge path as STT partials. Runs only while
  // connected in web-speech mode; the mic track is off, so nothing else
  // hears the audio.
  // Browser-native TTS (Chrome speechSynthesis): the bot's streamed text is
  // spoken by the browser — no server audio. Delta-tracked so each event
  // speaks only what's new.
  const browserTTS = settings.tts?.provider === "browser";
  const browserSpeech = useBrowserSpeech(browserTTS, settings.tts?.id);
  const botSpokenRef = useRef("");
  // The transcript ring follows the browser's speech queue in this mode.
  useEffect(() => {
    if (browserTTS) setSpeaking(browserSpeech.speaking);
  }, [browserTTS, browserSpeech.speaking]);

  const webSpeech = settings.stt?.provider === "web-speech";
  const [micPulse, setMicPulse] = useState(false);
  // Recognized-but-unsent text. The Web Speech API finalizes on ANY pause
  // (people pause mid-thought), so finals accumulate and only send after a
  // silence window — a pause isn't end-of-turn until the silence holds.
  // The join only continues a row whose *last* row is still the open speech
  // row (see onSpeechResult): when the bot answered, the pending text gets
  // sent on its own and a new utterance starts fresh.
  const pendingUserRef = useRef("");
  const sendTimerRef = useRef<number | null>(null);
  const PAUSE_SEND_MS = 900;

  // A flush's cleanup round-trip can outlive the 900 ms silence window, and
  // bot rows stream in while it is in flight (a barge-in's response). The
  // messages array is the source of truth: the oldest row still waiting for
  // cleanup gets flushed, one at a time, wherever it sits — a step-aside
  // (or a cancelled timer) can never strand a row permanently, because
  // whichever timer lives after a flush re-arms while any row is pending.
  // Concurrent flushes would both send — keep one at a time.
  const flushingRef = useRef(false);
  const flushPending = useCallback(async () => {
    if (sendTimerRef.current !== null) {
      window.clearTimeout(sendTimerRef.current);
      sendTimerRef.current = null;
    }
    if (flushingRef.current) {
      // Another flush is mid-cleanup: re-arm so the rows' latest finals still
      // get their finalize once that cleanup finishes, instead of leaving a
      // pending row with no timer left to land it.
      sendTimerRef.current = window.setTimeout(flushPending, PAUSE_SEND_MS);
      return;
    }
    // Oldest pending row first: an earlier utterance's row must not starve
    // behind newer ones, and its silence window opened sooner anyway.
    const msgs = messagesRef.current;
    const idxUser = msgs.findIndex((m) => m.role === "user" && !m.final);
    if (idxUser < 0) return;
    flushingRef.current = true;
    try {
      const row = msgs[idxUser];
      // The row's OWN text is the truth (it holds every final joined so far);
      // cleaning a snapshot instead would send half an utterance and the
      // finalize would replace the joined row with a fragment.
      const text = row.text;
      // Web-speech finals bypass the server's cleanup pipeline (they arrive via
      // send-text, stt=None server-side), so give the segment the same
      // punctuation/formatting pass before the brain sees it. Any failure
      // returns "" — send the raw text; a turn must never stall on cleanup.
      const cleaned = (await cleanTranscript(text)) || text;
      const now = messagesRef.current;
      const idx = now.findIndex((m) => m === row);
      // The row was replaced while we were cleaning (a final joined it into a
      // NEW object), or it grew (a final landed on it) — either way that
      // final re-armed the timer, so the next flush cleans and sends the whole
      // utterance in one go. Nothing is sent twice here either.
      if (idx < 0 || row.text !== text) return;
      // Position-independent finalize: bot rows may sit after the user row
      // (barge-in), so "in place" must mean where the row IS, not last.
      const finalized: Msg = {
        ...row,
        text: cleaned,
        final: true,
        base: cleaned,
        spans: [{ ts: undefined, text: cleaned }],
        pending: false, // a finalized row never shows the loading bubble
      };
      const next = [...now.slice(0, idx), finalized, ...now.slice(idx + 1)];
      messagesRef.current = next;
      setMessages(next);
      // Clear ONLY if this row still owns the join — a newer utterance may
      // already be accumulating its own pending text.
      if (pendingUserRef.current === text) pendingUserRef.current = "";
      sendText(cleaned, false);
    } finally {
      flushingRef.current = false;
      // Keep the chain alive: a newer final's timer may be pending, or this
      // flush was the last one standing. Either way, exactly one timer
      // exists while anything is still pending.
      if (
        sendTimerRef.current === null &&
        messagesRef.current.some((m) => m.role === "user" && !m.final)
      ) {
        sendTimerRef.current = window.setTimeout(flushPending, PAUSE_SEND_MS);
      }
    }
  }, [sendText]);

  const onSpeechResult = useCallback(
    (text: string, final: boolean) => {
      if (!final) {
        // Interims morph as the engine refines them — never show them; only
        // stable finals land in the transcript (the Groq-style UX). The
        // event is still the "user started talking" signal (barge-in).
        browserSpeech.cancel();
        return;
      }
      const msgs = messagesRef.current;
      const last = msgs[msgs.length - 1];
      // A new utterance starts whenever the last row isn't the still-open
      // speech row (the bot answered, or an earlier utterance was already
      // flushed) — the join must not carry the previous utterance's text
      // into it.
      const continuing = last?.role === "user" && !last.final;
      const p = continuing ? pendingUserRef.current : "";
      const joined =
        p && !p.endsWith(" ") && !text.startsWith(" ") ? `${p} ${text}` : `${p}${text}`;
      pendingUserRef.current = joined;
      const merged =
        last?.role === "user" && last.final
          ? [...msgs, { id: uid(), role: "user" as const, text: joined, final: false, base: "", spans: [] }]
          : mergeUserText(msgs, joined, false);
      // Cleanup on: the raw final is never shown — the row waits behind a
      // loading bubble until flushPending lands the cleaned text.
      const next =
        cleanupOn && merged[merged.length - 1]?.role === "user"
          ? [...merged.slice(0, -1), { ...merged[merged.length - 1], pending: true }]
          : merged;
      messagesRef.current = next;
      setMessages(next);
      if (sendTimerRef.current !== null) window.clearTimeout(sendTimerRef.current);
      sendTimerRef.current = window.setTimeout(flushPending, PAUSE_SEND_MS);
    },
    [flushPending, browserSpeech.cancel, cleanupOn],
  );
  // No mic track exists in web-speech mode — the waveform ring is driven
  // by the recognition's sound events instead (until the waveform stream
  // above lands, and as a fallback if it fails).
  useWebSpeech(onSpeechResult, webSpeech && phase === "connected", setMicPulse);

  const disconnect = useCallback(async () => {
    connectGenRef.current += 1; // an in-flight connect is now stale
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
    connectGenRef.current += 1; // an in-flight connect must not outlive the chat switch
    const client = clientRef.current;
    if (client) {
      await client.disconnect().catch(() => {});
      clientRef.current = null;
    }
    sessionIdRef.current = newId();
    setSessionId(sessionIdRef.current);
    setMessages([]);
    messagesRef.current = [];
    pendingUserRef.current = ""; // a pending utterance must not outlive the chat
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
      connectGenRef.current += 1; // an in-flight connect must not outlive the resume
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
      pendingUserRef.current = ""; // a pending utterance must not outlive the resume
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
      const m = await loadModels();
      setModels(m.models);
      setCleanupOn(m.cleanup);
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
    micPulse,
  };
}

import { PipecatClient, type RTVIMessage } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { SonApi } from "../lib/api";
import { MicMediaManager } from "../lib/mediaManager";
import { mergeBotText, mergeUserText, newSessionId, uid } from "../lib/merge";
import { startWebSpeech, webSpeechSupported } from "../lib/webSpeech";
import { DEFAULT_SETTINGS, loadDetached, loadSessionId, loadSettings, saveDetached, saveSessionId, saveSettings, takeAskSelectionIntent } from "../lib/storage";
import type {
  Choices,
  Choice,
  ContextSource,
  ContextState,
  Models,
  Msg,
  PageCapture,
  Phase,
  Role,
  Settings,
} from "../lib/types";

/** Wire budget for the selection part of a page-context push (the server caps
 *  the block again). */
const SELECTION_CAP = 3000;
/** Floor between two automatic pushes while the user talks — a burst of STT
 *  partials is one turn, not five. */
const PUSH_MIN_INTERVAL_MS = 1200;

/** Parakeet's model id, for the fallback when Web Speech fails before the
 *  roster has loaded. The server can only build Parakeet from its own roster,
 *  so the fallback must name a real model. */
const PARAKEET_MODEL = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";

/** Silence before accumulated browser-speech finals are sent. The API finalizes
 *  on ANY pause and people pause mid-thought, so a pause isn't end-of-turn until
 *  it holds. Same window as the web client. */
const PAUSE_SEND_MS = 900;

/** What a Web Speech failure means in terms a user can act on — the raw codes
 *  are the API's own `error` values (see lib/webSpeech.ts). Web Speech *is*
 *  available in an extension page (the side panel is a secure context and the
 *  mic comes from getUserMedia, no special permission needed), so a failure
 *  here is environment, not policy: a denied mic, a missing device, or
 *  Chrome's speech service being unreachable. */
const SPEECH_FAILURE_HINT: Record<string, string> = {
  "not-allowed": "microphone access is blocked — allow the mic for this extension in chrome://extensions",
  "service-not-allowed": "microphone access is blocked — allow the mic for this extension in chrome://extensions",
  "audio-capture": "no microphone is available",
  network: "Chrome's speech service is unreachable (blocker, VPN, or offline)",
  unavailable: "this browser has no recognizer — Chrome or Edge only",
  "start-failed": "the recognizer would not start",
  "language-not-supported": "en-US isn't offered by this recognizer",
};

interface CaptureReply extends Partial<PageCapture> {
  error?: string;
  tabId?: number | null;
}

/** The bot's audio track is attached by hand (the small-webrtc transport never
 *  attaches a sink) and play() can be refused before the first gesture in the
 *  panel. Retrying matters more than it looks: a blocked first play() would
 *  leave the mic hearing the bot's own voice as a "user" turn. */
function startPlayback(el: HTMLAudioElement): void {
  const attempt = () => {
    if (!el.srcObject) return; // track stopped — done
    if (!el.paused) return; // already playing — done
    el.play().catch(() => window.setTimeout(attempt, 200));
  };
  attempt();
}

function stopPlayback(el: HTMLAudioElement | null): void {
  if (!el) return;
  el.pause();
  el.srcObject = null;
}

function errorMessage(err: unknown): string {
  const data = (err as { data?: { error?: string } } | undefined)?.data;
  if (data?.error) return data.error;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** One pick, in the shape the server reads (its stt/tts `model` comes from the
 *  roster's `id`). */
function plainChoice(choice?: Choice | null): Choice | null {
  return choice
    ? { provider: choice.provider, id: choice.id, ...(choice.voice ? { voice: choice.voice } : {}) }
    : null;
}

/** The custom_data picks: an unchosen capability goes as null so run_bot keeps
 *  its own default. STT is never null in practice — the panel is the half that
 *  runs browser recognition, so it always states what it is doing. */
function plainChoices(choices: Choices): Record<string, Choice | null> {
  return { llm: plainChoice(choices.llm), stt: plainChoice(choices.stt), tts: plainChoice(choices.tts) };
}

/** What goes on the wire as "selection": the selected words, plus the block
 *  they sit in when there is one — a two-word selection ("AND binds tighter")
 *  is only answerable with its paragraph. */
function wireSelection(capture: PageCapture): string {
  const context = capture.selectionContext;
  if (!capture.selection) return "";
  const body =
    context && context.length > capture.selection.length + 40
      ? `${capture.selection}\n\n[surrounding text — ${capture.selectionSource}]\n${context}`
      : capture.selection;
  return body.length > SELECTION_CAP ? body.slice(0, SELECTION_CAP).trimEnd() + " …[truncated]" : body;
}

function describeChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** The two sources, in the order the chips show them. */
const CONTEXT_SOURCES: ContextSource[] = ["page", "selection"];

const NO_ATTACH: Record<ContextSource, boolean> = { page: false, selection: false };

/** Cheap change detector for a captured part. Pushes are deltas — "has this text
 *  changed since the panel last told the server about it" is the whole question
 *  this answers, and folding the length in means a collision needs two changes. */
function fingerprint(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return `${text.length}:${hash}`;
}

const EMPTY_CONTEXT: ContextState = {
  tone: "idle",
  note: "Not read yet",
  url: "",
  title: "",
  selection: "",
  page: "",
  selectionChars: 0,
  pageChars: 0,
  pageSource: "",
  attached: { ...NO_ATTACH },
  detached: { ...NO_ATTACH },
  pageTruncated: false,
  takenAt: 0,
};

export function useSon(audioRef: RefObject<HTMLAudioElement | null>) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [models, setModels] = useState<Models | null>(null);
  const [modelsError, setModelsError] = useState(false);
  /** True while a roster fetch is in flight — /models probes every provider on a
   *  cold cache, so "loading" is a real, sometimes long, state worth showing. */
  const [modelsLoading, setModelsLoading] = useState(false);
  /** The server's local-model warmup state: label → "downloading" | "ready" |
   *  "failed: …". A first-use download is why a fresh session can connect and
   *  stay silent, so the panel says so instead of looking broken. */
  const [warming, setWarming] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("Open a page and press Start.");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [muted, setMuted] = useState(false);
  const [botSpeaking, setBotSpeaking] = useState(false);
  const [reading, setReading] = useState(false);
  const [context, setContext] = useState<ContextState>(EMPTY_CONTEXT);
  const [sessionId, setSessionId] = useState("");

  const clientRef = useRef<PipecatClient | null>(null);
  const messagesRef = useRef<Msg[]>([]);
  const freshBotRowRef = useRef(false);
  const sessionIdRef = useRef("");
  const settingsRef = useRef<Settings | null>(null);
  const mutedRef = useRef(false);
  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  /** Latest capture as it would go on the wire — what a push sends. */
  const payloadRef = useRef<{ url: string; title: string; selection: string; page: string } | null>(null);
  const lastPushRef = useRef(0);
  const connectingRef = useRef(false);
  const readAudioRef = useRef<HTMLAudioElement | null>(null);
  const modelsRef = useRef<Models | null>(null);
  /** What the server has been told for each source — the delta baseline. An
   *  empty string means "nothing attached", which is also how the chips know
   *  not to claim the text is in the conversation. */
  const sentKeysRef = useRef<Record<ContextSource, string>>({ page: "", selection: "" });
  /** Sources the user switched off with a chip: not sent, not in the
   *  conversation. Kept for the session so a reopened panel respects it. */
  const detachedRef = useRef<Record<ContextSource, boolean>>({ page: false, selection: false });
  /** Which element the page capture picked (for the chip note). */
  const pageSourceRef = useRef("");
  /** Right-click "Ask Son about the selection" arrived while not connected. */
  const pendingAskRef = useRef(false);
  /** Session-scoped STT override: set when browser Web Speech fails, so the
   *  reconnect asks for Parakeet instead. Deliberately not persisted — a new
   *  chat tries Web Speech again, because a granted permission or a fixed
   *  network shouldn't need a settings trip. */
  const sttFallbackRef = useRef<Choice | null>(null);
  const [sttFallback, setSttFallback] = useState<Choice | null>(null);
  /** One line of honest UI when the fallback fired: which STT is really
   *  listening is not something to leave to the model picker. */
  const [sttNote, setSttNote] = useState("");
  /** Recognized-but-unsent text and its silence timer (see PAUSE_SEND_MS). */
  const pendingUserRef = useRef("");
  const sendTimerRef = useRef<number | null>(null);
  const flushingRef = useRef(false);

  const api = useCallback((): SonApi => {
    const current = settingsRef.current;
    return new SonApi(current?.serverUrl ?? DEFAULT_SETTINGS.serverUrl, current?.serverToken ?? "");
  }, []);

  /** The STT pick this session must ask for: the fallback override when browser
   *  Web Speech failed, else the panel's saved pick, else the same Web Speech
   *  default the server has (a settings object saved before it existed). Always
   *  concrete on purpose — a session whose STT is web-speech and whose client
   *  recognizes nothing hears nothing at all. */
  const sttPick = useCallback((): Choice => {
    return sttFallbackRef.current ?? settingsRef.current?.choices.stt ?? { provider: "web-speech", id: "browser" };
  }, []);

  /** True when this session's STT is the browser's: the panel recognizes and the
   *  session carries no audio. State-derived rather than a ref, because the
   *  recognizer's lifetime follows it. */
  const webSpeechMode = (sttFallback?.provider ?? settings?.choices.stt?.provider ?? "web-speech") === "web-speech";

  /** What "listening" means for the current STT. The provider belongs in the
   *  status line: which half is doing the recognizing is invisible otherwise. */
  const listeningStatus = useCallback((): string => {
    return sttPick().provider === "web-speech" ? "Listening (Web Speech)…" : "Listening…";
  }, [sttPick]);

  /** Roster state and its ref move together: the retry timers below run
   *  outside React and must not refetch a roster the panel already has. */
  const applyRoster = useCallback((roster: Models | null): void => {
    modelsRef.current = roster;
    setModels(roster);
    setModelsError(roster === null);
  }, []);

  /** Is the bot answering? null until the first probe. Tracked separately from
   *  the session: a panel that has never connected, or whose session just ended,
   *  must not claim the server is down — that conflation is exactly what made a
   *  running bot look offline. */
  const [serverReachable, setServerReachable] = useState<boolean | null>(null);

  /** The server's warmup state is polled separately from the roster: /warming is
   *  instant, /models can take minutes on a cold cache — and a first-use download
   *  is exactly when the panel should be able to say something. One call answers
   *  both "is it there" and "is it fetching". */
  const refreshWarming = useCallback(async (): Promise<void> => {
    const reply = await api().warming();
    setWarming(reply.warming);
    setServerReachable(reply.ok);
  }, [api]);

  // --- page context ---------------------------------------------------------

  /** Chip state from the last good capture plus what the server has been told.
   *  A chip must not claim "in context" for text that was never sent, and must
   *  not hide a source the user switched off. */
  const applyContextState = useCallback((): void => {
    const payload = payloadRef.current;
    const detached = detachedRef.current;
    if (!payload) {
      setContext((previous) => ({
        ...previous,
        attached: { ...NO_ATTACH },
        detached: { ...detached },
        takenAt: Date.now(),
      }));
      return;
    }
    const sent = sentKeysRef.current;
    setContext({
      tone: payload.selection || payload.page ? "live" : "empty",
      note: `${pageSourceRef.current || "page"} · ${describeChars(payload.page.length)} chars`,
      url: payload.url,
      title: payload.title,
      selection: payload.selection,
      page: payload.page,
      selectionChars: payload.selection.length,
      pageChars: payload.page.length,
      pageSource: pageSourceRef.current,
      attached: {
        page: !detached.page && sent.page !== "" && sent.page === fingerprint(payload.page),
        selection:
          !detached.selection && sent.selection !== "" && sent.selection === fingerprint(payload.selection),
      },
      detached: { ...detached },
      pageTruncated: payload.page.includes("…[truncated]"),
      takenAt: Date.now(),
    });
  }, []);

  /** Re-read the active tab. The chips and the push payload come from the same
   *  capture, so what they show is what the brain gets. */
  const refreshContext = useCallback(async (): Promise<void> => {
    const current = settingsRef.current;
    let reply: CaptureReply | undefined;
    try {
      reply = (await chrome.runtime.sendMessage({
        type: "son:capture",
        budgets: { selection: SELECTION_CAP, page: current?.pageChars ?? DEFAULT_SETTINGS.pageChars },
      })) as CaptureReply | undefined;
    } catch (err) {
      reply = { error: `The extension worker didn't answer: ${errorMessage(err)}` };
    }
    if (!reply || reply.error || !reply.url) {
      // A page that can't be read (chrome://, the PDF viewer, a tab that
      // navigated away, the panel itself when nothing else is open) must not
      // wipe what the conversation is already carrying: keep the last good
      // capture as the payload, keep the chips describing it, and say why the
      // current tab can't be read.
      const reason = reply?.error ?? "Nothing to read on this page.";
      setContext((previous) => ({
        ...previous,
        tone: "blocked",
        note: payloadRef.current ? `${reason} Still using the last page I could read.` : reason,
        takenAt: Date.now(),
      }));
      return;
    }
    pageSourceRef.current = reply.pageSource ?? "";
    payloadRef.current = {
      url: reply.url,
      title: reply.title ?? "",
      selection: wireSelection(reply as PageCapture),
      page: reply.page ?? "",
    };
    applyContextState();
  }, [applyContextState]);

  /** Send the panel's deltas.
   *
   *  A source is sent only when its text changed since the server was last told
   *  (or when the user asks for a re-anchor), and a source the user switched off
   *  — or one with nothing to attach any more, like a cleared selection — is
   *  removed instead. Nothing changed means no request at all, which is the
   *  point of the whole design: an unchanged page costs nothing per turn.
   *  A detached source stays detached; the server keeps its own `detach` view. */
  const pushContext = useCallback(
    async (force = false): Promise<void> => {
      if (!clientRef.current) return;
      const session = sessionIdRef.current;
      if (!session) return;
      const payload = payloadRef.current;
      if (!payload) return;
      const detached = detachedRef.current;
      const sent = sentKeysRef.current;
      const body: {
        url: string;
        title: string;
        selection?: string;
        page?: string;
        detach: ContextSource[];
      } = { url: payload.url, title: payload.title, detach: [] };
      const nextSent: Record<ContextSource, string> = { ...sent };
      for (const source of CONTEXT_SOURCES) {
        const text = payload[source];
        const dropIfAttached = (): void => {
          if (sent[source]) {
            body.detach.push(source);
            nextSent[source] = "";
          }
        };
        if (detached[source] || !text) {
          dropIfAttached();
          continue;
        }
        const key = fingerprint(text);
        if (force || key !== sent[source]) {
          body[source] = text;
          nextSent[source] = key;
        }
      }
      if (!body.page && !body.selection && body.detach.length === 0) return;
      try {
        await api().pushPageContext(session, body);
        sentKeysRef.current = nextSent;
        applyContextState();
      } catch (err) {
        // A failed push only means the next turn answers without that text —
        // never worth interrupting the conversation for.
        console.warn("[son] page-context push failed:", err);
      }
    },
    [api, applyContextState],
  );

  /** Fresh capture + deltas, throttled. Called before anything that ends in an
   *  LLM request (a transcript landing, a typed question), so a page the user
   *  just navigated to rides the turn it belongs to. Deltas mean this is a no-op
   *  in the ordinary case. */
  const refreshAndPush = useCallback(async (): Promise<void> => {
    if (!clientRef.current) return;
    const now = Date.now();
    if (now - lastPushRef.current < PUSH_MIN_INTERVAL_MS) return;
    lastPushRef.current = now;
    await refreshContext();
    await pushContext();
  }, [pushContext, refreshContext]);

  /** A chip's ×/+: switch a source off or back on. Off removes the block from
   *  the conversation and stops sending it; on attaches the current text again
   *  (which is also how a page glues back on after a navigation filled it in). */
  const toggleSource = useCallback(
    async (source: ContextSource): Promise<void> => {
      const detached = { ...detachedRef.current, [source]: !detachedRef.current[source] };
      detachedRef.current = detached;
      await saveDetached(detached);
      await refreshContext();
      await pushContext();
    },
    [pushContext, refreshContext],
  );

  /** Re-attach the sources that are on, even though nothing changed: after a
   *  long conversation the page text sits far from the newest question, and this
   *  puts it back at the end where it carries the most weight. Also the escape
   *  hatch when an answer suggests the model lost the page. */
  const reanchor = useCallback(async (): Promise<void> => {
    await refreshContext();
    await pushContext(true);
  }, [pushContext, refreshContext]);

  // --- session lifecycle ----------------------------------------------------

  const disconnect = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    clientRef.current = null;
    if (client) await client.disconnect().catch(() => {});
    micTrackRef.current = null;
    stopPlayback(audioRef.current);
    setBotSpeaking(false);
    setMuted(false);
    mutedRef.current = false;
  }, [audioRef]);

  const runPendingAsk = useCallback(async (): Promise<void> => {
    if (!pendingAskRef.current) return;
    pendingAskRef.current = false;
    const intent = await takeAskSelectionIntent();
    const client = clientRef.current;
    if (!intent || !client) return;
    const excerpt = intent.text.length > 240 ? `${intent.text.slice(0, 240)}…` : intent.text;
    // The selection itself rides the page-context block; the question only has
    // to point at it.
    const question = `Explain this selected text from the page and why it matters here: “${excerpt}”`;
    await refreshAndPush();
    await client.sendText(question, { run_immediately: true }).catch((err) => setStatus(`Send failed: ${errorMessage(err)}`));
    const next = mergeUserText(messagesRef.current, question, true);
    messagesRef.current = next;
    setMessages(next);
  }, [refreshAndPush]);

  const start = useCallback(async (): Promise<void> => {
    const current = settingsRef.current;
    if (!current || clientRef.current || connectingRef.current) return;
    connectingRef.current = true;
    setPhase("connecting");
    setStatus("Connecting to Son…");
    freshBotRowRef.current = true;

    const pick = sttPick();
    const webSpeech = pick.provider === "web-speech";
    const client = new PipecatClient({
      // The media manager must be injected: the transport's default one is
      // Daily's, which loads a remote bundle with eval — forbidden under MV3's
      // CSP, and fatal before /start even leaves the panel (see
      // lib/mediaManager.ts). Web Speech sessions close the mic entirely: the
      // server has no STT service to read a track (lib/mediaManager.ts).
      transport: new SmallWebRTCTransport({ mediaManager: new MicMediaManager({ capture: !webSpeech }) }),
      enableMic: !webSpeech,
      enableCam: false,
      callbacks: {
        onConnected: () => {
          if (clientRef.current !== client) return;
          setPhase("connected");
          setStatus(listeningStatus());
          void (async () => {
            // A fresh pipeline carries no blocks: whatever the previous one was
            // told is gone, so everything attached gets sent again.
            sentKeysRef.current = { page: "", selection: "" };
            await refreshContext();
            await pushContext();
            await runPendingAsk();
          })();
        },
        onBotReady: () => {
          if (clientRef.current === client) setStatus(listeningStatus());
        },
        onDisconnected: () => {
          if (clientRef.current !== client) return; // a newer client owns the panel
          clientRef.current = null;
          micTrackRef.current = null;
          stopPlayback(audioRef.current);
          setBotSpeaking(false);
          setMuted(false);
          mutedRef.current = false;
          setPhase("disconnected");
          setStatus("Disconnected.");
        },
        onError: (err: RTVIMessage) => {
          if (clientRef.current === client) setStatus(`Error: ${errorMessage(err)}`);
        },
        onTrackStarted: (track: MediaStreamTrack, participant?: unknown) => {
          // The local mic track arrives here too (with a participant arg): it
          // is kept for track-level mute and must never reach the speakers.
          if (participant) {
            if (track?.kind === "audio") micTrackRef.current = track;
            return;
          }
          if (track?.kind !== "audio") return;
          const el = audioRef.current;
          if (!el || el.srcObject) return;
          el.srcObject = new MediaStream([track]);
          startPlayback(el);
        },
        onTrackStopped: () => stopPlayback(audioRef.current),
        onUserTranscript: (data: { text?: string; final?: boolean; timestamp?: string }) => {
          if (clientRef.current !== client || !data?.text) return;
          const next = mergeUserText(messagesRef.current, data.text, !!data.final, data.timestamp);
          messagesRef.current = next;
          setMessages(next);
          // The turn is about to close — land the current page before it does.
          void refreshAndPush();
        },
        onBotOutput: (data: { text?: string }) => {
          if (clientRef.current !== client || !data?.text) return;
          const fresh = freshBotRowRef.current;
          freshBotRowRef.current = false;
          const next = mergeBotText(messagesRef.current, data.text, fresh);
          messagesRef.current = next;
          setMessages(next);
        },
      },
    });
    clientRef.current = client;
    try {
      await client.startBotAndConnect({
        endpoint: `${current.serverUrl.replace(/\/+$/, "")}/start`,
        requestData: {
          transport: "webrtc",
          body: {
            custom_data: {
              instruction: current.role,
              instruction_content: null,
              session_id: sessionIdRef.current,
              ...plainChoices({ ...current.choices, stt: pick }),
            },
          },
        },
      });
    } catch (err) {
      console.error("[son] connect failed:", err);
      // The failure may be after the mic opened (the manager connects once the
      // offer is accepted) — release it rather than leaving a live mic behind.
      await client.disconnect().catch(() => {});
      if (clientRef.current === client) clientRef.current = null;
      setPhase("disconnected");
      setStatus(`Couldn't reach Son at ${current.serverUrl} — is it running?`);
    } finally {
      connectingRef.current = false;
    }
  }, [audioRef, listeningStatus, pushContext, refreshAndPush, refreshContext, runPendingAsk, sttPick]);

  const stop = useCallback(async (): Promise<void> => {
    const wasConnected = clientRef.current !== null;
    await disconnect();
    if (wasConnected) {
      setPhase("idle");
      setStatus("Ready when you are.");
    }
  }, [disconnect]);

  const newChat = useCallback(async (): Promise<void> => {
    const wasConnected = clientRef.current !== null;
    await disconnect();
    const fresh = newSessionId();
    sessionIdRef.current = fresh;
    setSessionId(fresh);
    await saveSessionId(fresh);
    // The blocks belonged to the conversation that just ended.
    sentKeysRef.current = { page: "", selection: "" };
    messagesRef.current = [];
    // A fresh chat retries browser Web Speech: a granted permission or a fixed
    // network shouldn't need a settings trip to come back.
    sttFallbackRef.current = null;
    setSttFallback(null);
    setSttNote("");
    setMessages([]);
    setStatus("New conversation — press Start.");
    setPhase("idle");
    if (wasConnected) await start();
  }, [disconnect, start]);

  // --- browser Web Speech: the default STT ----------------------------------
  //
  // Recognition runs here, not on the server: the session has no server-side STT
  // service, so text reaches the brain through RTVI send-text. Ported from the
  // web client, which proved the flow; the differences are the fallback below,
  // and that this panel has no waveform to drive.

  /** Land the oldest pending utterance: clean it, finalize its row where it sits,
   *  send it. One at a time — a cleanup round-trip can outlive the silence
   *  window, and two concurrent flushes would both send. */
  const flushPending = useCallback(async (): Promise<void> => {
    if (sendTimerRef.current !== null) {
      window.clearTimeout(sendTimerRef.current);
      sendTimerRef.current = null;
    }
    if (flushingRef.current) {
      // Mid-cleanup: re-arm, so this utterance still gets finalized when that
      // one finishes instead of being left with no timer to land it.
      sendTimerRef.current = window.setTimeout(() => void flushPending(), PAUSE_SEND_MS);
      return;
    }
    const msgs = messagesRef.current;
    const at = msgs.findIndex((m) => m.role === "user" && !m.final);
    const client = clientRef.current;
    if (at < 0 || !client) return;
    flushingRef.current = true;
    try {
      const row = msgs[at];
      // The row's own text is the truth: every final so far joined into it.
      const text = row.text;
      const cleaned = (await api().cleanup(text)) || text;
      const now = messagesRef.current;
      const idx = now.findIndex((m) => m === row);
      // The row was replaced while we were cleaning (a later final merged into a
      // NEW object) — that final re-armed the timer, so the next flush sends the
      // whole utterance. This one sends nothing.
      if (idx < 0 || row.text !== text) return;
      const next = [...now];
      next[idx] = { ...row, text: cleaned, final: true, base: cleaned, spans: [{ ts: undefined, text: cleaned }] };
      messagesRef.current = next;
      setMessages(next);
      if (pendingUserRef.current === text) pendingUserRef.current = "";
      // Push first: sendText runs the turn immediately, and the page is the point
      // of talking to it.
      await refreshAndPush();
      await client
        .sendText(cleaned, { run_immediately: true })
        .catch((err) => setStatus(`Send failed: ${errorMessage(err)}`));
    } finally {
      flushingRef.current = false;
      if (sendTimerRef.current === null && messagesRef.current.some((m) => m.role === "user" && !m.final)) {
        sendTimerRef.current = window.setTimeout(() => void flushPending(), PAUSE_SEND_MS);
      }
    }
  }, [api, refreshAndPush]);

  const onSpeechResult = useCallback(
    (text: string, final: boolean): void => {
      if (!final) return; // interims morph as the engine refines them — never shown
      const msgs = messagesRef.current;
      const last = msgs[msgs.length - 1];
      // A new utterance starts whenever the last row isn't the still-open speech
      // row (the bot answered, or this one was already flushed): the join must
      // not carry the previous utterance's words into it.
      const continuing = last?.role === "user" && !last.final;
      const pending = continuing ? pendingUserRef.current : "";
      const joined =
        pending && !pending.endsWith(" ") && !text.startsWith(" ") ? `${pending} ${text}` : `${pending}${text}`;
      pendingUserRef.current = joined;
      const merged =
        last?.role === "user" && last.final
          ? [...msgs, { id: uid(), role: "user" as const, text: joined, final: false, base: "", spans: [] }]
          : mergeUserText(msgs, joined, false);
      messagesRef.current = merged;
      setMessages(merged);
      if (sendTimerRef.current !== null) window.clearTimeout(sendTimerRef.current);
      sendTimerRef.current = window.setTimeout(() => void flushPending(), PAUSE_SEND_MS);
    },
    [flushPending],
  );

  /** Web Speech died in a way restarting won't fix, and a session's STT cannot
   *  change in place (the server builds it per session) — so reconnect, asking
   *  for the local model. A user talking into nothing is the one outcome worth
   *  going out of the way to avoid. */
  const onSpeechFatal = useCallback(
    (reason: string): void => {
      const fromRoster = modelsRef.current?.stt.find((option) => option.provider === "parakeet" && option.id)?.id;
      const pick: Choice = { provider: "parakeet", id: fromRoster ?? PARAKEET_MODEL };
      sttFallbackRef.current = pick;
      setSttFallback(pick);
      setSttNote(
        `Web Speech off: ${SPEECH_FAILURE_HINT[reason] ?? reason}. This conversation is using the local Parakeet model.`,
      );
      void (async () => {
        await disconnect();
        await start();
      })();
    },
    [disconnect, start],
  );

  // Listening only while this is the session's STT, the session is up, and the
  // user hasn't paused: mute means silence in both STT modes.
  const recognizerUp = webSpeechMode && phase === "connected" && !muted;
  useEffect(() => {
    if (!recognizerUp) return;
    if (!webSpeechSupported()) {
      onSpeechFatal("unavailable");
      return;
    }
    return startWebSpeech({ onResult: onSpeechResult, onFatal: onSpeechFatal });
  }, [recognizerUp, onSpeechFatal, onSpeechResult]);

  const toggleMute = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    if (!client) return;
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    setStatus(next ? "Paused — Son can't hear you." : listeningStatus());
    // Mute at the track level (silence, not a torn-down connection) and mirror
    // it to client-js so the server sees the track status change. Either half
    // may be missing on some transports; neither may wedge the button.
    if (micTrackRef.current) micTrackRef.current.enabled = !next;
    try {
      await client.enableMic(!next);
    } catch (err) {
      console.warn("[son] transport enableMic failed (track mute still applied):", err);
    }
  }, [listeningStatus]);

  const sendTyped = useCallback(
    async (input: string): Promise<void> => {
      const client = clientRef.current;
      const text = input.trim();
      if (!client || !text) return;
      // Push first: sendText runs the turn immediately, so a push after it
      // would describe the page one question too late.
      await refreshAndPush();
      try {
        await client.sendText(text, { run_immediately: true });
      } catch (err) {
        setStatus(`Send failed: ${errorMessage(err)}`);
        return;
      }
      const next = mergeUserText(messagesRef.current, text, true);
      messagesRef.current = next;
      setMessages(next);
    },
    [refreshAndPush],
  );

  const stopReading = useCallback((): void => {
    const el = readAudioRef.current;
    readAudioRef.current = null;
    if (el) el.pause();
    setReading(false);
  }, []);

  /** Read aloud: the server's one-shot TTS on the selection (or the page when
   *  nothing is selected). No session, no LLM, no mic — the tired-eyes path. */
  const readAloud = useCallback(async (): Promise<void> => {
    if (readAudioRef.current) {
      stopReading();
      return;
    }
    await refreshContext();
    const payload = payloadRef.current;
    const text = payload?.selection || payload?.page || "";
    if (!text) {
      setStatus("Nothing to read — select something first.");
      return;
    }
    setStatus("Synthesizing…");
    try {
      const blob = await api().speak(text, settingsRef.current?.choices.tts);
      const url = URL.createObjectURL(blob);
      const el = new Audio(url);
      readAudioRef.current = el;
      el.onended = () => {
        URL.revokeObjectURL(url);
        if (readAudioRef.current === el) readAudioRef.current = null;
        setReading(false);
        setStatus(listeningStatus());
      };
      await el.play();
      setReading(true);
      setStatus("Reading aloud…");
    } catch (err) {
      readAudioRef.current = null;
      setReading(false);
      setStatus(`Read aloud failed: ${errorMessage(err)}`);
    }
  }, [api, listeningStatus, refreshContext, stopReading]);

  /** A reopened panel (or a fresh pop-out window) resumes the same server-side
   *  session id, so its transcript should come back with it — otherwise the
   *  conversation reads as restarted while the brain plainly remembers it. */
  const seedTranscript = useCallback(async (): Promise<void> => {
    if (messagesRef.current.length) return;
    const session = sessionIdRef.current;
    if (!session) return;
    try {
      const stored = await api().session(session);
      // A live turn may have landed while this was in flight; its rows win.
      if (messagesRef.current.length) return;
      const seeded: Msg[] = (stored.messages ?? []).map((message) => ({
        id: uid(),
        role: message.role === "assistant" ? ("bot" as const) : ("user" as const),
        text: message.text,
        final: true,
        base: message.role === "assistant" ? "" : message.text,
      }));
      messagesRef.current = seeded;
      setMessages(seeded);
    } catch {
      // Unknown/never-used session id: nothing stored, nothing to replay.
    }
  }, [api]);

  const updateSettings = useCallback(async (next: Settings): Promise<void> => {
    settingsRef.current = next;
    setSettings(next);
    await saveSettings(next);
  }, []);

  const reloadModels = useCallback(async (): Promise<void> => {
    const current = settingsRef.current;
    if (!current) return;
    setModelsLoading(true);
    try {
      applyRoster(await api().models());
    } finally {
      setModelsLoading(false);
    }
  }, [api, applyRoster]);

  // --- wiring ---------------------------------------------------------------

  useEffect(() => {
    void (async () => {
      const loaded = await loadSettings();
      settingsRef.current = loaded;
      setSettings(loaded);
      const id = await loadSessionId();
      sessionIdRef.current = id;
      setSessionId(id);
      detachedRef.current = await loadDetached();
      await seedTranscript();
      const client = new SonApi(loaded.serverUrl, loaded.serverToken ?? "");
      setModelsLoading(true);
      const [roster, roleList] = await Promise.all([client.models(), client.roles()]);
      applyRoster(roster);
      setRoles(roleList);
      setModelsLoading(false);
      void refreshWarming();
      await refreshContext();
      setStatus("Ready — press Start to talk.");
    })();
    // The audio element lives in the panel's DOM and can also pause on its own
    // (stream end), so the speaking indicator follows the element, not events.
    const el = audioRef.current;
    const onPlay = () => setBotSpeaking(true);
    const onPause = () => setBotSpeaking(false);
    el?.addEventListener("play", onPlay);
    el?.addEventListener("pause", onPause);
    // /models probes every configured provider, so one unreachable local server
    // (LM Studio down, a tailnet IP that stopped answering) can push the first
    // call past the timeout — and a panel opened before the bot is up gets
    // nothing at all. The server caches its roster, so retrying is cheap; the
    // schedule covers "the bot was still starting" without an unbounded loop.
    let cancelled = false;
    const retries = [10_000, 30_000, 90_000].map((delay) =>
      window.setTimeout(() => {
        if (!cancelled && !modelsRef.current) void reloadModels();
      }, delay),
    );
    return () => {
      cancelled = true;
      retries.forEach((timer) => window.clearTimeout(timer));
      el?.removeEventListener("play", onPlay);
      el?.removeEventListener("pause", onPause);
    };
  }, [applyRoster, audioRef, refreshContext, refreshWarming, reloadModels, seedTranscript]);

  useEffect(() => {
    const onMessage = (message: unknown) => {
      const payload = message as { type?: string; reason?: string } | undefined;
      if (payload?.type !== "son:context-changed") return;
      if (payload.reason === "ask-selection") {
        pendingAskRef.current = true;
        if (clientRef.current) {
          // Already listening: ask now. Only an inactive panel needs the
          // connect first (onConnected runs the same pending question).
          void runPendingAsk();
        } else if (!connectingRef.current) {
          void start();
        }
      }
      void (async () => {
        await refreshContext();
        if (clientRef.current) await pushContext();
      })();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [pushContext, refreshContext, runPendingAsk, start]);

  useEffect(() => {
    // Ask the cheap warmup route on a slow cadence, faster while a download is in
    // flight or the server is unreachable (so the dot recovers on its own the
    // moment `son start` brings the bot back). Slow rather than event-driven
    // because the server can start warming on its own — a restart, or another
    // client's session — and "models are still loading" is exactly the state that
    // must not be invisible.
    const active = Object.values(warming).some((state) => state === "downloading");
    const every = active || serverReachable === false ? 3000 : 10000;
    const timer = window.setInterval(() => void refreshWarming(), every);
    return () => window.clearInterval(timer);
  }, [serverReachable, warming, refreshWarming]);

  useEffect(() => {
    // The panel was popped out / the side panel reopened: resume the same
    // conversation id so the server replays its history instead of starting
    // over.
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshContext();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshContext]);

  return {
    settings,
    roles,
    models,
    modelsError,
    modelsLoading,
    warming,
    refreshWarming,
    serverReachable,
    phase,
    status,
    sttNote,
    messages,
    muted,
    botSpeaking,
    reading,
    context,
    sessionId,
    start,
    stop,
    newChat,
    toggleMute,
    sendTyped,
    readAloud,
    stopReading,
    refreshContext,
    toggleSource,
    reanchor,
    updateSettings,
    reloadModels,
  };
}

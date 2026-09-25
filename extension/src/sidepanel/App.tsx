import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { RefreshCw, X, Plus, CircleStop, ExternalLink, Mic, Pause, Play, Settings2, Speaker, SquarePen, VolumeX } from "lucide-react";

import { SettingsPanel } from "./Settings";
import { useSon } from "./useSon";
import type { ContextSource, ContextState } from "../lib/types";

function describeChars(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** One attachable source. The body opens the text the conversation is carrying;
 *  the trailing button is the on/off switch — Gemini's tab chip, in this panel's
 *  clothes: attached text stays in the conversation, × takes it out. */
function SourceChip({
  label,
  chars,
  attached,
  detached,
  live,
  note,
  canPreview,
  onToggle,
  onPreview,
}: {
  label: string;
  chars: number;
  attached: boolean;
  detached: boolean;
  live: boolean;
  note: string;
  canPreview: boolean;
  onToggle?: () => void;
  onPreview: () => void;
}) {
  const state = detached ? "off" : attached ? "in context" : live ? "changed" : "on Start";
  const toggleTitle = detached
    ? `Attach the ${label.toLowerCase()} to the conversation`
    : `Detach the ${label.toLowerCase()} — later questions stop carrying it`;
  return (
    <span className={`chip chip-${detached ? "off" : attached ? "live" : "empty"}`} title={`${note} — ${state}`}>
      {canPreview ? (
        <button type="button" className="chip-body" onClick={onPreview} title="Show the text that was attached">
          {label} {describeChars(chars)}
        </button>
      ) : (
        <span className="chip-value">{label} none</span>
      )}
      <span className="chip-note">{state}</span>
      {canPreview && onToggle && (
        <button type="button" className="chip-toggle" onClick={onToggle} title={toggleTitle}>
          {detached ? <Plus size={11} /> : <X size={11} />}
        </button>
      )}
    </span>
  );
}

function contextChips(
  context: ContextState,
  live: boolean,
  openPreview: (which: "selection" | "page") => void,
  toggle: (source: ContextSource) => void,
  reanchor: () => void,
) {
  if (!context.url) {
    return <span className="chip chip-empty">{context.note}</span>;
  }
  const host = hostOf(context.url);
  const chips = [
    <span key="host" className="chip" title={context.title || context.url}>
      <span className="chip-value">{host}</span>
    </span>,
  ];
  if (context.tone === "blocked") {
    chips.push(
      <span key="blocked" className="chip chip-empty" title={context.note}>
        current tab unreadable
      </span>,
    );
  }
  chips.push(
    <SourceChip
      key="page"
      label="Page"
      chars={context.pageChars}
      attached={context.attached.page}
      detached={context.detached.page}
      live={live}
      note={`${context.pageSource || "page"} · ${context.pageTruncated ? "trimmed to your page budget" : "whole"}`}
      canPreview={context.pageChars > 0}
      onToggle={() => toggle("page")}
      onPreview={() => openPreview("page")}
    />,
    <SourceChip
      key="selection"
      label="Selection"
      chars={context.selectionChars}
      attached={context.attached.selection}
      detached={context.detached.selection}
      live={live}
      note={context.selectionChars ? "the words you highlighted, with their paragraph" : "nothing selected on the page"}
      canPreview={context.selectionChars > 0}
      onToggle={() => toggle("selection")}
      onPreview={() => openPreview("selection")}
    />,
  );
  if (live && (context.attached.page || context.attached.selection)) {
    chips.push(
      <button
        key="reanchor"
        type="button"
        className="chip chip-button"
        onClick={reanchor}
        title="Send the attached text again, at the end of the conversation, where it carries most weight"
      >
        <RefreshCw size={11} /> re-attach
      </button>,
    );
  }
  return chips;
}

type Tone = "ok" | "warn" | "bad" | "idle";

/** A dot + label readable at a glance: is the bot there, and does it know its
 *  models yet. For the roster the label is also the button — /models is slow on
 *  a cold cache, so "loading" and "retry" belong in the same place. */
function StatusDot({
  tone,
  label,
  title,
  onClick,
  pulse = false,
}: {
  tone: Tone;
  label: string;
  title: string;
  onClick?: () => void;
  /** Only for states that are actually *live*: a pulsing dot reads as "working
   *  right now", which is true of a connected session and of nothing else. */
  pulse?: boolean;
}) {
  const body = (
    <>
      <span className={`dot dot-${tone}${pulse ? " dot-pulse" : ""}`} />
      <span>{label}</span>
    </>
  );
  if (!onClick) {
    return (
      <span className="status-dot" title={title}>
        {body}
      </span>
    );
  }
  return (
    <button type="button" className="status-dot" title={title} onClick={onClick}>
      {body}
    </button>
  );
}

export function App() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const son = useSon(audioRef);
  const [showSettings, setShowSettings] = useState(false);
  const [preview, setPreview] = useState<null | "selection" | "page">(null);
  const [moved, setMoved] = useState(false);
  const [draft, setDraft] = useState("");
  const [typing, setTyping] = useState(false);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const isPopup = new URLSearchParams(location.search).has("window");

  // Two panels must not open two pipelines for one conversation id. The
  // popped-out window is the newest instance, so it claims the session and the
  // side panel steps aside.
  useEffect(() => {
    if (isPopup) {
      void chrome.runtime.sendMessage({ type: "son:panel-claimed" }).catch(() => {});
      return;
    }
    const onMessage = (message: unknown) => {
      if ((message as { type?: string } | undefined)?.type !== "son:panel-claimed") return;
      void son.stop();
      setMoved(true);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [isPopup, son.stop]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [son.messages]);

  const live = son.phase === "connected";
  const serverUrl = son.settings?.serverUrl ?? "http://localhost:7860";
  // Reachability, not the session's phase. The old mapping painted a *running*
  // bot red the moment a session ended or a connect failed, which reads as
  // "server offline" while `son status` says otherwise.
  const serverTone: Tone =
    son.serverReachable === false
      ? "bad"
      : live
        ? son.muted
          ? "warn"
          : "ok"
        : son.serverReachable === null
          ? "warn"
          : "ok";
  const serverTitle =
    son.serverReachable === false
      ? `no answer from ${serverUrl} — start it with \`son start server\`; click to retry`
      : `server up at ${serverUrl}${
          live ? (son.muted ? " · session connected, mic paused" : " · session connected") : ` · no session (${son.phase})`
        } — ${son.status}`;
  const warming = Object.entries(son.warming)
    .filter(([, state]) => state === "downloading")
    .map(([label]) => label);
  const loadingModels = son.modelsLoading || warming.length > 0;
  const modelsTone: Tone = loadingModels ? "warn" : son.models ? "ok" : "bad";
  const modelsTitle = warming.length
    ? `the server is fetching ${warming.join(", ")} — a first-use download; a session started now waits for it`
    : son.models
      ? `roster: ${son.models.llm.length} brains · ${son.models.stt.length} speech-to-text · ${son.models.tts.length} voices — click to reload`
      : son.modelsLoading
        ? "asking the server for its model roster — the first call probes every provider, so it can take a moment"
        : "no roster yet — click to retry (the server may still be probing providers)";

  const primaryLabel = live ? (son.muted ? "Paused" : son.botSpeaking ? "Speaking…" : "Listening…") : "Start";

  async function onPrimary() {
    if (!live) {
      await son.start();
      return;
    }
    await son.toggleMute();
  }

  async function submitDraft() {
    const text = draft;
    setDraft("");
    await son.sendTyped(text);
  }

  return (
    <div className="panel">
      <audio ref={audioRef} autoPlay />

      <header className="head">
        <div className="brand">
          <span className="brand-name">Son</span>
          <StatusDot
            tone={serverTone}
            label="server"
            title={serverTitle}
            pulse={live}
            onClick={son.serverReachable === false ? () => void son.refreshWarming() : undefined}
          />
          <StatusDot
            tone={modelsTone}
            label={loadingModels ? "models…" : "models"}
            title={modelsTitle}
            onClick={() => {
              // One click refreshes everything the dot reports: the roster and
              // the server's warmup state.
              void son.reloadModels();
              void son.refreshWarming();
            }}
          />
          <span className="brand-status" title={son.status}>
            {son.status}
          </span>
        </div>
        <div className="head-actions">
          <button type="button" className="icon" title="Start a new conversation" onClick={() => void son.newChat()}>
            <SquarePen size={16} />
          </button>
          {!isPopup && (
            <button
              type="button"
              className="icon"
              title="Pop out into a floating window"
              onClick={() =>
                void chrome.windows.create({
                  url: chrome.runtime.getURL("sidepanel.html?window=1"),
                  type: "popup",
                  width: 420,
                  height: 640,
                })
              }
            >
              <ExternalLink size={16} />
            </button>
          )}
          <button
            type="button"
            className={`icon${showSettings ? " icon-active" : ""}`}
            title="Settings — server, role, models"
            onClick={() => setShowSettings((open) => !open)}
          >
            <Settings2 size={16} />
          </button>
        </div>
      </header>

      <div className="chips">
        {son.context.tone === "idle" ? (
          <span className="chip chip-empty">reading the page…</span>
        ) : (
          contextChips(
            son.context,
            live,
            setPreview,
            (source) => void son.toggleSource(source),
            () => void son.reanchor(),
          )
        )}
      </div>

      {moved && <p className="notice">Moved to the popped-out Son window — this panel is idle.</p>}

      {!isPopup && son.sttNote && <p className="notice">{son.sttNote}</p>}

      {!isPopup && son.serverReachable === false && (
        <p className="notice">
          No answer from <code>{serverUrl}</code>. Start the bot with <code>son start server</code>, then click the
          server dot to retry.
        </p>
      )}

      {showSettings && son.settings && (
        <SettingsPanel
          settings={son.settings}
          roles={son.roles}
          models={son.models}
          modelsError={son.modelsError}
          onSave={(next) => void son.updateSettings(next)}
          onReloadModels={() => void son.reloadModels()}
        />
      )}

      {preview && (
        <div className="preview">
          <div className="preview-head">
            <span>{preview === "selection" ? "Attached selection" : "Attached page text"}</span>
            <button type="button" className="link" onClick={() => setPreview(null)}>
              close
            </button>
          </div>
          <pre>{preview === "selection" ? son.context.selection : son.context.page}</pre>
        </div>
      )}

      <div className="transcript" ref={transcriptRef}>
        {son.messages.length === 0 && (
          <div className="empty">
            <p>Talk to the page.</p>
            <p className="empty-sub">
              Select something (or don't) and ask out loud — Son hears the page you're on, answers in speech, and keeps
              the conversation across tabs.
            </p>
          </div>
        )}
        {son.messages.map((message) => (
          <div key={message.id} className={`row row-${message.role}`}>
            <div className={`bubble bubble-${message.role}${message.final ? "" : " bubble-live"}`}>
              {message.role === "bot" ? (
                <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
              ) : (
                message.text
              )}
            </div>
          </div>
        ))}
      </div>

      {typing && (
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submitDraft();
          }}
        >
          <input
            autoFocus
            value={draft}
            placeholder={live ? "Type instead…" : "Start the session first"}
            disabled={!live}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="link" disabled={!live || !draft.trim()}>
            send
          </button>
        </form>
      )}

      <footer className="foot">
        <button
          type="button"
          className={`primary${live ? " primary-live" : ""}${son.botSpeaking ? " primary-speaking" : ""}`}
          onClick={() => void onPrimary()}
          disabled={son.phase === "connecting"}
        >
          {live ? son.muted ? <Play size={18} /> : son.botSpeaking ? <Speaker size={18} /> : <Pause size={18} /> : <Mic size={18} />}
          <span>{son.phase === "connecting" ? "Connecting…" : primaryLabel}</span>
        </button>
        <button
          type="button"
          className={`icon${son.reading ? " icon-active" : ""}`}
          title={son.reading ? "Stop reading" : "Read the selection aloud (no AI)"}
          onClick={() => void son.readAloud()}
        >
          {son.reading ? <VolumeX size={16} /> : <Speaker size={16} />}
        </button>
        <button
          type="button"
          className={`icon${typing ? " icon-active" : ""}`}
          title="Type instead of talking"
          onClick={() => setTyping((open) => !open)}
          disabled={!live}
        >
          <SquarePen size={16} />
        </button>
        <button
          type="button"
          className="icon"
          title="End the session"
          onClick={() => void son.stop()}
          disabled={!live && son.phase !== "connecting"}
        >
          <CircleStop size={16} />
        </button>
      </footer>
    </div>
  );
}

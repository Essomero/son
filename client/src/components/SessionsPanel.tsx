/**
 * Left rail of past sessions. Click a row to resume it (role restored, stored
 * transcript replayed, brain seeded); double-click the name to rename; hover
 * to delete. The panel collapses to zero width from the header toggle; the
 * inner div keeps its width so the rows don't reflow mid-transition.
 */

import { useState } from "react";
import { Check, Copy, MessageSquare, Mic, PanelLeftClose, PanelLeftOpen, Server, Settings2, Trash2, Volume2 } from "lucide-react";

import type { SessionMeta } from "../lib/types";
import { ModeSlider } from "./ModeSlider";
import { SESSIONS_URL } from "../lib/son";
import { copyText } from "../lib/clipboard";

function relativeTime(iso: string): string {
  const d = new Date(iso); // server writes local ISO, no tz — parses as local
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString([], { day: "numeric", month: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}

/** Fetch a session's stored messages and format them as plain text. */
async function copyTranscript(s: SessionMeta): Promise<boolean> {
  try {
    const res = await fetch(`${SESSIONS_URL}/${s.id}`);
    if (!res.ok) return false;
    const detail = (await res.json()) as {
      messages: { role: string; text: string }[];
    };
    const text = detail.messages
      .map((m) => `${m.role === "user" ? "You" : "Son"}: ${m.text}`)
      .join("\n");
    return await copyText(text);
  } catch {
    return false;
  }
}

export function SessionsPanel({
  open,
  sessions,
  activeId,
  onToggle,
  onOpenSettings,
  onOpenStatus,
  modelsLive,
  onNewChat,
  view,
  readerMode,
  onReaderMode,
  onResume,
  onRename,
  onDelete,
}: {
  open: boolean;
  sessions: SessionMeta[];
  activeId: string | null;
  onToggle: () => void;
  onOpenSettings: () => void;
  /** The server-status panel — its own button, not a field in ⚙. */
  onOpenStatus: () => void;
  /** Whether the model roster came from the server, for the status dot. */
  modelsLive: boolean;
  /** A fresh conversation: the wordmark and the Chat entry both land there. */
  onNewChat: () => void;
  /** Which destination is on screen. */
  view: "chat" | "reader";
  /** Which reader page, when the destination is the reader. */
  readerMode: "read" | "speak";
  /** Open the Read or the Speak page (both set the mode and leave the chat). */
  onReaderMode: (mode: "read" | "speak") => void;
  onResume: (s: SessionMeta) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = async (s: SessionMeta) => {
    if (await copyTranscript(s)) {
      setCopiedId(s.id);
      window.setTimeout(
        () => setCopiedId((cur) => (cur === s.id ? null : cur)),
        1500,
      );
    }
  };

  const startEdit = (s: SessionMeta) => {
    setEditingId(s.id);
    setDraft(s.name);
  };
  const commitEdit = () => {
    if (editingId) {
      const name = draft.trim();
      if (name && name !== sessions.find((m) => m.id === editingId)?.name) onRename(editingId, name);
      setEditingId(null);
    }
  };
  const cancelEdit = () => setEditingId(null);
  const onChat = view === "chat";
  const onRead = view === "reader" && readerMode === "read";
  const onSpeak = view === "reader" && readerMode === "speak";

  return (
    <aside className={`sessions-panel${open ? "" : " closed"}`} aria-label="Sessions">
      <div className="sessions-panel-inner">
        <a
          className="sessions-brand"
          href="/"
          title="Home"
          aria-label="Son — home"
          onClick={(event) => {
            event.preventDefault(); // the app owns navigation; this is not a page load
            onNewChat();
          }}
        >
          <h1 className="brand">
            Son<span className="brand-dot">·</span>
          </h1>
        </a>

        {/* Chat is always there — it is the way home, and the way to a new one —
            with Read | Speak at the foot, above settings. The collapsed strip
            mirrors both. */}
        <div className="sessions-nav">
          <button
            type="button"
            className={`icon-btn${onChat ? " active" : ""}`}
            onClick={onNewChat}
            title="New chat"
            aria-label="New chat"
            aria-current={onChat ? "page" : undefined}
          >
            <MessageSquare size={16} />
            <span className="icon-btn-label">Chat</span>
          </button>
        </div>

        <div className="sessions-head">
          <h2 className="sessions-title">Sessions</h2>
          <button
            type="button"
            className="sessions-collapse"
            onClick={onToggle}
            title="Hide the chat list"
            aria-label="Hide the chat list"
            aria-expanded={open}
          >
            <PanelLeftClose size={15} aria-hidden />
          </button>
        </div>
        {sessions.length === 0 ? (
          <p className="sessions-empty">
            No sessions yet. Start talking — conversations collect here and can be resumed
            anytime.
          </p>
        ) : (
          <ul className="sessions-list">
            {sessions.map((s) => {
              const active = s.id === activeId;
              const editing = editingId === s.id;
              return (
                <li key={s.id} className={`sess-row${active ? " active" : ""}`}>
                  {editing ? (
                    <input
                      className="sess-rename"
                      value={draft}
                      autoFocus
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit();
                        if (e.key === "Escape") cancelEdit();
                      }}
                      onBlur={commitEdit}
                      aria-label="Session name"
                    />
                  ) : (
                    <button
                      type="button"
                      className="sess-main"
                      onClick={() => onResume(s)}
                      onDoubleClick={() => startEdit(s)}
                      title={active ? "This session is live" : "Resume this session"}
                    >
                      <span className="sess-name">{s.name}</span>
                      <span className="sess-meta">
                        {s.message_count} {s.message_count === 1 ? "msg" : "msgs"} ·{" "}
                        {relativeTime(s.updated_at)}
                      </span>
                      {s.preview && <span className="sess-preview">{s.preview}</span>}
                    </button>
                  )}
                  <button
                    type="button"
                    className="sess-copy"
                    onClick={() => void handleCopy(s)}
                    title="Copy transcript"
                    aria-label={`Copy transcript of ${s.name}`}
                  >
                    {copiedId === s.id ? (
                      <Check size={13} aria-hidden />
                    ) : (
                      <Copy size={13} aria-hidden />
                    )}
                  </button>
                  <button
                    type="button"
                    className="sess-del"
                    onClick={() => onDelete(s.id)}
                    title="Delete session"
                    aria-label={`Delete ${s.name}`}
                  >
                    <Trash2 size={13} aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* The foot of the rail: the destinations you switch between (Read |
            Speak) above settings. The whole block pins, like the head does. */}
        <div className="sessions-foot">
          <ModeSlider mode={readerMode} onPick={onReaderMode} />
          <button
            type="button"
            className="sessions-foot-btn"
            onClick={onOpenStatus}
            title={modelsLive ? "Server status — live roster" : "Server status — no live roster"}
          >
            <Server size={15} aria-hidden />
            <span>Status</span>
            <span className={`status-dot ${modelsLive ? "ok" : "warn"}`} aria-hidden />
          </button>
          <button
            type="button"
            className="sessions-foot-btn"
            onClick={onOpenSettings}
            title="Model settings"
          >
            <Settings2 size={15} aria-hidden />
            <span>Settings</span>
          </button>
        </div>
      </div>
      {/* Collapsed, the rail is a 30px strip: the same frame folded to an edge —
          reopen at the top, the destinations as icon buttons under it, settings
          at the foot — so no action is stranded by collapsing. */}
      <div className="sessions-strip">
        <button
          type="button"
          className="sessions-strip-btn"
          onClick={onToggle}
          title="Show the chat list"
          aria-label="Show the chat list"
          aria-expanded={open}
        >
          <PanelLeftOpen size={16} aria-hidden />
        </button>
        <div className="sessions-strip-nav">
          <button
            type="button"
            className={`sessions-strip-btn${onChat ? " active" : ""}`}
            onClick={onNewChat}
            title="New chat"
            aria-label="New chat"
            aria-current={onChat ? "page" : undefined}
          >
            <MessageSquare size={16} aria-hidden />
          </button>
        </div>
        <div className="sessions-strip-nav sessions-strip-foot">
          <button
            type="button"
            className={`sessions-strip-btn${onRead ? " active" : ""}`}
            onClick={() => onReaderMode("read")}
            title="Read: turn text into speech"
            aria-label="Read: turn text into speech"
            aria-current={onRead ? "page" : undefined}
          >
            <Volume2 size={16} aria-hidden />
          </button>
          <button
            type="button"
            className={`sessions-strip-btn${onSpeak ? " active" : ""}`}
            onClick={() => onReaderMode("speak")}
            title="Speak: dictate, and the text lands on your clipboard"
            aria-label="Speak: dictate, and the text lands on your clipboard"
            aria-current={onSpeak ? "page" : undefined}
          >
            <Mic size={16} aria-hidden />
          </button>
        </div>
        <button
          type="button"
          className="sessions-strip-btn"
          onClick={onOpenStatus}
          title="Server status"
          aria-label="Server status"
        >
          <Server size={16} aria-hidden />
        </button>
        <button
          type="button"
          className="sessions-strip-btn"
          onClick={onOpenSettings}
          title="Model settings"
          aria-label="Model settings"
        >
          <Settings2 size={16} aria-hidden />
        </button>
      </div>
    </aside>
  );
}

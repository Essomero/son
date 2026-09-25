/**
 * Left rail of past sessions. Click a row to resume it (role restored, stored
 * transcript replayed, brain seeded); double-click the name to rename; hover
 * to delete. The panel collapses to zero width from the header toggle; the
 * inner div keeps its width so the rows don't reflow mid-transition.
 */

import { useState } from "react";
import { Check, Copy, PanelLeftClose, PanelLeftOpen, Trash2 } from "lucide-react";

import type { SessionMeta } from "../lib/types";
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
  onResume,
  onRename,
  onDelete,
}: {
  open: boolean;
  sessions: SessionMeta[];
  activeId: string | null;
  onToggle: () => void;
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

  return (
    <aside className={`sessions-panel${open ? "" : " closed"}`} aria-label="Sessions">
      <div className="sessions-panel-inner">
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
      </div>
      {/* The way back lives on the panel's own edge, so the control is always
          where the chat list is — collapsed or open. Hidden while open (the
          chevron beside the title does the work then) so it never overlays the
          rows. */}
      <button
        type="button"
        className="sessions-handle"
        onClick={onToggle}
        title="Show the chat list"
        aria-label="Show the chat list"
        aria-expanded={open}
      >
        <PanelLeftOpen size={15} aria-hidden />
      </button>
    </aside>
  );
}

/**
 * Top bar: wordmark, live status, role chip (re-pickable when not in a
 * session), and the session actions — new session, panel toggle, end, settings.
 */

import { useState } from "react";
import { ChevronDown, MessageSquare, PhoneOff, Plus, Settings2 } from "lucide-react";

import type { Phase, Role } from "../lib/types";
import { RoleAvatar } from "./Avatar";

/** The Read | Speak control: two segments in one pill, with a highlight that
 *  slides between them — the Write/Preview tab pattern, one level up. They are
 *  different actions, so picking one *opens* that page; nothing renders both. */
function ModeSlider({
  mode,
  onPick,
}: {
  mode: "read" | "speak";
  onPick: (mode: "read" | "speak") => void;
}) {
  return (
    <div
      className="mode-slider"
      data-mode={mode}
      role="radiogroup"
      aria-label="Read or speak"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onPick("read");
        else if (event.key === "ArrowRight") onPick("speak");
      }}
    >
      <div className="mode-slider-thumb" aria-hidden />
      {(["read", "speak"] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          className="mode-btn"
          onClick={() => onPick(value)}
          title={
            value === "read"
              ? "Read: turn text into speech"
              : "Speak: dictate, and the text lands on your clipboard"
          }
        >
          {value === "read" ? "Read" : "Speak"}
        </button>
      ))}
    </div>
  );
}

export function Header({
  phase,
  status,
  speaking,
  role,
  roles,
  view,
  readerMode,
  onSelectRole,
  onNewSession,
  onToggleView,
  onReaderMode,
  onEndSession,
  onOpenSettings,
}: {
  phase: Phase;
  status: string;
  speaking: boolean;
  role: Role | null;
  roles: Role[];
  view: "chat" | "reader";
  /** Which reader page the slider is pointed at. */
  readerMode: "read" | "speak";
  onSelectRole: (r: Role) => void;
  onNewSession: () => void;
  onToggleView: () => void;
  /** Open the Read or the Speak page (both set the mode and leave the chat). */
  onReaderMode: (mode: "read" | "speak") => void;
  onEndSession: () => void;
  onOpenSettings: () => void;
}) {
  const [roleMenu, setRoleMenu] = useState(false);
  const canPickRole = phase === "ready" || phase === "disconnected";
  const liveStatus =
    phase === "connected" ? (speaking ? "Son is speaking…" : "Connected — you can talk.") : status;

  return (
    <header className="topbar">
      <h1 className="brand">
        Son<span className="brand-dot">·</span>
      </h1>
      <p className="status" role="status">
        {liveStatus}
      </p>
      <div className="topbar-actions">
        {role && (
          <div className="role-chip-wrap">
            <button
              type="button"
              className="role-chip"
              onClick={() => canPickRole && setRoleMenu((v) => !v)}
              disabled={!canPickRole}
              title={canPickRole ? "Switch role" : role.name}
            >
              <RoleAvatar name={role.name} size={22} />
              <span>{role.name}</span>
              {canPickRole && <ChevronDown size={13} aria-hidden />}
            </button>
            {roleMenu && (
              <div className="role-menu" role="listbox" aria-label="Pick a role">
                {roles.map((r) => (
                  <button
                    type="button"
                    key={r.file}
                    role="option"
                    aria-selected={r.file === role.file}
                    className={`role-menu-item${r.file === role.file ? " selected" : ""}`}
                    onClick={() => {
                      onSelectRole(r);
                      setRoleMenu(false);
                    }}
                  >
                    <RoleAvatar name={r.name} size={26} />
                    <span className="role-menu-text">
                      <span className="role-menu-name">{r.name}</span>
                      <span className="role-menu-desc">{r.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {(phase === "connected" || phase === "disconnected") && (
          <button
            type="button"
            className="icon-btn"
            onClick={onNewSession}
            title="New session"
            aria-label="New session"
          >
            <Plus size={16} />
            <span className="icon-btn-label">New</span>
          </button>
        )}
        {phase === "connected" && (
          <button type="button" className="icon-btn" onClick={onEndSession} title="End session" aria-label="End session">
            <PhoneOff size={16} />
            <span className="icon-btn-label">End</span>
          </button>
        )}
        {view === "reader" && (
          <button
            type="button"
            className="icon-btn"
            onClick={onToggleView}
            title="Back to the chat"
            aria-label="Back to the chat"
          >
            <MessageSquare size={16} />
            <span className="icon-btn-label">Chat</span>
          </button>
        )}
        <ModeSlider mode={readerMode} onPick={onReaderMode} />
        <button
          type="button"
          className="icon-btn"
          onClick={onOpenSettings}
          title="Model settings"
          aria-label="Model settings"
        >
          <Settings2 size={16} />
        </button>
      </div>
    </header>
  );
}

/**
 * Top bar: wordmark, live status, role chip (re-pickable when not in a
 * session), and the session actions — new session, panel toggle, end, settings.
 */

import { useState } from "react";
import { ChevronDown, PanelLeft, PhoneOff, Plus, Settings2, Volume2 } from "lucide-react";

import type { Phase, Role } from "../lib/types";
import { RoleAvatar } from "./Avatar";

export function Header({
  phase,
  status,
  speaking,
  role,
  roles,
  panelOpen,
  view,
  onSelectRole,
  onNewSession,
  onTogglePanel,
  onToggleView,
  onEndSession,
  onOpenSettings,
}: {
  phase: Phase;
  status: string;
  speaking: boolean;
  role: Role | null;
  roles: Role[];
  panelOpen: boolean;
  view: "chat" | "reader";
  onSelectRole: (r: Role) => void;
  onNewSession: () => void;
  onTogglePanel: () => void;
  onToggleView: () => void;
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
        <button
          type="button"
          className={`icon-btn${view === "reader" ? " active" : ""}`}
          onClick={onToggleView}
          title={view === "reader" ? "Back to the chat" : "Read out text — no AI, just speech"}
          aria-label={view === "reader" ? "Back to the chat" : "Read out text"}
          aria-pressed={view === "reader"}
        >
          <Volume2 size={16} />
          <span className="icon-btn-label">Read</span>
        </button>
        <button
          type="button"
          className={`icon-btn${panelOpen ? " active" : ""}`}
          onClick={onTogglePanel}
          title={panelOpen ? "Hide sessions" : "Show sessions"}
          aria-label={panelOpen ? "Hide sessions" : "Show sessions"}
          aria-pressed={panelOpen}
        >
          <PanelLeft size={16} />
        </button>
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

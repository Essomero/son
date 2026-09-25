/**
 * Top bar: live status, role chip (re-pickable when not in a session), and the
 * session actions — new session, end. The wordmark and the Chat | Read | Speak
 * destinations live in the rail.
 */

import { useState } from "react";
import { ChevronDown, PhoneOff, Plus } from "lucide-react";

import type { Phase, Role } from "../lib/types";
import { RoleAvatar } from "./Avatar";

export function Header({
  phase,
  status,
  speaking,
  role,
  roles,
  onSelectRole,
  onNewSession,
  onEndSession,
}: {
  phase: Phase;
  status: string;
  speaking: boolean;
  role: Role | null;
  roles: Role[];
  onSelectRole: (r: Role) => void;
  onNewSession: () => void;
  onEndSession: () => void;
}) {
  const [roleMenu, setRoleMenu] = useState(false);
  const canPickRole = phase === "ready" || phase === "disconnected";
  const liveStatus =
    phase === "connected" ? (speaking ? "Son is speaking…" : "Connected — you can talk.") : status;

  return (
    <header className="topbar">
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
      </div>
    </header>
  );
}

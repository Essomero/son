/**
 * The idle screen: wordmark, tagline, role cards, and the Start talking
 * button. Role cards look like contacts — initial avatar + name + blurb.
 */

import { Check, Loader2, PhoneCall } from "lucide-react";

import type { Phase, Role } from "../lib/types";
import { RoleAvatar } from "./Avatar";

export function Hero({
  roles,
  selected,
  phase,
  onSelect,
  onConnect,
}: {
  roles: Role[];
  selected: Role | null;
  phase: Phase;
  onSelect: (r: Role) => void;
  onConnect: () => void;
}) {
  const connecting = phase === "connecting";
  return (
    <section className="hero">
      <p className="eyebrow">Real-time voice agent</p>
      <h2 className="hero-title">
        Son<span className="brand-dot">·</span>
      </h2>
      <p className="hero-sub">
        Pick who's on the line, hit start, and just talk — it listens, answers out loud, and lets
        you interrupt.
      </p>

      <h3 className="section-label">Who's on the line</h3>
      {roles.length === 0 ? (
        <p className="empty">
          No roles found. Add a <code>.md</code> file to the instructions folder and run{" "}
          <code>uv run scripts/gen_roles.py</code>.
        </p>
      ) : (
        <div className="role-grid">
          {roles.map((r) => {
            const sel = selected?.file === r.file;
            return (
              <button
                type="button"
                key={r.file}
                className={`role-card${sel ? " selected" : ""}`}
                onClick={() => onSelect(r)}
                aria-pressed={sel}
              >
                <RoleAvatar name={r.name} size={42} />
                <span className="role-card-text">
                  <span className="role-card-name">{r.name}</span>
                  <span className="role-card-desc">{r.description}</span>
                </span>
                {sel && <Check size={16} className="role-card-check" aria-hidden />}
              </button>
            );
          })}
        </div>
      )}

      <button
        type="button"
        className="start-btn"
        onClick={onConnect}
        disabled={phase !== "ready" && !connecting}
      >
        {connecting ? <Loader2 size={17} className="spin" aria-hidden /> : <PhoneCall size={17} aria-hidden />}
        {connecting ? "Connecting…" : "Start talking"}
      </button>
    </section>
  );
}

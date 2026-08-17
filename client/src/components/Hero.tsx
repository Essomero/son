/**
 * The idle screen: wordmark, tagline, role cards, and the Start talking
 * button. Role cards look like contacts — initial avatar + name + blurb.
 * Custom personas (browser-local, from a markdown file) share the grid with
 * a "custom" badge and a hover remove; the dashed card opens the persona
 * modal.
 */

import { Check, Loader2, PhoneCall, Plus, X } from "lucide-react";

import type { Phase, Role } from "../lib/types";
import { RoleAvatar } from "./Avatar";

export function Hero({
  roles,
  customRoles,
  selected,
  phase,
  onSelect,
  onConnect,
  onAddCustom,
  onRemoveCustom,
}: {
  roles: Role[];
  customRoles: Role[];
  selected: Role | null;
  phase: Phase;
  onSelect: (r: Role) => void;
  onConnect: () => void;
  onAddCustom: () => void;
  onRemoveCustom: (file: string) => void;
}) {
  const connecting = phase === "connecting";
  const isEmpty = roles.length + customRoles.length === 0;
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
      {isEmpty ? (
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
          {customRoles.map((r) => {
            const sel = selected?.file === r.file;
            return (
              <div key={r.file} className={`role-card custom${sel ? " selected" : ""}`}>
                <button
                  type="button"
                  className="role-card-pick"
                  onClick={() => onSelect(r)}
                  aria-pressed={sel}
                >
                  <RoleAvatar name={r.name} size={42} />
                  <span className="role-card-text">
                    <span className="role-card-name">
                      {r.name}
                      <span className="custom-badge">custom</span>
                    </span>
                    <span className="role-card-desc">
                      {r.description || "From your own markdown file"}
                    </span>
                  </span>
                  {sel && <Check size={16} className="role-card-check" aria-hidden />}
                </button>
                <button
                  type="button"
                  className="role-card-remove"
                  onClick={() => onRemoveCustom(r.file)}
                  title="Remove persona"
                  aria-label={`Remove ${r.name}`}
                >
                  <X size={13} aria-hidden />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="role-card add"
            onClick={onAddCustom}
            aria-label="Add a persona from a markdown file"
          >
            <span className="add-circle">
              <Plus size={18} aria-hidden />
            </span>
            <span className="role-card-text">
              <span className="role-card-name">Add persona</span>
              <span className="role-card-desc">From a markdown file of instructions</span>
            </span>
          </button>
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

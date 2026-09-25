import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import type { Capability, Choice, ModelOption, Models, Role, Settings } from "../lib/types";

/** Settings save as they change: this is a 380px pane, not a dialog, and a
 *  separate Save button is one more thing to forget (the values only matter
 *  when a session starts, so nothing is applied mid-conversation). */

const CAPABILITIES: { cap: Capability; label: string; hint: string }[] = [
  { cap: "llm", label: "Brain", hint: "Reasons over your question and the page" },
  { cap: "stt", label: "Speech-to-text", hint: "How your voice becomes text" },
  { cap: "tts", label: "Voice", hint: "How replies are spoken back" },
];

/** Roster entries the panel doesn't offer: browser TTS (speechSynthesis) has no
 *  place here (the panel's audio path is the server's). Browser *STT* is the
 *  default and is offered — the panel runs that recognition itself. */
const NOT_OFFERED: Record<string, true> = { browser: true };

/** Option identity for the pickers. The voice is part of it: Groq's Orpheus
 *  offers one model id with six voices, so provider|id alone would collapse
 *  them into one option (and one React key). A saved Choice is keyed the same
 *  way, which is what lets the select show the persisted pick again. */
function choiceKey(option: Pick<ModelOption, "provider" | "id" | "voice">): string {
  return [option.provider, option.id, option.voice].filter(Boolean).join("|");
}

function choiceFromKey(key: string, options: ModelOption[]): Choice | undefined {
  const option = options.find((candidate) => choiceKey(candidate) === key);
  if (!option) return undefined;
  return { provider: option.provider, id: option.id, ...(option.voice ? { voice: option.voice } : {}) };
}

function ModelRow({
  cap,
  label,
  hint,
  options,
  choice,
  onPick,
}: {
  cap: Capability;
  label: string;
  hint: string;
  options: ModelOption[];
  choice?: Choice;
  onPick: (cap: Capability, choice?: Choice) => void;
}) {
  const offered = options.filter((option) => !NOT_OFFERED[option.provider]);
  const groups = new Map<string, ModelOption[]>();
  for (const option of offered) {
    const list = groups.get(option.provider) ?? [];
    list.push(option);
    groups.set(option.provider, list);
  }
  const current = choice ? choiceKey(choice) : "";
  const known = offered.some((option) => choiceKey(option) === current);
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select
        value={known ? current : ""}
        onChange={(event) => {
          const key = event.target.value;
          onPick(cap, key ? choiceFromKey(key, offered) : undefined);
        }}
      >
        <option value="">Server default</option>
        {[...groups].map(([provider, list]) => (
          <optgroup key={provider} label={provider}>
            {list.map((option) => (
              <option key={choiceKey(option)} value={choiceKey(option)}>
                {option.label && option.label !== option.id ? `${option.label} — ${option.id}` : option.id}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <span className="field-hint">{hint}</span>
    </label>
  );
}

export function SettingsPanel({
  settings,
  roles,
  models,
  modelsError,
  onSave,
  onReloadModels,
}: {
  settings: Settings;
  roles: Role[];
  models: Models | null;
  modelsError: boolean;
  onSave: (settings: Settings) => void;
  onReloadModels: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);

  function update(patch: Partial<Settings>) {
    const next = { ...draft, ...patch };
    setDraft(next);
    onSave(next);
  }

  function pick(cap: Capability, choice?: Choice) {
    update({ choices: { ...draft.choices, [cap]: choice } });
  }

  return (
    <section className="settings">
      <label className="field">
        <span className="field-label">Server</span>
        <input
          value={draft.serverUrl}
          spellCheck={false}
          onChange={(event) => update({ serverUrl: event.target.value.trim() })}
        />
        <span className="field-hint">Where son.py is running (default http://localhost:7860)</span>
      </label>

      <label className="field">
        <span className="field-label">Role</span>
        <select value={draft.role} onChange={(event) => update({ role: event.target.value })}>
          {roles.length === 0 && <option value={draft.role}>{draft.role}</option>}
          {roles.map((role) => (
            <option key={role.file} value={role.file}>
              {role.name}
            </option>
          ))}
        </select>
        <span className="field-hint">
          The instruction file that shapes the answers{modelsError ? " (server unreachable — list may be stale)" : ""}
        </span>
      </label>

      <div className="settings-head">
        <span className="field-label">Models</span>
        <button type="button" className="link" onClick={onReloadModels}>
          <RefreshCw size={12} /> reload
        </button>
      </div>
      {!models && <p className="field-hint">Start the server to list the models your keys unlock.</p>}
      {CAPABILITIES.map(({ cap, label, hint }) => (
        <ModelRow
          key={cap}
          cap={cap}
          label={label}
          hint={hint}
          options={models?.[cap] ?? []}
          choice={draft.choices[cap]}
          onPick={pick}
        />
      ))}

      <div className="settings-head">
        <span className="field-label">Page context</span>
      </div>
      <label className="field">
        <span className="field-label">Page text budget: {draft.pageChars.toLocaleString()} chars</span>
        <input
          type="range"
          min={2000}
          max={40000}
          step={1000}
          value={draft.pageChars}
          onChange={(event) => update({ pageChars: Number(event.target.value) })}
        />
        <span className="field-hint">
          The page is attached to the conversation once, so a big budget is paid once rather than per question. The
          server caps a block at 40,000 chars; a trimmed capture says so on the chip.
        </span>
      </label>
      <p className="field-hint">
        The chips above the transcript switch each source on and off (× detaches what the conversation is carrying, +
        puts the current page or selection back), so you decide which questions carry the page.
      </p>
    </section>
  );
}

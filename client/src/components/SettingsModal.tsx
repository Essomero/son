/**
 * The ⚙ panel: one custom picker per capability (Brain / Speech-to-text /
 * Voice), populated from the bot's live /models roster. Choices persist to
 * localStorage on every change and ride the next /start in custom_data.
 */

import type { Capability, Models, Settings } from "../lib/types";
import { resolveChoice } from "../lib/settings";
import { Picker } from "./Picker";

const CAPS: { cap: Capability; label: string; hint: string }[] = [
  { cap: "llm", label: "Brain", hint: "Reasoning / chat model behind the replies." },
  { cap: "stt", label: "Speech-to-text", hint: "Transcribes your voice." },
  { cap: "tts", label: "Voice", hint: "Reads the replies aloud. Kokoro voices run locally." },
];

export function SettingsModal({
  models,
  settings,
  onChange,
  onClose,
}: {
  models: Models;
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
}) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Model settings">
        <h2 className="modal-title">Model settings</h2>
        <p className="modal-sub">Picked per session — they apply the next time you connect.</p>
        {CAPS.map(({ cap, label, hint }) => {
          const options = models[cap] ?? [];
          const value = resolveChoice(cap, options, settings);
          return (
            <div className="field" key={cap}>
              <label className="field-label" htmlFor={`set-${cap}`}>
                {label}
              </label>
              <Picker
                options={options}
                value={value}
                variant={cap === "tts" ? "grid" : "list"}
                onChange={(c) => onChange({ ...settings, [cap]: c })}
              />
              <p className="field-hint">{hint}</p>
            </div>
          );
        })}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

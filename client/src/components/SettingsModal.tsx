/**
 * The ⚙ panel: one custom picker per capability (Brain / Speech-to-text /
 * Voice), populated from the bot's live /models roster. Choices persist to
 * localStorage on every change and ride the next /start in custom_data.
 * The title-row reload button re-fetches the roster — when the bot was down
 * at page load the pickers show the built-in fallback list, and retrying
 * shouldn't cost a page refresh.
 */

import { RefreshCw } from "lucide-react";

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
  modelsLive,
  modelsLoading,
  onReloadModels,
  settings,
  onChange,
  onClose,
}: {
  models: Models;
  /** false when the roster came from the fallback list, not the bot. */
  modelsLive: boolean;
  modelsLoading: boolean;
  onReloadModels: () => void;
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
}) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Model settings">
        <div className="modal-head">
          <h2 className="modal-title">Model settings</h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onReloadModels}
            disabled={modelsLoading}
            title={modelsLive ? "Reload model list" : "Retry loading the model list"}
            aria-label="Reload model list"
          >
            <RefreshCw size={15} className={modelsLoading ? "spin" : ""} />
          </button>
        </div>
        <p className="modal-sub">Picked per session — they apply the next time you connect.</p>
        {!modelsLive && (
          <p className="modal-warn">
            Can't reach the bot — showing the built-in fallback list. Try reloading.
          </p>
        )}
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

/**
 * Per-session model choices, persisted in localStorage and sent in the RTVI
 * /start custom_data. Must mirror the server's run_bot defaults (not the
 * roster's first item) — roster order is arbitrary API order.
 */

import type { Capability, Choice, ModelOption, Models, Settings } from "./types";

const SETTINGS_KEY = "son.settings";

export const DEFAULT_CHOICES: Record<Capability, Choice> = {
  llm: { provider: "groq", id: "openai/gpt-oss-120b" },
  stt: { provider: "groq", id: "whisper-large-v3-turbo" },
  tts: { provider: "kokoro", id: "af_heart" },
};

// If the bot isn't running the picker still needs a usable roster.
export const FALLBACK_MODELS: Models = {
  llm: [{ provider: "groq", id: "openai/gpt-oss-120b", label: "openai/gpt-oss-120b" }],
  stt: [{ provider: "groq", id: "whisper-large-v3-turbo", label: "whisper-large-v3-turbo" }],
  tts: [
    { provider: "kokoro", id: "af_heart", label: "af_heart" },
    { provider: "kokoro", id: "af_bella", label: "af_bella" },
    { provider: "kokoro", id: "am_adam", label: "am_adam" },
    { provider: "kokoro", id: "bm_george", label: "bm_george" },
  ],
};

export function readSettings(): Settings {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveSettings(settings: Settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/** What the picker lands on: saved choice if still offered, else the default
 *  for the capability, else the first roster option. */
export function resolveChoice(
  cap: Capability,
  options: ModelOption[],
  saved?: Settings,
): Choice | null {
  const wanted = saved?.[cap] ?? DEFAULT_CHOICES[cap];
  if (wanted && options.some((o) => o.provider === wanted.provider && o.id === wanted.id)) {
    return wanted;
  }
  const first = options[0];
  return first ? { provider: first.provider, id: first.id } : null;
}

/** Group a roster by provider, preserving roster order. */
export function groupByProvider(options: ModelOption[]): [string, ModelOption[]][] {
  const map = new Map<string, ModelOption[]>();
  for (const o of options) {
    const list = map.get(o.provider) ?? [];
    list.push(o);
    map.set(o.provider, list);
  }
  return [...map.entries()];
}

export function optionLabel(o: ModelOption): string {
  return o.label && o.label !== o.id ? `${o.label} — ${o.id}` : o.id;
}

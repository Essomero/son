/** Shared types for the Son client. */

export interface Role {
  file: string;
  name: string;
  description: string;
}

/** One entry from the bot's /models roster: {provider, id, label}. */
export interface ModelOption {
  provider: string;
  id: string;
  label?: string;
}

/** A per-capability pick as stored in localStorage and sent in custom_data. */
export interface Choice {
  provider: string;
  id: string;
}

export interface Settings {
  llm?: Choice;
  stt?: Choice;
  tts?: Choice;
}

export type Capability = keyof Settings;

export type Models = Record<Capability, ModelOption[]>;

export type Phase = "idle" | "ready" | "connecting" | "connected" | "disconnected";

/** A transcript row. Mirrors the vanilla client's DOM-row semantics: */
export interface Msg {
  id: string;
  role: "user" | "bot";
  text: string;
  /** user rows: true once the STT final landed (or the text was typed). */
  final: boolean;
  /** user rows: the finalized text, so the next utterance appends to it
   *  instead of replacing it (the old dataset.base mechanism). */
  base: string;
}

/** Shared types for the Son client. */

export interface Role {
  file: string;
  name: string;
  description: string;
  /** Custom personas carry their markdown; built-in roles load server-side. */
  content?: string;
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

/** Output formats for the read page's Export panel (server-side ffmpeg). */
export type ExportFormat = "wav" | "mp3" | "m4a" | "opus";

export interface Settings {
  llm?: Choice;
  stt?: Choice;
  tts?: Choice;
  /** Read-page export prefs, persisted so the panel remembers them. */
  exportDir?: string;
  exportFormat?: ExportFormat;
  exportBitrate?: number;
  exportArtist?: string;
  exportAlbum?: string;
}

// The roster is keyed by capability only — export prefs above are not models.
export type Capability = "llm" | "stt" | "tts";

export type Models = Record<Capability, ModelOption[]>;

export type Phase = "idle" | "ready" | "connecting" | "connected" | "disconnected";

/** One row of the bot's /sessions list. */
export interface SessionMeta {
  id: string;
  name: string;
  role_file: string;
  role_name: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
  preview: string | null;
}

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
  /** user rows: one entry per landed final, newest last. The STT-cleanup
   *  stage resends a cleaned final with the raw final's timestamp, so a
   *  matching `ts` replaces the span in place instead of appending. */
  spans?: { ts?: string; text: string }[];
}

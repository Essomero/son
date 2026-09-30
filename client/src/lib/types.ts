/** Shared types for the Son client. */

export interface Role {
  file: string;
  name: string;
  description: string;
  /** Custom personas carry their markdown; built-in roles load server-side. */
  content?: string;
}

/** One entry from the bot's /models roster: {provider, id, label}.
 *  Cloud TTS entries may carry a `voice` (e.g. Orpheus voices); id is the
 *  model name there, so id alone can't round-trip the pick. */
export interface ModelOption {
  provider: string;
  id: string;
  label?: string;
  voice?: string;
}

/** A per-capability pick as stored in localStorage and sent in custom_data. */
export interface Choice {
  provider: string;
  id: string;
  voice?: string;
}

/** Output formats for the read page's Export panel (server-side ffmpeg). */
export type ExportFormat = "wav" | "mp3" | "m4a" | "opus";

/** Output containers the Tag page can write (server-side ffmpeg). */
export type TagFormat = "mp3" | "m4a" | "opus" | "ogg" | "flac" | "wav";

/** Whether the Tag page shows podcast or music metadata fields. */
export type TagMode = "podcast" | "music";

/** What the Tag page's ffprobe pass reports about an uploaded file. */
export interface TagInfo {
  name: string;
  size: number;
  /** Container as one of TagFormat, or null when ffmpeg can't write it back. */
  format: TagFormat | null;
  container: string;
  codec: string;
  duration: number;
  bitrate: number;
  sample_rate: number;
  channels: number;
  cover: boolean;
  tags: Record<string, string>;
}

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
  /** Tag-page prefs: the folder a season/album is written to, format, bitrate, and mode. */
  tagDir?: string;
  tagFormat?: TagFormat | "";
  tagBitrate?: number;
  tagMode?: TagMode;
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
  /** user rows (web-speech with cleanup on): the raw final is hidden behind
   *  a loading bubble until the cleaned text lands — never shown as-is. */
  pending?: boolean;
}

/** Shared shapes for the extension.

 *  Role / ModelOption / Choice mirror client/src/lib/types.ts on purpose: they
 *  are the contract with the server's /roles.json, /models roster and the RTVI
 *  /start custom_data. Two clients, one wire format.
 */

export interface Role {
  file: string;
  name: string;
  description: string;
  /** Custom personas carry their markdown (unused here: the extension picks
   *  from the server's roster, it doesn't import persona files). */
  content?: string;
}

export interface ModelOption {
  provider: string;
  id: string;
  label?: string;
  /** Cloud TTS entries carry the voice separately from the model id. */
  voice?: string;
}

export type Capability = "llm" | "stt" | "tts";

/** The roster keyed by capability, exactly as /models returns it. */
export type Models = Record<Capability, ModelOption[]>;

/** A per-capability pick, sent in custom_data as {provider, id[, voice]}. */
export interface Choice {
  provider: string;
  id: string;
  voice?: string;
}

export interface Choices {
  llm?: Choice;
  stt?: Choice;
  tts?: Choice;
}

export type Phase = "idle" | "connecting" | "connected" | "disconnected";

/** A transcript row — same merge semantics as the web client's Msg: a user row
 *  joins consecutive finals, a bot row absorbs streamed segments. */
export interface Msg {
  id: string;
  role: "user" | "bot";
  text: string;
  final: boolean;
  base: string;
  spans?: { ts?: string; text: string }[];
}

/** How much page text the panel is willing to carry (chars). */
export interface CaptureBudgets {
  selection: number;
  page: number;
}

/** What the in-page capture returns. */
export interface PageCapture {
  url: string;
  title: string;
  selection: string;
  /** The block the selection sits in (paragraph / code block / table cell). */
  selectionContext: string;
  selectionSource: string;
  page: string;
  pageSource: string;
}

export type CaptureResult = PageCapture | { error: string };

/** The two things a question can carry besides itself. Each is attached to the
 *  conversation on its own: page text for "what does this page say", the
 *  selection for "what does this bit mean" — together when narrowing down. */
export type ContextSource = "page" | "selection";

/** The panel's view of what the conversation is carrying right now. */
export interface ContextState {
  tone: "idle" | "live" | "empty" | "blocked";
  /** One line for the chip: "Article · 8.0k" or why there's nothing. */
  note: string;
  url: string;
  title: string;
  selection: string;
  page: string;
  selectionChars: number;
  pageChars: number;
  /** What the page capture picked, e.g. "article.markdown-body". */
  pageSource: string;
  /** Attached: the conversation already carries this exact text, so nothing is
   *  sent for it until it changes. Detached: the user turned the source off
   *  (the chip's ×) — it is not in the conversation and isn't sent. */
  attached: Record<ContextSource, boolean>;
  detached: Record<ContextSource, boolean>;
  /** The capture hit the page budget: raise it in settings to send it whole. */
  pageTruncated: boolean;
  takenAt: number;
}

export interface Settings {
  serverUrl: string;
  /** Instruction file from the server's instructions/ (shown as a role). */
  role: string;
  choices: Choices;
  /** Page-text budget in characters (the server caps the block again). */
  pageChars: number;
}

/** Set by the "Ask Son about the selection" right-click entry. */
export interface AskSelectionIntent {
  text: string;
  url: string;
  at: number;
}

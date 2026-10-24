import { newSessionId } from "./merge";
import type { ContextSource, Settings } from "./types";

/** Persistence. Settings live in chrome.storage.local (survive browser
 *  restarts, this is a personal tool), the conversation id in
 *  chrome.storage.session so each browser session starts a fresh chat instead
 *  of silently resuming yesterday's. */

const SETTINGS_KEY = "son:settings";
const SESSION_KEY = "son:session-id";
const ASK_KEY = "son:ask-selection";
const DETACHED_KEY = "son:detached";

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: "http://localhost:7860",
  serverToken: "",
  role: "default.md",
  // STT is pinned to browser Web Speech — the *default* on the server too, but
  // this half is the one that runs recognition, so it must know which provider
  // the session got: a session whose STT is web-speech and whose client never
  // recognizes anything hears nothing at all. Brain and voice stay unpicked
  // (the server's defaults).
  choices: { stt: { provider: "web-speech", id: "browser" } },
  // Generous on purpose: the page is attached to the conversation once, so the
  // cost is paid once — and "the whole page" is usually the point.
  pageChars: 20000,
};

export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as Partial<Settings> | undefined;
  const merged = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  // Per capability, so a settings object saved before the STT default existed
  // still gets it (a session with no stt pick would silently hear nothing).
  return { ...merged, choices: { ...DEFAULT_SETTINGS.choices, ...(stored?.choices ?? {}) } };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function loadSessionId(): Promise<string> {
  const stored = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY] as string | undefined;
  if (stored) return stored;
  const fresh = newSessionId();
  await chrome.storage.session.set({ [SESSION_KEY]: fresh });
  return fresh;
}

export async function saveSessionId(id: string): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEY]: id });
}

/** Which sources the user has switched off (the chip's ×). Session-scoped, like
 *  the conversation id: a reopened panel keeps the user's choices for the chat
 *  they are in, and a browser restart starts clean. */
export async function loadDetached(): Promise<Record<ContextSource, boolean>> {
  const stored = (await chrome.storage.session.get(DETACHED_KEY))[DETACHED_KEY] as
    | Partial<Record<ContextSource, boolean>>
    | undefined;
  return { page: stored?.page === true, selection: stored?.selection === true };
}

export async function saveDetached(state: Record<ContextSource, boolean>): Promise<void> {
  await chrome.storage.session.set({ [DETACHED_KEY]: state });
}

/** The right-click flow leaves its selection here for the panel to pick up. */
export async function takeAskSelectionIntent(): Promise<{ text: string; url: string; at: number } | null> {
  const stored = (await chrome.storage.session.get(ASK_KEY))[ASK_KEY] as
    | { text: string; url: string; at: number }
    | undefined;
  if (!stored) return null;
  await chrome.storage.session.remove(ASK_KEY);
  // Stale intents die: a right-click from an hour ago must not fire a question
  // the user has long forgotten about.
  return Date.now() - stored.at > 60_000 ? null : stored;
}

/**
 * Son-specific plumbing: endpoint resolution, error unwrapping, and the
 * transcript merge rules. The merge rules are a direct port of the vanilla
 * client's DOM logic (see the old src/app.js) — kept as pure functions.
 */

import type { Msg } from "./types";

const params = new URLSearchParams(location.search);
export const BOT_ENDPOINT = params.get("endpoint") || "http://localhost:7860/start";
const BOT_BASE = BOT_ENDPOINT.replace(/\/start$/, "");
export const MODELS_URL = BOT_BASE + "/models";
export const SESSIONS_URL = BOT_BASE + "/sessions";
export const SPEAK_URL = BOT_BASE + "/speak";
export const EXPORT_URL = BOT_BASE + "/export";
export const EXPORT_DEFAULTS_URL = BOT_BASE + "/export/defaults";
// Root-absolute like the others: the chat route /s/<id> puts the page at a
// different depth, so a relative "roles.json" would resolve under /s/... and
// 404. Every fetch must use these, not a bare relative path.
export const ROLES_URL = BOT_BASE + "/roles.json";
export const DEBUG = params.has("debug");

let uidCounter = 0;
export function uid(): string {
  uidCounter += 1;
  return `m${Date.now().toString(36)}-${uidCounter}`;
}

/**
 * client-js hands errors (in the onError callback AND in promise rejections)
 * an RTVIMessage whose readable text lives in different data fields depending
 * on where the error came from:
 *   - server error frames (a pipeline ErrorFrame → RTVI Error message):
 *       data = { error: <text>, fatal: <bool> }
 *   - client-side failures (startBotAndConnect HTTP/network):
 *       data = { message: <text>, fatal: true }
 * There is no .message on the object itself, so String(err) is "[object Object]".
 */
export function errorMessage(err: unknown): string {
  const data = (err as { data?: unknown })?.data ?? {};
  if (typeof data === "string") return data;
  const o = data as Record<string, unknown>;
  const text = o.error ?? o.message ?? o.code;
  if (typeof text === "string") return text;
  if (text && typeof text === "object") return JSON.stringify(text);
  return (err as { message?: string })?.message ?? String(err);
}

/**
 * One "You" row per consecutive user run: a new utterance (an STT segment or
 * a typed message) that follows a completed user row continues that row
 * instead of opening another. Partial STT frames grow the current utterance
 * in place; the finalized text is committed to `spans` and `base` is their
 * join, so the next utterance appends to it (partials of a fresh utterance
 * only ever replace their own span, not earlier ones).
 *
 * The STT-cleanup stage resends a cleaned final carrying the raw final's
 * timestamp: a final whose timestamp already exists in the row replaces
 * that span in place instead of appending a duplicate.
 */
export function mergeUserText(msgs: Msg[], text: string, final: boolean, ts?: string): Msg[] {
  if (!text) return msgs;
  const last = msgs[msgs.length - 1];
  if (last?.role === "user") {
    // Web-speech path: finals arrive WITHOUT a ts while the last row holds
    // the interim preview (no spans yet). Appending would duplicate the
    // text — finalize in place instead (a corrected final replaces the
    // preview).
    if (final && !ts && !last.final && !last.spans?.length) {
      return [
        ...msgs.slice(0, -1),
        { ...last, text, final: true, base: text, spans: [{ ts: undefined, text }] },
      ];
    }
    const spans = last.spans ?? [];
    if (final && ts) {
      const i = spans.findIndex((s) => s.ts === ts);
      if (i >= 0) {
        const next = [...spans];
        next[i] = { ...next[i], text };
        const base = next.map((s) => s.text).join(" ");
        return [...msgs.slice(0, -1), { ...last, spans: next, base, text: base, final: true }];
      }
    }
    const nextSpans = final ? [...spans, { ts, text }] : spans;
    const base = nextSpans.map((s) => s.text).join(" ");
    const nextText = base ? `${base} ${text}` : text;
    return [
      ...msgs.slice(0, -1),
      { ...last, spans: nextSpans, text: nextText, final: final || last.final, base },
    ];
  }
  const spans = final ? [{ ts, text }] : [];
  return [...msgs, { id: uid(), role: "user", text, final, base: final ? text : "", spans }];
}

/**
 * botOutput streams each reply as the LLM generates it. The server can send
 * the same segment text more than once: per sentence from the TTS side,
 * again from the LLM-response aggregator, possibly out of order. Merge
 * rules, in order:
 *   - empty row: take the first chunk
 *   - text already present as a prefix or suffix of the row (a duplicate
 *     segment): keep the row unchanged
 *   - text extends the current text (cumulative growth): replace
 *   - otherwise it's a genuinely new segment: append
 */
export function mergeBotText(msgs: Msg[], text: string, fresh = false): Msg[] {
  if (!text) return msgs;
  const last = msgs[msgs.length - 1];
  // fresh: a connection boundary — the bot speaks without an intervening
  // user row (the greeting, a resumed session's continuation, "Talk again").
  // Those must open their own bubble, not continue the last stored one.
  if (fresh || !last || last.role !== "bot") {
    return [...msgs, { id: uid(), role: "bot", text, final: true, base: "" }];
  }
  const cur = last.text;
  let next = cur;
  if (!cur) {
    next = text;
  } else if (cur.startsWith(text) || cur.endsWith(text)) {
    next = cur; // duplicate segment — already in the row
  } else if (text.startsWith(cur)) {
    next = text; // cumulative growth
  } else {
    next = `${cur} ${text}`; // genuinely new segment
  }
  return [...msgs.slice(0, -1), { ...last, text: next }];
}

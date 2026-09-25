import type { Msg } from "./types";

/** Transcript merge rules, ported from client/src/lib/son.ts — the server
 *  streams the same events to any client (partial/final STT, a cleaned final
 *  resent under the raw final's timestamp, and cumulative bot segments), so the
 *  rules are a contract, not a preference. */

let counter = 0;
export function uid(): string {
  counter += 1;
  return `m${counter}-${Date.now().toString(36)}`;
}

export function newSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* no crypto (shouldn't happen in an extension page) — fall through */
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * One "You" row per consecutive user run.
 *
 * A final carrying a timestamp that the row already holds replaces that span:
 * the server's STT-cleanup stage resends the cleaned utterance under the raw
 * final's timestamp, and both events must land as one row, not a duplicate.
 */
export function mergeUserText(msgs: Msg[], text: string, final: boolean, ts?: string): Msg[] {
  if (!text) return msgs;
  const last = msgs[msgs.length - 1];
  if (last?.role === "user") {
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
 * Words only, for comparing a segment against the row: the TTS-side copy of a
 * sentence reaches the client with markdown markers stripped ("stopped_at" →
 * "stoppedat"), so the literal prefix/suffix tests below would take it for new
 * text and the row would say everything twice. Unicode-aware so non-Latin
 * replies aren't normalized to nothing.
 */
function wordsOnly(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * botOutput streams each reply as the LLM generates it, and the server can send
 * the same segment more than once: per sentence from the TTS side, again from
 * the response aggregator, possibly out of order. Merge rules, in order:
 *   - empty row: take the first chunk
 *   - the row already contains this text (punctuation/case aside): duplicate
 *     segment — keep the row unchanged (this is what catches the cleaned
 *     "stoppedat" copy of a "stopped_at" reply)
 *   - text extends the current text (cumulative growth): replace
 *   - otherwise it's a genuinely new segment: append
 */
export function mergeBotText(msgs: Msg[], text: string, fresh = false): Msg[] {
  if (!text) return msgs;
  const last = msgs[msgs.length - 1];
  // fresh: a connection boundary — the bot speaks without an intervening user
  // row (the greeting, a resumed session's continuation). Those must open their
  // own bubble, not continue the last stored one.
  if (fresh || !last || last.role !== "bot") {
    return [...msgs, { id: uid(), role: "bot", text, final: true, base: "" }];
  }
  const cur = last.text;
  const curWords = wordsOnly(cur);
  const textWords = wordsOnly(text);
  let next: string;
  if (!cur) next = text;
  else if (!textWords || curWords.includes(textWords)) next = cur;
  else if (textWords.startsWith(curWords)) next = text;
  else next = `${cur} ${text}`;
  return [...msgs.slice(0, -1), { ...last, text: next }];
}

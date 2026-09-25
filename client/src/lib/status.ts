/**
 * The status line that says what the session is doing.
 *
 * The chat's header shows it and so does the settings panel — and the Read and
 * Speak pages render no header at all, so ⚙ is where you can still ask. One
 * derivation, two places: they must never disagree about whether Son is talking.
 */

import type { Phase } from "./types";

export function sessionStatus(phase: Phase, speaking: boolean, status: string): string {
  if (phase === "connected") return speaking ? "Son is speaking…" : "Connected — you can talk.";
  return status;
}

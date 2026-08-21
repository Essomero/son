/** Time formatting for the studio readouts. */

export function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}

/** Countdown format (room tone): m:ss with no rounding past 59. */
export function fmtCount(s: number): string {
  const m = Math.floor(s / 60);
  const ss = Math.min(59, Math.floor(s % 60));
  return `${m}:${String(ss).padStart(2, "0")}`;
}

/** Tape counter: h:mm:ss. */
export function fmtTape(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

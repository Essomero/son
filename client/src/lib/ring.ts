/**
 * Canvas renderer for the voice rings — the app's signature element. Bars
 * arranged in a circle around a center element, driven by real frequency
 * data from useAudioAnalyzer: user speech lights the mic button's ring, the
 * bot's speech lights the speaking message's avatar ring.
 */

export interface RingSpec {
  /** css size of the square canvas, px */
  size: number;
  /** inner radius of the bars, px */
  radius: number;
  /** bar thickness, px */
  thickness: number;
  /** bar length at silence / at full signal, px */
  minBar: number;
  maxBar: number;
  /** base bar color (per-bar alpha is derived from the level) */
  color: string;
  /** base opacity applied to every bar */
  alpha: number;
}

export function drawRing(
  canvas: HTMLCanvasElement,
  spec: RingSpec,
  bars: number[],
  muted = false,
) {
  const dpr = window.devicePixelRatio || 1;
  // Track the canvas's ACTUAL css size (it stretches with .mic-wrap in
  // narrow layouts) — drawing at the constant spec.size would leave the
  // ring centered on the wrong point and clip at the edges.
  const css = canvas.clientWidth || spec.size;
  const scale = css / spec.size;
  if (canvas.width !== Math.round(css * dpr) || canvas.height !== Math.round(css * dpr)) {
    canvas.width = Math.round(css * dpr);
    canvas.height = Math.round(css * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, css, css);

  // Muted = off: no ring at all, the dimmed icon carries the state.
  if (muted) return;

  ctx.lineCap = "round";

  const n = bars.length || 1;
  const cx = css / 2;
  const cy = css / 2;
  const rot = -Math.PI / 2;
  const radius = spec.radius * scale;
  const thickness = spec.thickness * scale;
  const minBar = spec.minBar * scale;
  const maxBar = spec.maxBar * scale;

  for (let i = 0; i < n; i++) {
    const v = bars[i] ?? 0;
    const ang = (i / n) * Math.PI * 2 + rot;
    const len = minBar + v * (maxBar - minBar);
    const r0 = radius;
    const r1 = radius + len;
    // Quiet at silence (a faint breathing ring), loud when you talk.
    ctx.globalAlpha = spec.alpha * (0.2 + 0.8 * v);
    ctx.strokeStyle = spec.color;
    ctx.lineWidth = thickness;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
    ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

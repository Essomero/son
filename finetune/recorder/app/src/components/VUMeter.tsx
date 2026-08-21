import { useEffect, useRef, type RefObject } from "react";

/** The instrument panel: SVG needle with real ballistics (fast rise, slow
 *  fall) + a peak flag, and the readouts column (REC state, timer, peak).
 *  Needle math ported from the pre-React recorder page. */

const VU = { cx: 110, cy: 106, r: 92, a0: -52, a1: 52, lo: -40, hi: 3 };
const NS = "http://www.w3.org/2000/svg";

interface VUMeterProps {
  rec: boolean;
  time: string;
  hot?: boolean;
  stateLabel: string;
  levelRef: RefObject<number>;
  needle?: boolean; // the room-tone modal runs readouts-only
}

function pt(a: number, r: number): [number, number] {
  return [
    VU.cx + r * Math.sin((a * Math.PI) / 180),
    VU.cy - r * Math.cos((a * Math.PI) / 180),
  ];
}

export function VUMeter({
  rec,
  time,
  hot,
  stateLabel,
  levelRef,
  needle = true,
}: VUMeterProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const needleRef = useRef<SVGLineElement | null>(null);
  const peakRef = useRef<SVGLineElement | null>(null);
  const pkRef = useRef<HTMLSpanElement>(null);
  const recRef = useRef(rec);
  recRef.current = rec;

  useEffect(() => {
    if (!needle || !svgRef.current) return;
    const svg = svgRef.current;
    const line = (x1: number, y1: number, x2: number, y2: number, w: number,
                  color: string, opacity = 1) => {
      const l = document.createElementNS(NS, "line");
      l.setAttribute("x1", String(x1)); l.setAttribute("y1", String(y1));
      l.setAttribute("x2", String(x2)); l.setAttribute("y2", String(y2));
      l.setAttribute("stroke", color); l.setAttribute("stroke-width", String(w));
      if (opacity !== 1) l.setAttribute("opacity", String(opacity));
      return l;
    };
    // scale arc + ticks + labels (static — drawn once)
    const [ax1, ay1] = pt(VU.a0, VU.r + 9);
    const [ax2, ay2] = pt(VU.a1, VU.r + 9);
    svg.append(line(ax1, ay1, ax2, ay2, 4, "url(#sheen)"));
    const majors = new Set([-20, -10, 0, 3]);
    for (let db = -40; db <= 3; db += 5) {
      const a = VU.a0 + ((db - VU.lo) / (VU.hi - VU.lo)) * (VU.a1 - VU.a0);
      const [x1, y1] = pt(a, VU.r);
      const [x2, y2] = pt(a, VU.r - (majors.has(db) ? 10 : 5));
      svg.append(line(x1, y1, x2, y2, 1, "#4a4035"));
      if (majors.has(db)) {
        const [lx, ly] = pt(a, VU.r - 21);
        const t = document.createElementNS(NS, "text");
        t.setAttribute("x", String(lx)); t.setAttribute("y", String(ly + 3));
        t.setAttribute("text-anchor", "middle");
        t.setAttribute("font-family", "IBM Plex Mono, monospace");
        t.setAttribute("font-size", "8.5"); t.setAttribute("fill", "#6e6355");
        t.textContent = db === 3 ? "+3" : String(db);
        svg.append(t);
      }
    }
    // needle + peak flag; JS rotates them around the pivot.
    const [hx, hy] = pt(VU.a0, VU.r - 34);
    const [px, py] = pt(VU.a0, VU.r - 30);
    needleRef.current = line(VU.cx, VU.cy, hx, hy, 2.5, "#e8a33d", 0.9);
    peakRef.current = line(VU.cx, VU.cy, px, py, 2, "#e2584b", 0.95);
    svg.append(needleRef.current, peakRef.current);
    const hub = document.createElementNS(NS, "circle");
    hub.setAttribute("cx", String(VU.cx)); hub.setAttribute("cy", String(VU.cy));
    hub.setAttribute("r", "4"); hub.setAttribute("fill", "#e8a33d");
    svg.append(hub);

    const dB = (r: number) => 20 * Math.log10(Math.max(r, 1e-5));
    let needleA = VU.a0, peakA = VU.a0, prev = performance.now(), raf = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      const lvl = levelRef.current ?? 0;
      const tgt = recRef.current
        ? VU.a0 + Math.min(1, Math.max(0, (dB(lvl) - VU.lo) / (VU.hi - VU.lo))) * (VU.a1 - VU.a0)
        : VU.a0;
      const k = tgt > needleA ? 1 - Math.exp(-dt * 18) : 1 - Math.exp(-dt * 2.2);
      needleA += (tgt - needleA) * k;
      if (tgt > peakA) peakA = tgt;
      else peakA = Math.max(VU.a0, peakA - dt * 9);
      if (needleRef.current)
        needleRef.current.setAttribute(
          "transform", `rotate(${needleA.toFixed(2)} ${VU.cx} ${VU.cy})`);
      if (peakRef.current)
        peakRef.current.setAttribute(
          "transform", `rotate(${peakA.toFixed(2)} ${VU.cx} ${VU.cy})`);
      if (pkRef.current)
        pkRef.current.textContent =
          recRef.current && dB(lvl) > -60 ? dB(lvl).toFixed(1) : "—";
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [needle, levelRef]);

  return (
    <div className={`panel${needle ? "" : " mini"}`}>
      {needle && (
        <div className="vuwrap">
          <svg ref={svgRef} className="vu" viewBox="0 0 220 118" role="img"
            aria-label="input level">
            <defs>
              <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#262019" />
                <stop offset="1" stopColor="#15110d" />
              </linearGradient>
            </defs>
          </svg>
        </div>
      )}
      <div className="reads">
        <div className={`recstat${rec ? " on" : ""}`}>
          <span className="dot"></span>
          <span>{stateLabel}</span>
        </div>
        <div className={`time${hot ? " hot" : ""}`}>{time}</div>
        <div className="pk">
          peak <b ref={pkRef}>—</b> db
        </div>
      </div>
    </div>
  );
}

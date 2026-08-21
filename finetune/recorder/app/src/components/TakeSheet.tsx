import { useEffect, useLayoutEffect, useRef } from "react";
import type { Prompt } from "../lib/api";

/** The keep-take sheet: one chip per prompt; kept cells are amber, the
 *  current cell has a cursor ring, ad-lib cells (batch-1 only) render free.
 *  Reports the measured column count up so the booth's arrow-key navigation
 *  can step by full rows. */

interface TakeSheetProps {
  prompts: Prompt[];
  done: (i: number) => boolean;
  taken: Map<number, number>;
  idx: number;
  onSelect: (i: number) => void;
  onCols: (n: number) => void;
}

export function TakeSheet({
  prompts,
  done,
  taken,
  idx,
  onSelect,
  onCols,
}: TakeSheetProps) {
  const gridRef = useRef<HTMLDivElement>(null);

  const measure = () => {
    const g = gridRef.current;
    if (!g) return;
    const chip = g.firstElementChild as HTMLElement | null;
    if (!chip) return;
    // Row-major flow (auto-fill columns): every chip on the first row
    // shares the first chip's offsetTop. Counting them is exact — no
    // division by a scroll-clamped clientHeight.
    let cols = 1;
    for (let i = 1; i < g.children.length; i++) {
      if ((g.children[i] as HTMLElement).offsetTop === chip.offsetTop) cols++;
      else break;
    }
    onCols(Math.max(1, cols));
  };

  useLayoutEffect(measure, [prompts.length]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompts.length]);

  // The sheet scrolls vertically — keep the cursor chip visible (landing
  // on a resumed session, or arrow-nav moving past the fold).
  useEffect(() => {
    const cur = gridRef.current?.children[idx] as HTMLElement | null;
    cur?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const hasFree = prompts.some((p) => !p.text);

  return (
    <section className="sheet">
      <div className="strip">
        <div className="title">
          Session takes
          <span className="legend">
            {hasFree && <span className="swatch free" />}
            {hasFree && <span>free cell (ad-lib)</span>}
            <span className="swatch" />
            <span>kept</span>
            <span className="swatch cur" />
            <span>here now</span>
          </span>
        </div>
        <div className="legend rt">
          <span className="kbd">→</span>
          <span className="kbd">←</span>
          <span className="kbd">↑</span>
          <span className="kbd">↓</span> move ·{" "}
          <span className="kbd">␣</span> record ·{" "}
          <span className="kbd">⏎</span> keep ·{" "}
          <span className="kbd">⌫</span> retake
        </div>
      </div>
      <div className="chips" ref={gridRef}>
        {prompts.map((p, i) => {
          const t = taken.get(i) ?? 0;
          const cls = [
            "chip",
            done(i) ? "done" : "",
            i === idx ? "cur" : "",
            !p.text ? "free" : "",
            done(i) && t > 1 ? "retaken" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={p.id}
              className={cls}
              title={
                `${p.text || "ad-lib — no script"}` +
                (done(i) ? ` · kept ${t}×` : "")
              }
              onClick={() => onSelect(i)}
            >
              <b>{String(i + 1).padStart(2, "0")}</b>
            </button>
          );
        })}
      </div>
    </section>
  );
}

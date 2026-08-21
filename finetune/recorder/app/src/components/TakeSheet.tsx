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
    const rows = Math.floor(g.clientHeight / chip.offsetHeight) || 1;
    onCols(Math.max(1, Math.ceil(g.children.length / rows)));
  };

  useLayoutEffect(measure, [prompts.length]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompts.length]);

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
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={p.id}
              className={cls}
              title={p.text || "ad-lib — no script"}
              onClick={() => onSelect(i)}
            >
              <b>{String(i + 1).padStart(2, "0")}</b>
              {done(i) && (
                <span className="ticks">
                  {"✓".repeat(Math.min(t, 3))}
                  {t > 3 ? `×${t}` : ""}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

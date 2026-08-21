import { useCallback, useEffect, useState } from "react";
import { api, type BatchDetail } from "../lib/api";

/** One batch's booth state: prompts, done map, cursor, keep/retake. */

export interface UseBatch {
  detail: BatchDetail | null;
  err: string | null;
  idx: number;
  taken: Map<number, number>; // prompt id -> re-records this session
  select: (i: number) => void;
  done: (i: number) => boolean;
  keep: (blob: Blob, dur: number) => Promise<boolean>;
  retake: () => void;
  reload: () => Promise<void>;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

export function useBatch(bid: string): UseBatch {
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [idx, setIdxRaw] = useState(0);
  const [taken, setTaken] = useState<Map<number, number>>(new Map());

  const reload = useCallback(async () => {
    try {
      const d = await api.batch(bid);
      setDetail(d);
      setErr(null);
      const saved = Number(localStorage.getItem(`son.studio.${bid}.idx`) || 0);
      setIdxRaw(clamp(saved, 0, Math.max(0, d.prompts.length - 1)));
    } catch (e) {
      setErr(String(e));
    }
  }, [bid]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const select = useCallback(
    (i: number) => {
      setIdxRaw(i);
      localStorage.setItem(`son.studio.${bid}.idx`, String(i));
    },
    [bid],
  );

  const done = useCallback(
    (i: number) => (detail ? i in detail.done : false),
    [detail],
  );

  const keep = useCallback(
    async (blob: Blob, dur: number): Promise<boolean> => {
      if (!detail) return false;
      const pr = detail.prompts[idx];
      const res = await api.uploadClip(bid, idx, pr?.text ?? "", dur, blob);
      if (!res.ok) return false;
      setDetail((d) =>
        d ? { ...d, done: { ...d.done, [idx]: dur } } : d,
      );
      setTaken((m) => new Map(m).set(idx, (m.get(idx) ?? 0) + 1));
      if (idx < detail.prompts.length - 1) select(idx + 1);
      return true;
    },
    [detail, idx, bid, select],
  );

  const retake = useCallback(() => {
    // Mark the cell for replacement — the next keep overwrites the file.
    setDetail((d) => {
      if (!d) return d;
      const next = { ...d.done };
      delete next[idx];
      return { ...d, done: next };
    });
  }, [idx]);

  return { detail, err, idx, taken, select, done, keep, retake, reload };
}

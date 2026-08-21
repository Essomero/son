import { useEffect, useState, type RefObject } from "react";
import { fmtClock } from "../lib/format";
import type { BatchMeta, Prompt } from "../lib/api";
import type { Recorder } from "../hooks/useRecorder";
import { VUMeter } from "./VUMeter";

/** The recording booth: prompt card, VU panel, REC/keep/retake controls and
 *  the preview area (staged blob, or the stored take once kept). */

interface BoothProps {
  meta: BatchMeta;
  prompt: Prompt | null;
  idx: number;
  total: number;
  done: boolean;
  rec: Recorder;
  audioRef: RefObject<HTMLAudioElement | null>;
  onKeep: () => void;
  onRetake: () => void;
  onBack: () => void;
}

const KIND_LABEL: Record<string, string> = {
  normal: "normal",
  quiet: "quiet",
  other: "other",
};

export function Booth({
  meta,
  prompt,
  idx,
  total,
  done,
  rec,
  audioRef,
  onKeep,
  onRetake,
  onBack,
}: BoothProps) {
  const [stagedSrc, setStagedSrc] = useState<string | null>(null);

  // Blob URL lifecycle: create on blob change, revoke the previous one.
  useEffect(() => {
    if (!rec.blob) {
      setStagedSrc(null);
      return;
    }
    const url = URL.createObjectURL(rec.blob);
    setStagedSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [rec.blob]);

  const kindLabel = KIND_LABEL[meta.kind] ?? meta.kind;
  const cat =
    prompt === null
      ? "ad-lib · no script"
      : prompt.category
        ? `${kindLabel} · ${prompt.category}`
        : kindLabel;

  const hot = rec.state === "rec" && rec.elapsed > meta.max_duration - 5;
  const time = rec.state === "rec" ? fmtClock(rec.elapsed) : "0:00";

  return (
    <main className="stage">
      <div className={`card${hot ? " hot" : ""}`}>
        <div className="catline">
          <span className={`cat${prompt?.text ? "" : " free"}`}>{cat}</span>
          {done && <span className="chip done">✓ kept</span>}
        </div>
        {prompt?.text ? (
          <p className="prompt">{prompt.text}</p>
        ) : (
          <p className="prompt free">
            No script for this cell — batch-1 from the old recorder. Say
            anything.
          </p>
        )}
        <div className="hint">
          {prompt?.text
            ? "Read it the way you'd actually say it to Son."
            : "Talk — about anything. Silence stops the take."}
          <span className="meta">
            take {idx + 1} of {total}
          </span>
        </div>
      </div>

      <VUMeter
        rec={rec.state === "rec"}
        time={time}
        hot={hot}
        stateLabel={rec.state === "rec" ? "REC" : "STANDBY"}
        levelRef={rec.levelRef}
      />

      <div className="controls">
        <button className="btn" onClick={onBack} disabled={idx === 0}>
          <span className="kbd">←</span> back
        </button>
        <button
          className="btn rec"
          onClick={() => {
            if (rec.state === "rec") void rec.stop();
            else void rec.start();
          }}
        >
          {rec.state === "rec" ? (
            <>
              <span className="kbd">␣</span> stop
            </>
          ) : rec.state === "staged" ? (
            <>
              <span className="kbd">␣</span> re-record
            </>
          ) : (
            <>
              <span className="kbd">␣</span> record
            </>
          )}
        </button>
        <button className="btn" disabled={!done || rec.state !== "idle"} onClick={onRetake}>
          <span className="kbd">⌫</span> retake
        </button>
        <button
          className="btn keep"
          disabled={rec.state !== "staged"}
          onClick={onKeep}
        >
          <span className="kbd">⏎</span> keep take
        </button>
      </div>

      {rec.state === "staged" && (
        <div className="preview">
          <div className="note">
            <b>Staged</b> — press <span className="kbd">⏎</span> to keep, or
            re-record to replace.
          </div>
          <audio controls src={stagedSrc ?? undefined} />
        </div>
      )}
      {rec.state !== "staged" && done && (
        <div className="preview">
          <div className="note">
            <b>Stored take</b> — on disk, waiting to be replaced if you retake.
          </div>
          <audio
            ref={audioRef}
            controls
            preload="metadata"
            src={`batch/${encodeURIComponent(meta.id)}/clip/${idx}`}
          />
        </div>
      )}
      {rec.state === "rec" && (
        <div className="preview">
          <div className="note">Recording… silence stops the take.</div>
        </div>
      )}
    </main>
  );
}

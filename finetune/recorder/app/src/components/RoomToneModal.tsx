import { useEffect, useRef, useState } from "react";
import { fmtCount } from "../lib/format";
import type { NoiseTake } from "../lib/api";
import type { Recorder } from "../hooks/useRecorder";
import { useFlash } from "../hooks/useFlash";
import { VUMeter } from "./VUMeter";

/** The room-tone booth: record ≥20 s of the room with no processing, then
 *  Keep — staged takes are lost on dismiss (with a warning), never silently. */

interface RoomToneModalProps {
  open: boolean;
  rec: Recorder;
  taken: NoiseTake | null;
  onKeep: () => void;
  onClose: () => void;
}

export function RoomToneModal({
  open,
  rec,
  taken,
  onKeep,
  onClose,
}: RoomToneModalProps) {
  const dlg = useRef<HTMLDialogElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const { flash, flashEl } = useFlash();
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

  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  // Modal dismissal (Esc / backdrop click / ✕): warn about staged takes.
  const dismiss = () => {
    const losing = rec.state === "staged" || rec.state === "rec";
    if (rec.state === "rec") void rec.stop();
    onClose();
    if (losing)
      flash("Take not saved — reopen Record silence and press Keep take.", true);
  };

  const togglePlay = () => {
    if (rec.state === "rec") {
      void rec.stop();
      return;
    }
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  };

  const primary = () => {
    if (rec.state === "rec") void rec.stop();
    else if (rec.state === "staged") onKeep();
    else void rec.start();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "Enter") {
        e.preventDefault();
        primary();
      } else if (e.code === "Backspace" || e.code === "KeyR") {
        e.preventDefault();
        if (rec.state === "rec") void rec.stop();
        else void rec.start();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rec.state]);

  const pending = rec.state === "staged";
  const countdown = fmtCount(180 - rec.elapsed);

  return (
    <dialog
      ref={dlg}
      className="dlg"
      onCancel={(e) => {
        e.preventDefault();
        dismiss();
      }}
      onClose={onClose}
    >
      <div className="dlghead">
        <span className="cat quiet">room tone</span>
        <button className="btn x" onClick={dismiss} aria-label="close">
          ✕
        </button>
      </div>
      <p className="prompt">The room, silent.</p>
      <div className="hint">
        Hold still for at least 20 seconds — this is the noise floor
        augmentation trains against.{" "}
        {taken && (
          <span className="ok">
            ✓ current tone kept · {taken.duration.toFixed(1)}s
          </span>
        )}
      </div>
      <div className="noise">
        <VUMeter
          needle={false}
          rec={rec.state === "rec"}
          time={countdown}
          hot={rec.state === "rec" && rec.elapsed > 175}
          stateLabel={rec.state === "rec" ? "REC" : "STANDBY"}
          levelRef={rec.levelRef}
        />
        <div className="controls">
          <button className="btn rec" onClick={primary}>
            <span className="kbd">␣</span>{" "}
            {rec.state === "rec"
              ? "stop"
              : rec.state === "staged"
                ? "re-record"
                : "record"}
          </button>
          <button className="btn keep" disabled={!pending} onClick={onKeep}>
            <span className="kbd">⏎</span> keep take
          </button>
        </div>
        {pending && (
          <div className="preview">
            <div className="note">
              <b>Staged</b> — press <span className="kbd">⏎</span> to keep.
              Closing without keeping discards this take.
            </div>
            <audio controls src={stagedSrc ?? undefined} />
          </div>
        )}
        {!pending && taken && (
          <div className="preview">
            <div className="note">
              <b>Current room tone</b> — {taken.duration.toFixed(1)}s.
            </div>
            <audio
              ref={audioRef}
              controls
              preload="metadata"
              src={`api/noise/${taken.id}`}
            />
          </div>
        )}
        {!pending && !taken && (
          <div className="preview">
            <div className="note">No room tone yet — record one.</div>
          </div>
        )}
      </div>
      {flashEl}
    </dialog>
  );
}

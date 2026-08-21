import { useEffect, useRef, useState } from "react";
import { api, type NoiseTake } from "../lib/api";
import { fmtTape } from "../lib/format";
import { useBatch } from "../hooks/useBatch";
import { useRecorder } from "../hooks/useRecorder";
import { useFlash } from "../hooks/useFlash";
import { Booth } from "../components/Booth";
import { TakeSheet } from "../components/TakeSheet";
import { RoomToneModal } from "../components/RoomToneModal";

/** The booth: prompt card + VU + controls on top, keep-take sheet below,
 *  room-tone modal off to the side. Keyboard: ␣ record/stop, ⏎ keep,
 *  ⌫ re-record, arrows move. */

export function BatchView({ bid, onExit }: { bid: string; onExit: () => void }) {
  const b = useBatch(bid);
  const maxS = b.detail?.meta.max_duration ?? 30;
  const rec = useRecorder({ kind: "speech", maxS, minS: 0.3 });
  const noise = useRecorder({ kind: "noise", maxS: 180, minS: 20 });
  const { flash, flashEl } = useFlash();
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [noiseOpen, setNoiseOpen] = useState(false);
  const [noiseTaken, setNoiseTaken] = useState<NoiseTake | null>(null);
  const [cols, setCols] = useState(1);

  useEffect(() => {
    api
      .noise()
      .then((t) => setNoiseTaken(t[0] ?? null))
      .catch(() => setNoiseTaken(null));
  }, []);

  // Drop reasons surface as toasts (too-short / mic blocked).
  useEffect(() => {
    if (rec.drop === "too-short")
      flash("Take too short — hold on a beat longer, then try again.", true);
    else if (rec.drop === "mic-blocked")
      flash("Microphone blocked — allow access in the browser, then try again.", true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.drop]);

  const nav = (delta: number) => {
    if (!b.detail) return;
    if (rec.state === "rec") void rec.stop();
    const n = Math.min(b.detail.prompts.length - 1, Math.max(0, b.idx + delta));
    b.select(n);
    if (audioRef.current) audioRef.current.pause();
  };

  const keep = async () => {
    if (!rec.blob) return;
    const keptIdx = b.idx;
    const dur = rec.blobDur;
    const ok = await b.keep(rec.blob, dur);
    if (!ok) {
      flash("Save failed — is the server up?", true);
      return;
    }
    rec.clear();
    flash(`Take ${keptIdx + 1} kept · ${dur.toFixed(1)}s`);
  };

  const noiseKeep = async () => {
    if (!noise.blob) return;
    const dur = noise.blobDur;
    try {
      await api.uploadNoise(dur, noise.blob);
    } catch (e) {
      flash(String(e), true);
      return;
    }
    noise.clear();
    setNoiseTaken({ id: 0, duration: dur });
    setNoiseOpen(false);
    flash(`Room tone kept · ${dur.toFixed(1)}s`);
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

  // Booth keyboard (deaf to the room-tone modal — it owns its own keys).
  useEffect(() => {
    if (noiseOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "Enter") {
        e.preventDefault();
        if (rec.state === "rec") void rec.stop();
        else if (rec.state === "staged") void keep();
        else void rec.start();
      } else if (e.code === "Backspace" || e.code === "KeyR") {
        e.preventDefault();
        if (rec.state === "rec") void rec.stop();
        else void rec.start();
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        nav(1);
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        nav(-1);
      } else if (e.code === "ArrowDown") {
        e.preventDefault();
        nav(cols);
      } else if (e.code === "ArrowUp") {
        e.preventDefault();
        nav(-cols);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  if (b.err)
    return (
      <main className="wrap">
        <div className="note err">
          {b.err} — <button className="btn ghost" onClick={() => void b.reload()}>retry</button>
        </div>
      </main>
    );
  if (!b.detail)
    return (
      <main className="wrap">
        <div className="note">Loading…</div>
      </main>
    );

  const d = b.detail;
  const prompt = d.prompts[b.idx] ?? null;

  return (
    <main className="wrap booth">
      <header className="top">
        <button className="btn" onClick={onExit}>
          ← batches
        </button>
        <div className="crumbs">
          <b>{d.meta.name}</b>
          <span className="meta">
            {Object.keys(d.done).length}/{d.prompts.length} takes ·{" "}
            {fmtTape(
              Object.values(d.done).reduce((s, x) => s + x, 0),
            )}{" "}
            on tape
          </span>
        </div>
        <button
          className={`btn${noiseTaken ? " has" : ""}${
            noise.state === "staged" ? " pending" : ""
          }`}
          onClick={() => setNoiseOpen(true)}
        >
          record silence{noiseTaken && <span className="dot" />}
          {noise.state === "staged" && <span className="bang">!</span>}
        </button>
      </header>

      <Booth
        meta={d.meta}
        prompt={prompt}
        idx={b.idx}
        total={d.prompts.length}
        done={b.done(b.idx)}
        rec={rec}
        audioRef={audioRef}
        onKeep={() => void keep()}
        onRetake={() => b.retake()}
        onBack={() => nav(-1)}
      />

      <TakeSheet
        prompts={d.prompts}
        done={b.done}
        taken={b.taken}
        idx={b.idx}
        onSelect={(i) => nav(i - b.idx)}
        onCols={setCols}
      />

      <RoomToneModal
        open={noiseOpen}
        rec={noise}
        taken={noiseTaken}
        onKeep={() => void noiseKeep()}
        onClose={() => setNoiseOpen(false)}
      />
      {flashEl}
    </main>
  );
}

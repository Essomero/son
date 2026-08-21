import { useEffect, useRef, useState, type RefObject } from "react";
import { captureToWav } from "../lib/audio";

/** Capture state machine, ported from the pre-React recorder page.
 *
 * start() opens the mic (raw PCM via ScriptProcessor), stop() encodes the
 * captured chunks to a 16 kHz WAV and stages the blob; the caller posts it
 * with keep() and then clears. Stopping a take is the user's call — the only
 * automatic stop is the hard maxS cap. Room tone IS silence, so it has no
 * level-based stop either; it just runs to maxS with a countdown.
 */

export type RecState = "idle" | "rec" | "staged";
export type DropReason = "too-short" | "mic-blocked" | null;

export interface RecConfig {
  kind: "speech" | "noise";
  maxS: number; // hard stop (speech: the batch's max_duration; noise: 180)
  minS: number; // shorter takes are rejected (speech: 0.3; noise: 20)
}

export interface Recorder {
  state: RecState;
  elapsed: number;
  blob: Blob | null;
  blobDur: number;
  levelRef: RefObject<number>;
  drop: DropReason;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  clear: () => void;
}

export function useRecorder(cfg: RecConfig): Recorder {
  const [state, setState] = useState<RecState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [blobDur, setBlobDur] = useState(0);
  const [drop, setDrop] = useState<DropReason>(null);
  const levelRef = useRef(0);

  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const recRef = useRef<{
    ctx: AudioContext;
    stream: MediaStream;
    proc: ScriptProcessorNode;
    src: MediaStreamAudioSourceNode;
    chunks: Float32Array<ArrayBuffer>[];
    t0: number;
  } | null>(null);
  const timerRef = useRef<number | null>(null);

  const stop = async () => {
    const r = recRef.current;
    if (!r) return;
    recRef.current = null;
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const dur = (performance.now() - r.t0) / 1000;
    try {
      r.proc.disconnect();
      r.src.disconnect();
    } catch {
      /* already torn down */
    }
    r.stream.getTracks().forEach((t) => t.stop());
    levelRef.current = 0;
    const samples = concat(r.chunks);
    if (samples.length < cfgRef.current.minS * 16000) {
      setDrop("too-short");
      setState("idle");
      return;
    }
    const wav = await captureToWav(samples, r.ctx.sampleRate);
    setBlob(wav);
    setBlobDur(dur);
    setState("staged");
  };

  const start = async () => {
    if (recRef.current) return;
    const { kind, maxS } = cfgRef.current;
    try {
      const ctx = new AudioContext();
      // Room tone must capture the real floor — no AGC / noise suppression.
      const opts =
        kind === "noise"
          ? {
              audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
              },
            }
          : {
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
            };
      const stream = await navigator.mediaDevices.getUserMedia(opts);
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      const chunks: Float32Array<ArrayBuffer>[] = [];
      const t0 = performance.now();
      proc.onaudioprocess = (e) => {
        const ch = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(ch));
        let s = 0;
        for (let i = 0; i < ch.length; i++) s += ch[i] * ch[i];
        levelRef.current = Math.sqrt(s / ch.length);
        if ((performance.now() - t0) / 1000 > maxS) void stop();
      };
      src.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      recRef.current = { ctx, stream, proc, src, chunks, t0 };
      setElapsed(0);
      setDrop(null);
      setState("rec");
      timerRef.current = window.setInterval(() => {
        const r = recRef.current;
        if (r) setElapsed((performance.now() - r.t0) / 1000);
      }, 100);
    } catch {
      setDrop("mic-blocked");
      setState("idle");
    }
  };

  const clear = () => {
    setBlob(null);
    setBlobDur(0);
    setState("idle");
  };

  useEffect(() => {
    // Unmount: close the mic if a capture is mid-flight.
    const r = recRef.current;
    if (r) {
      r.stream.getTracks().forEach((t) => t.stop());
      recRef.current = null;
    }
  }, []);

  return { state, elapsed, blob, blobDur, levelRef, drop, start, stop, clear };
}

function concat(chs: Float32Array<ArrayBuffer>[]): Float32Array<ArrayBuffer> {
  let n = 0;
  for (const c of chs) n += c.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const c of chs) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

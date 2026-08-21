/** Capture pipeline ported from the pre-React recorder page.
 *
 * Raw PCM via an AudioWorklet — ScriptProcessor ran on the main thread and
 * silently dropped chunks whenever the page janked, punching holes in takes
 * (the server's size/duration guard caught one as a 400). The worklet runs
 * on the audio thread; its postMessage queue absorbs main-thread jank by
 * delivering late instead of losing audio. Resampled by OfflineAudioContext
 * to 16 kHz, hand-encoded WAV (16-bit mono — whisper's native rate). */

export const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

// Buffers the 128-frame render quanta into 4096-frame chunks (~85 ms at
// 48 kHz) and ships each to the main thread.
const WORKLET_SRC = `
class CaptureProc extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(ch.length - i, this.buf.length - this.n);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === this.buf.length) {
        const out = this.buf.slice(0);
        this.port.postMessage(out, [out.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("capture", CaptureProc);
`;

export function captureWorkletUrl(): string {
  return URL.createObjectURL(
    new Blob([WORKLET_SRC], { type: "application/javascript" }),
  );
}

export function captureToWav(
  samples: Float32Array<ArrayBuffer>,
  fromRate: number,
): Promise<Blob> {
  const at16k =
    fromRate !== 16000 ? resample(samples, fromRate) : Promise.resolve(samples);
  return at16k.then(encodeWav);
}

async function resample(
  samples: Float32Array<ArrayBuffer>,
  fromRate: number,
): Promise<Float32Array<ArrayBuffer>> {
  const len = Math.round((samples.length * 16000) / fromRate);
  const off = new OfflineAudioContext(1, len, 16000);
  const buf = off.createBuffer(1, samples.length, fromRate);
  buf.copyToChannel(samples, 0);
  const node = off.createBufferSource();
  node.buffer = buf;
  node.connect(off.destination);
  node.start();
  return (await off.startRendering()).getChannelData(0);
}

function encodeWav(samples: Float32Array<ArrayBuffer>): Blob {
  const n = samples.length;
  const ab = new ArrayBuffer(44 + n * 2);
  const v = new DataView(ab);
  const ws = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ws(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  ws(8, "WAVE");
  ws(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ws(36, "data");
  v.setUint32(40, n * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const s = clamp(samples[i], -1, 1);
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Blob([ab], { type: "audio/wav" });
}

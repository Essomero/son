/** Studio API client — thin fetch wrappers over the recorder server. */

export interface Prompt {
  id: number;
  category?: string;
  text: string;
}

export interface BatchMeta {
  id: string;
  name: string;
  kind: "normal" | "quiet" | "other" | string;
  description: string;
  max_duration: number;
  prompt_source: string;
  include_in_training: boolean;
  archived: boolean;
  created: string;
}

export interface BatchStats {
  prompts: number;
  done: number;
  tape_s: number;
}

export interface Batch extends BatchMeta {
  stats: BatchStats;
}

export interface BatchDetail {
  meta: BatchMeta;
  prompts: Prompt[];
  done: Record<number, number>;
}

export interface NoiseTake {
  id: number;
  duration: number;
}

export interface CreateBatchInput {
  name: string;
  kind: string;
  description: string;
  max_duration: number;
  prompt_source: "reading_list" | "custom";
  custom_text?: string;
}

export type BatchPatch = Partial<
  Pick<BatchMeta, "name" | "kind" | "description" | "max_duration" | "include_in_training" | "archived">
>;

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const body = await r.json();
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON error body — keep the status text */
    }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

export const api = {
  batches: async () => {
    const r = await fetch("/batches");
    const body = await j<{ batches: Batch[] }>(r);
    return body.batches;
  },
  createBatch: async (input: CreateBatchInput) => {
    const r = await fetch("/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return j<{ ok: true; batch: BatchMeta }>(r);
  },
  patchBatch: async (bid: string, patch: BatchPatch) => {
    const r = await fetch(`/batch/${bid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return j<{ ok: true; batch: BatchMeta }>(r);
  },
  archiveBatch: async (bid: string) => {
    const r = await fetch(`/batch/${bid}/archive`, { method: "POST" });
    return j<{ ok: true }>(r);
  },
  batch: (bid: string) =>
    fetch(`/batch/${bid}`).then((r) => j<BatchDetail>(r)),
  uploadClip: async (
    bid: string,
    id: number,
    text: string,
    duration: number,
    blob: Blob,
  ) => {
    const form = new FormData();
    form.append("id", String(id));
    form.append("text", text);
    form.append("duration", duration.toFixed(2));
    form.append("file", blob, `clip_${String(id).padStart(4, "0")}.wav`);
    const r = await fetch(`/batch/${bid}/clip`, { method: "POST", body: form });
    return j<{ ok: true; id: number; duration: number }>(r);
  },
  noise: async () => {
    const r = await fetch("/noise");
    const body = await j<{ takes: NoiseTake[] }>(r);
    return body.takes;
  },
  uploadNoise: async (duration: number, blob: Blob) => {
    const form = new FormData();
    form.append("duration", duration.toFixed(2));
    form.append("file", blob, "noise_0000.wav");
    const r = await fetch("/noise", { method: "POST", body: form });
    return j<{ ok: true; id: number; duration: number }>(r);
  },
};

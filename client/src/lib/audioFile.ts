/**
 * Shared plumbing for the audio tools — the Read page's Export panel and the
 * Tag page. The sanitizer and shell-quoter mirror son.py's sanitize_stem /
 * shell_quote so the previewed ffmpeg command is the one the server runs; the
 * format tables mirror TAG_CODECS / TAG_LOSSLESS / TAG_COVER_FORMATS, and
 * buildTagPreview mirrors build_tag_args. Keep them in sync.
 */

import type { TagFormat } from "./types";

/** Shell-quote for a displayed ffmpeg command — always quotes, even without
 *  spaces: the command is copied into a shell, and an unquoted stray space or
 *  ':' is a silent break. */
export function shq(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** Same sanitize rule as son.py's sanitize_stem: ffmpeg reads a ':' in the
 *  output path as a protocol prefix, shell metacharacters break a copied
 *  command. ':' becomes '—', anything else that isn't letters/digits/space
 *  ._- folds to '-'. */
export function sanitizeStem(name: string): string {
  const stem = name.replace(/\.[^.]+$/, ""); // drop a trailing extension
  return (
    stem
      .replace(/[^A-Za-z0-9 ._:_-]+/g, "-")
      .replace(/\s+/g, " ")
      .replace(/:/g, "—")
      .replace(/^[. ]+|[. ]+$/g, "") || "reading"
  );
}

/** ffprobe's tag-key spellings → one canonical name, matching son.py's
 *  normalize_tag_key. Anything unknown keeps its folded form, so an extra tag
 *  the user typed round-trips as a real -metadata key. */
export function normalizeTagKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** "26.4 MB" */
export function fmtSize(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** "3:07" — also "1:02:03" for long recordings. */
export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h ? m.toString().padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${s.toString().padStart(2, "0")}`;
}

/** FastAPI's HTTPException detail is JSON {"detail": ...}; the error text is
 *  usually in there. Strip JSON markers for a human-readable message. */
export function parseError(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
  } catch {
    /* not JSON — raw text */
  }
  return body.slice(0, 300);
}

// --- Tag page tables (mirror the server's) --------------------------------

export const TAG_FORMATS: { value: TagFormat; label: string }[] = [
  { value: "mp3", label: "MP3" },
  { value: "m4a", label: "M4A (AAC)" },
  { value: "opus", label: "Opus" },
  { value: "ogg", label: "OGG (Vorbis)" },
  { value: "flac", label: "FLAC (lossless)" },
  { value: "wav", label: "WAV (uncompressed)" },
];

const TAG_CODECS: Record<TagFormat, string> = {
  mp3: "libmp3lame",
  m4a: "aac",
  opus: "libopus",
  ogg: "libvorbis",
  flac: "flac",
  wav: "pcm_s16le",
};

export const TAG_LOSSLESS: TagFormat[] = ["flac", "wav"];
export const TAG_COVER_FORMATS: TagFormat[] = ["mp3", "m4a"];
export const TAG_BITRATES = [64, 96, 128, 192, 256, 320];
export const TAG_SAMPLE_RATES = [22050, 32000, 44100, 48000];
export const TAG_CHANNELS = [1, 2];

/** Container → the reported format id, so "same as source" can resolve. */
export function isTagFormat(value: string | null | undefined): value is TagFormat {
  return TAG_FORMATS.some((f) => f.value === value);
}

/** The exact ffmpeg command the server will run for one Tag save — mirrors
 *  son.py's build_tag_args. `srcName` stands in for the temp file ffmpeg
 *  actually reads; the server's response echoes the real command after saving. */
export function buildTagPreview(args: {
  srcName: string;
  dst: string;
  format: TagFormat;
  tags: Record<string, string>;
  copyAudio: boolean;
  bitrate: number | null;
  sampleRate: number | null;
  channels: number | null;
  newCoverName: string;
  keepCover: boolean;
}): string {
  const { srcName, dst, format, tags, copyAudio, bitrate, sampleRate, channels } = args;
  const coverable = TAG_COVER_FORMATS.includes(format);
  const addCover = coverable && (args.newCoverName.trim() !== "" || args.keepCover);
  const parts = ["ffmpeg", "-y", "-i", srcName];
  if (args.newCoverName.trim() !== "") parts.push("-i", args.newCoverName.trim());
  parts.push("-map", "0:a");
  if (addCover) {
    if (args.newCoverName.trim() !== "") {
      parts.push("-map", "1:v", "-c:v", "copy", "-disposition:v", "attached_pic");
    } else {
      parts.push("-map", "0:v?", "-c:v", "copy", "-disposition:v", "attached_pic");
    }
  }
  if (copyAudio) {
    parts.push("-c:a", "copy");
  } else {
    parts.push("-c:a", TAG_CODECS[format]);
    if (!TAG_LOSSLESS.includes(format) && bitrate) parts.push("-b:a", `${bitrate}k`);
    if (sampleRate) parts.push("-ar", String(sampleRate));
    if (channels) parts.push("-ac", String(channels));
  }
  parts.push("-map_metadata", "-1");
  for (const [key, value] of Object.entries(tags)) {
    if (value && key !== "copyright") parts.push("-metadata", `${key}=${value}`);
  }
  if (format === "m4a") parts.push("-movflags", "+faststart");
  if (format === "mp3" && addCover) {
    parts.push("-id3v2_version", "3", "-metadata:s:v", "title=Album cover");
    parts.push("-metadata:s:v", "comment=Cover (front)");
  }
  parts.push(dst);
  return parts.map(shq).join(" ");
}

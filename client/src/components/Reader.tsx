/**
 * The "Read out" page: paste text, pick a voice, press Speak — no AI, no mic,
 * no session. A one-shot POST to /speak returns a WAV (synthesized locally by
 * Kokoro, or by whichever provider the voice picker selects); the player bar
 * below is plain HTMLMediaElement. Speed is playbackRate only — Kokoro's
 * service synthesizes at a hardcoded 1.0, so every provider answers at normal
 * speed and the player scales it, instantly, without re-synthesizing.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ClipboardPaste, Copy, Download, ImagePlus, Loader2, Pause, Play, RotateCcw, RotateCw, Sparkles, Undo2, Volume2, Wand2, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

import type { Choice, ExportFormat, Models, Settings } from "../lib/types";
import { resolveChoice } from "../lib/settings";
import { EXPORT_DEFAULTS_URL, EXPORT_URL, REWRITE_URL, SPEAK_URL } from "../lib/son";
import { cleanText } from "../lib/clean";
import { copyText, readClipboard } from "../lib/clipboard";
import { AUDIO_PROMPT } from "../lib/audioPrompt";
import { OptionPicker } from "./OptionPicker";
import { Picker } from "./Picker";

const MAX_CHARS = 8000; // mirrors _SPEAK_MAX_CHARS in son.py
const SPEEDS = [0.75, 1, 1.5, 2];
const EXPORT_BITRATES = [64, 96, 128, 192, 256]; // kbps — mirrors son.py

/** Shell-quote for the displayed ffmpeg command — always quotes, even
 *  without spaces: the command is copied into a shell, and an unquoted
 *  stray space or ':' is a silent break. */
function shq(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** Same sanitize rule as son.py's sanitize_stem: ffmpeg reads a ':' in the
 *  output path as a protocol prefix, shell metacharacters break a copied
 *  command. ':' becomes '—', anything else that isn't letters/digits/space
 *  ._- folds to '-'. */
function sanitizeStem(name: string): string {
  const stem = name.replace(/\.[^.]+$/, ""); // drop a trailing extension
  return (
    stem
      .replace(/[^A-Za-z0-9 ._:_-]+/g, "-")
      .replace(/\s+/g, " ")
      .replace(/:/g, "—")
      .replace(/^[. ]+|[. ]+$/g, "") || "reading"
  );
}

/** The command the server will run for this export (template: the WAV input
 *  is synthesized on the fly). Mirrors build_ffmpeg_args in son.py — keep
 *  them in sync; the server's response echoes the exact command after a save. */
function buildFfmpegPreview(args: {
  stem: string;
  dir: string;
  format: ExportFormat;
  bitrate: number;
  title: string;
  album: string;
  artist: string;
  /** Picked cover file name (the bytes are uploaded — no server path exists). */
  coverName: string;
}): string {
  const { stem, dir, format, bitrate, title, album, artist, coverName } = args;
  const out = `${dir.replace(/\/+$/, "")}/${stem}.${format}`;
  const parts = ["ffmpeg", "-y", "-i", "<synthesized.wav>"];
  const hasCover = coverName.trim() !== "" && format !== "opus";
  if (hasCover) parts.push("-i", coverName.trim());
  const codec = format === "mp3" ? "libmp3lame" : format === "m4a" ? "aac" : "libopus";
  parts.push("-c:a", codec, "-b:a", `${bitrate}k`);
  if (hasCover) {
    parts.push("-map", "0:a", "-map", "1:v", "-c:v", "copy", "-disposition:v", "attached_pic");
  } else {
    parts.push("-map", "0:a");
  }
  if (title) parts.push("-metadata", `title=${title}`);
  if (album) parts.push("-metadata", `album=${album}`);
  if (artist) parts.push("-metadata", `artist=${artist}`);
  if (format === "mp3" && hasCover) {
    parts.push("-id3v2_version", "3");
    parts.push("-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)");
  }
  parts.push(out);
  return parts.map(shq).join(" ");
}

/** "26.4 MB" */
function fmtSize(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`;
  return `${bytes} B`;
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * remark-math's flow math is fence-based: the $$ markers must sit on lines
 * of their own — otherwise a single-line $$…$$ parses as inline math, and
 * \(…\) / \[…\] aren't parsed at all (markdown eats the backslashes as
 * escapes). Normalize the common forms to what remark-math understands,
 * before ReactMarkdown sees them. The inserted fences are wrapped in blank
 * lines so they start their own lines even when the $$…$$ span was
 * mid-paragraph. Preview only: the textarea keeps the raw paste and the
 * spoken text comes from cleanText, which strips all four forms anyway.
 */
function normalizeMath(raw: string): string {
  // Function replacements, not $-strings: in a replacement string, $$ is an
  // escape for a literal $, which would collapse the fences to single $.
  return raw
    .replace(/\\\[[\s\S]*?\\\]/g, (m) => "\n$$\n" + m.slice(2, -2) + "\n$$\n")
    .replace(/\$\$([^$\n]+)\$\$/g, (m) => "\n$$\n" + m.slice(2, -2) + "\n$$\n")
    .replace(/\\\(([^)\n]*)\\\)/g, "$$$1$");
}

/** "Article title — part 2" → "article-title.wav" */
function audioName(text: string): string {
  const slug = cleanText(text)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "reading"}.wav`;
}

export function Reader({
  models,
  settings,
  onChangeVoice,
  onChangeSettings,
}: {
  models: Models;
  settings: Settings;
  onChangeVoice: (c: Choice) => void;
  onChangeSettings: (patch: Partial<Settings>) => void;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [clean, setClean] = useState(true); // strip markdown noise before speaking
  const [promptCopied, setPromptCopied] = useState(false);
  /** "Clean with AI": the brain rewriting the box with the audio prompt, and
   *  the text it replaced — a model edits sentences, so the local Clean toggle
   *  can't bring the original back. */
  const [aiBusy, setAiBusy] = useState(false);
  const [undoText, setUndoText] = useState<string | null>(null);

  // --- Export panel (server-side save + compress) --------------------------
  const [name, setName] = useState(""); // "" → default stem from the text
  const [dir, setDir] = useState(settings.exportDir ?? "");
  const [format, setFormat] = useState<ExportFormat>(settings.exportFormat ?? "mp3");
  const [bitrate, setBitrate] = useState(settings.exportBitrate ?? 128);
  const [title, setTitle] = useState("");
  const [album, setAlbum] = useState(settings.exportAlbum ?? "");
  const [artist, setArtist] = useState(settings.exportArtist ?? "");
  // Picked cover image (bytes are uploaded with the export — the browser
  // never reveals the file's path, so it can't be typed or referenced).
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const coverRef = useRef<HTMLInputElement>(null);
  const [ffmpegOk, setFfmpegOk] = useState(true);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<{ path: string; size: number } | null>(null);
  const [cmdCopied, setCmdCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);

  const audioRef = useRef<HTMLAudioElement>(null);
  const urlRef = useRef<string | null>(null);

  // The textarea keeps the raw paste; this is what Speak sends when Clean is
  // on. memoized — it runs on every keystroke (8k chars max, cheap).
  const cleaned = useMemo(() => cleanText(text.trim()), [text]);
  // Autoplay retry: armed while a fresh audio blob hasn't played yet, so the
  // retry only ever fires once per Speak. After the first play() the browser
  // trusts us and we never yank a user-initiated pause again.
  const unlockedRef = useRef(false);

  const voice = useMemo(() => resolveChoice("tts", models.tts ?? [], settings), [models, settings]);
  const canSpeak = !busy && text.trim().length > 0;

  // Export file name: the field overrides the same slug the browser download
  // uses (derived from the text); empty means "follow the text". Either way
  // it passes through sanitizeStem so the path and the copied command can't
  // break on ':' or shell metacharacters.
  const stem = name.trim() ? sanitizeStem(name) : audioName(text).replace(/\.wav$/, "");
  const canExport = !exportBusy && text.trim().length > 0;
  // The ffmpeg command preview (empty for wav — no compression happens).
  const preview =
    format === "wav"
      ? ""
      : buildFfmpegPreview({
          stem,
          dir: dir.trim() || "~/Downloads",
          format,
          bitrate,
          title: title.trim() || stem,
          album: album.trim(),
          artist: artist.trim(),
          coverName: coverFile ? coverFile.name : "",
        });

  // Prefill the folder from the server's detected download dir, and persist
  // it so the panel remembers it next time. Mount-only — clearing the field
  // means "use the server default" on the next load.
  useEffect(() => {
    let live = true;
    void fetch(EXPORT_DEFAULTS_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!live || !d) return;
        setFfmpegOk(Boolean(d.ffmpeg));
        if (!settings.exportDir && typeof d.dir === "string") {
          setDir(d.dir);
          onChangeSettings({ exportDir: d.dir });
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autoplay-policy insurance: the fetch between the click and play() can
  // cost the user-gesture context, so retry once on the next click anywhere.
  useEffect(() => {
    const retry = () => {
      if (unlockedRef.current) return;
      const el = audioRef.current;
      if (el && el.paused && el.src) void el.play().catch(() => {});
    };
    document.addEventListener("pointerdown", retry);
    return () => document.removeEventListener("pointerdown", retry);
  }, []);

  // Free the last blob URL on unmount.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  /** Flash a button to its "copied" state for ~1.5 s. */
  const flash = (setter: (v: boolean) => void) => {
    setter(true);
    window.setTimeout(() => setter(false), 1600);
  };

  const copyPrompt = () => void copyText(AUDIO_PROMPT).then(() => flash(setPromptCopied));
  const copyCommand = () => void copyText(preview).then(() => flash(setCmdCopied));

  /** Synthesize and play. `override` is the paste-and-read path: React hasn't
   *  re-rendered the textarea with the pasted text yet, so the caller hands the
   *  text over directly and cleaning applies to *that*, not to the memo. */
  const speak = async (override?: string) => {
    const source = (override ?? text).trim();
    const t = clean ? cleanText(source) : source;
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(SPEAK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: t, voice }),
      });
      if (!res.ok) {
        // FastAPI errors are plain text; a failed synthesis is a JSON 502.
        const body = await res.text().catch(() => "");
        setError(parseError(body) || `Speech failed (HTTP ${res.status}).`);
        return;
      }
      const blob = await res.blob();
      const el = audioRef.current;
      if (!el) return;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      el.src = url;
      el.playbackRate = speed;
      setTime(0);
      setDuration(0);
      unlockedRef.current = false;
      try {
        await el.play();
      } catch {
        setError("Playback needs a gesture — press play below.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Speech failed.");
    } finally {
      setBusy(false);
    }
  };

  /** Paste and read in one click. The click is also the user gesture
   *  `clipboard.readText` needs — which is exactly why this is a button and
   *  not an automatic paste when the page opens. */
  const pasteAndRead = async () => {
    setError(null);
    const clip = await readClipboard();
    if (clip === null) {
      setError("Clipboard blocked — press ⌘V in the box, or allow clipboard access for this site.");
      return;
    }
    const pasted = clip.trim().slice(0, MAX_CHARS);
    if (!pasted) {
      setError("The clipboard is empty.");
      return;
    }
    setText(pasted);
    await speak(pasted);
  };

  /** Rewrite the box for the ear with the configured brain, using the very
   *  prompt the Audio prompt button hands out — this is that workflow, minus the
   *  copy-into-an-LLM-and-paste-back round trip. */
  const cleanWithAi = async () => {
    const raw = text.trim();
    if (!raw || aiBusy) return;
    setAiBusy(true);
    setError(null);
    try {
      const res = await fetch(REWRITE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: raw,
          instruction: AUDIO_PROMPT,
          llm: settings.llm ?? undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        setError(parseError(body) || `Clean failed (HTTP ${res.status}).`);
        return;
      }
      const data = (await res.json()) as { text?: unknown };
      const next = typeof data.text === "string" ? data.text.trim() : "";
      if (!next) {
        setError("Clean returned nothing — try a different brain in settings.");
        return;
      }
      setUndoText(text);
      setText(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Clean failed.");
    } finally {
      setAiBusy(false);
    }
  };

  const undoAiClean = () => {
    if (undoText === null) return;
    setText(undoText);
    setUndoText(null);
  };

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el || !el.src) return;
    if (el.paused) {
      void el.play().catch(() => setError("Playback blocked — press play again."));
    } else {
      el.pause();
    }
  };

  const seekBy = (delta: number) => {
    const el = audioRef.current;
    if (el && el.duration) {
      el.currentTime = Math.min(Math.max(el.currentTime + delta, 0), el.duration);
    }
  };

  const applySpeed = (s: number) => {
    setSpeed(s);
    if (audioRef.current) audioRef.current.playbackRate = s;
  };

  const onSeek = (v: number) => {
    const el = audioRef.current;
    if (el && el.duration) el.currentTime = v;
    setTime(v);
  };

  /** Save (and compress) server-side into the folder of the user's choice.
   *  The server re-synthesizes the textarea — the browser can't write to an
   *  arbitrary path, so it asks the backend to. */
  const exportAudio = async () => {
    const t = clean ? cleaned : text.trim();
    if (!t || exportBusy) return;
    setExportBusy(true);
    setExportError(null);
    setExportResult(null);
    try {
      // The picked cover travels as base64 bytes — a browser never exposes a
      // file's real path, so the server can't look it up from a string.
      let coverData: string | undefined;
      if (coverFile) {
        coverData = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
          r.onerror = () => reject(r.error ?? new Error("Could not read the cover image."));
          r.readAsDataURL(coverFile);
        });
        if (!coverData) throw new Error("The cover image could not be read.");
      }
      const res = await fetch(EXPORT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: t,
          voice,
          filename: `${stem}.${format}`,
          dir: dir.trim() || undefined,
          format,
          bitrate,
          title: title.trim() || undefined,
          album: album.trim() || undefined,
          artist: artist.trim() || undefined,
          cover_data: coverData,
          cover_name: coverFile?.name,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        detail?: string;
        path?: string;
        size?: number;
      } | null;
      if (!res.ok) {
        setExportError(data?.detail || `Export failed (HTTP ${res.status}).`);
        return;
      }
      setExportResult({ path: data?.path ?? "", size: data?.size ?? 0 });
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setExportBusy(false);
    }
  };

  const downloadAudio = () => {
    const url = urlRef.current;
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${stem}.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <section className="reader">
      <div className="field">
        <label className="field-label" htmlFor="reader-voice">
          Voice
        </label>
        <Picker options={models.tts ?? []} value={voice} variant="grid" onChange={onChangeVoice} />
        <p className="field-hint">
          Kokoro voices synthesize on this machine — free and private. Speed is applied at
          playback, so you can change it any time without re-synthesizing.
        </p>
      </div>

      <div className="reader-tabs" role="tablist" aria-label="Text view" data-active={mode}>
        <div className="reader-tabs-thumb" aria-hidden />
        <button
          type="button"
          role="tab"
          aria-selected={mode === "write"}
          className={`tab-btn${mode === "write" ? " active" : ""}`}
          onClick={() => setMode("write")}
        >
          Write
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "preview"}
          className={`tab-btn${mode === "preview" ? " active" : ""}`}
          onClick={() => setMode("preview")}
        >
          Preview
        </button>
      </div>

      {mode === "write" ? (
        <>
          <textarea
            className="reader-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste or type something to read out…"
            aria-label="Text to read out"
            maxLength={MAX_CHARS}
          />
          <div className="reader-meta">
            <span>
              {text.trim().length.toLocaleString()} chars
              {clean && cleaned && cleaned.length < text.trim().length && (
                <> · {cleaned.length.toLocaleString()} will be read</>
              )}
            </span>
            <span>Max {MAX_CHARS.toLocaleString()}</span>
          </div>
        </>
      ) : (
        <div className="reader-preview">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
            {normalizeMath(text)}
          </ReactMarkdown>
        </div>
      )}

      <div className="reader-actions">
        <button
          type="button"
          className="btn ghost"
          onClick={() => void pasteAndRead()}
          title="Read the clipboard out loud: pastes it into the box and speaks it"
        >
          <ClipboardPaste size={14} aria-hidden />
          Paste &amp; read
        </button>
        <button
          type="button"
          className={`btn ghost reader-copy${promptCopied ? " copied" : ""}`}
          onClick={() => void copyPrompt()}
          title="Copy the audio-formatting prompt — paste it into any LLM with an article to get text that survives TTS"
          aria-label="Copy the audio-formatting prompt"
        >
          {promptCopied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          {promptCopied ? "Copied" : "Audio prompt"}
        </button>
        <button
          type="button"
          className={`btn ghost reader-clean${clean ? " active" : ""}`}
          onClick={() => setClean((v) => !v)}
          aria-pressed={clean}
          title={
            clean
              ? "Sending cleaned text — click to read the raw text as-is"
              : "Strip code, math, links and heading markers before speaking"
          }
        >
          <Wand2 size={14} aria-hidden />
          Clean
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => void cleanWithAi()}
          disabled={!text.trim() || aiBusy}
          title={`Rewrite the text for reading aloud with the brain${
            settings.llm ? ` (${settings.llm.provider} · ${settings.llm.id})` : ""
          } — the audio prompt, applied for you`}
        >
          {aiBusy ? <Loader2 size={14} className="spin" aria-hidden /> : <Sparkles size={14} aria-hidden />}
          {aiBusy ? "Cleaning…" : "Clean with AI"}
        </button>
        {undoText !== null && (
          <button
            type="button"
            className="btn ghost"
            onClick={undoAiClean}
            title="Put the text back the way it was before the AI clean"
          >
            <Undo2 size={14} aria-hidden />
            Undo
          </button>
        )}
        <button
          type="button"
          className="start-btn"
          onClick={() => void speak()}
          disabled={!canSpeak}
        >
          {busy ? <Loader2 size={17} className="spin" aria-hidden /> : <Volume2 size={17} aria-hidden />}
          {busy ? "Speaking…" : urlRef.current ? "Speak again" : "Speak"}
        </button>
      </div>

      {error && (
        <p className="reader-error" role="alert">
          {error}
        </p>
      )}

      {urlRef.current && (
        <div className="player">
          <input
            type="range"
            className="player-seek"
            min={0}
            max={duration || 0}
            step={0.1}
            value={time}
            onChange={(e) => onSeek(Number(e.target.value))}
            aria-label="Seek"
            disabled={!duration}
          />
          <div className="player-times">
            <span>{fmtTime(time)}</span>
            <span>{fmtTime(duration)}</span>
          </div>
          <div className="player-controls">
            <button
              type="button"
              className="icon-btn"
              onClick={() => seekBy(-10)}
              title="Rewind 10 s"
              aria-label="Rewind 10 seconds"
            >
              <RotateCcw size={16} />
            </button>
            <button
              type="button"
              className="player-play"
              onClick={togglePlay}
              title={playing ? "Pause" : "Play"}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => seekBy(10)}
              title="Skip 10 s"
              aria-label="Skip 10 seconds"
            >
              <RotateCw size={16} />
            </button>
            <div className="player-speeds" role="group" aria-label="Playback speed">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`speed-chip${speed === s ? " active" : ""}`}
                  onClick={() => applySpeed(s)}
                  aria-pressed={speed === s}
                >
                  {s}×
                </button>
              ))}
            </div>
            <button
              type="button"
              className="icon-btn player-download"
              onClick={downloadAudio}
              title="Download audio"
              aria-label="Download audio"
            >
              <Download size={16} />
            </button>
          </div>
        </div>
      )}

      {urlRef.current && (
          <section className="export-panel">
          <h3 className="export-heading">Save as audio</h3>
          <div className="export-grid">
            <label className="export-field">
              <span className="export-label">File name</span>
              <input
                className="text-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={stem}
                aria-label="File name"
              />
            </label>
            <div className="export-field">
              <span className="export-label">Format</span>
              <OptionPicker
                options={[
                  { value: "mp3", label: "MP3" },
                  { value: "m4a", label: "M4A (AAC)" },
                  { value: "opus", label: "Opus" },
                  { value: "wav", label: "WAV (no compression)" },
                ]}
                value={format}
                onChange={(v) => {
                  const f = v as ExportFormat;
                  setFormat(f);
                  onChangeSettings({ exportFormat: f });
                  if (f === "opus") setCoverFile(null); // Opus (OGG) can't hold cover art
                }}
                label="Format"
              />
            </div>
            <div className="export-field">
              <span className="export-label">Bitrate</span>
              <OptionPicker
                options={EXPORT_BITRATES.map((b) => ({ value: String(b), label: `${b} kbps` }))}
                value={String(bitrate)}
                onChange={(v) => {
                  const b = Number(v);
                  setBitrate(b);
                  onChangeSettings({ exportBitrate: b });
                }}
                label="Bitrate"
              />
            </div>
            <label className="export-field export-folder">
              <span className="export-label">Folder</span>
              <input
                className="text-input"
                value={dir}
                onChange={(e) => {
                  setDir(e.target.value);
                  onChangeSettings({ exportDir: e.target.value.trim() || undefined });
                }}
                placeholder="~/Downloads (detected)"
                aria-label="Folder"
              />
              <span className="field-hint">
                The server writes the file here — the folder is detected from the system, change it freely.
              </span>
            </label>
          </div>

          <details className="export-tags">
            <summary>Tags &amp; cover art</summary>
            <div className="export-grid">
              <label className="export-field">
                <span className="export-label">Title</span>
                <input
                  className="text-input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={stem}
                  aria-label="Title"
                />
              </label>
              <label className="export-field">
                <span className="export-label">Album</span>
                <input
                  className="text-input"
                  value={album}
                  onChange={(e) => {
                    setAlbum(e.target.value);
                    onChangeSettings({ exportAlbum: e.target.value.trim() || undefined });
                  }}
                  placeholder="Optional"
                  aria-label="Album"
                />
              </label>
              <label className="export-field">
                <span className="export-label">Artist</span>
                <input
                  className="text-input"
                  value={artist}
                  onChange={(e) => {
                    setArtist(e.target.value);
                    onChangeSettings({ exportArtist: e.target.value.trim() || undefined });
                  }}
                  placeholder="Optional"
                  aria-label="Artist"
                />
              </label>
              <label className="export-field export-cover">
                <span className="export-label">Cover art</span>
                <input
                  ref={coverRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    setCoverFile(e.target.files?.[0] ?? null);
                    e.target.value = ""; // allow re-picking the same file
                  }}
                />
                <div className="export-cover-row">
                  <button
                    type="button"
                    className="btn ghost export-cover-btn"
                    onClick={() => coverRef.current?.click()}
                    disabled={format === "opus"}
                    title={
                      format === "opus"
                        ? "Opus (OGG) can't hold cover art — use mp3 or m4a"
                        : "Pick an image from this computer"
                    }
                  >
                    <ImagePlus size={14} aria-hidden />
                    <span className="export-cover-name">{coverFile ? coverFile.name : "Choose image…"}</span>
                  </button>
                  {coverFile && (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setCoverFile(null)}
                      title="Remove cover art"
                      aria-label="Remove cover art"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                <span className="field-hint">
                  {format === "opus"
                    ? "Opus (OGG) can't hold cover art — use mp3 or m4a."
                    : "The image is uploaded with the export — mp3 and m4a embed it in the file."}
                </span>
              </label>
            </div>
          </details>

          {format !== "wav" && (
            <div className="export-cmd">
              <code>{preview}</code>
              <button
                type="button"
                className={`icon-btn export-copy${cmdCopied ? " copied" : ""}`}
                onClick={copyCommand}
                title="Copy the ffmpeg command"
                aria-label="Copy the ffmpeg command"
              >
                {cmdCopied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          )}

          <div className="export-actions">
            <button
              type="button"
              className="btn primary"
              onClick={() => void exportAudio()}
              disabled={!canExport}
              title={
                format === "wav"
                  ? "Save the raw WAV to the folder"
                  : "Synthesize, compress and tag the file on the server, then save it to the folder"
              }
            >
              {exportBusy ? (
                <Loader2 size={15} className="spin" aria-hidden />
              ) : (
                <Download size={15} aria-hidden />
              )}
              {exportBusy ? "Saving…" : "Save to folder"}
            </button>
          </div>

          {!ffmpegOk && format !== "wav" && (
            <p className="reader-error">
              <span>
                ffmpeg isn't installed on the server — only WAV can be saved here. Install it (e.g.{" "}
                <code>brew install ffmpeg</code>) to use MP3, M4A or Opus.
              </span>
            </p>
          )}

          {exportError && (
            <p className="reader-error" role="alert">
              {exportError}
            </p>
          )}

          {exportResult && (
            <p className="export-result" role="status">
              Saved <strong>{exportResult.path}</strong> ({fmtSize(exportResult.size)})
            </p>
          )}

        </section>
      )}

      <audio
        ref={audioRef}
        hidden
        onPlay={() => {
          setPlaying(true);
          unlockedRef.current = true;
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
      />
    </section>
  );
}

/** FastAPI's HTTPException detail is JSON {"detail": ...}; the error text is
 *  usually in there. Strip JSON markers for a human-readable message. */
function parseError(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
  } catch {
    /* not JSON — raw text */
  }
  return body.slice(0, 300);
}

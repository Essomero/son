/**
 * The "Read out" page: paste text, pick a voice, press Speak — no AI, no mic,
 * no session. A one-shot POST to /speak returns a WAV (synthesized locally by
 * Kokoro, or by whichever provider the voice picker selects); the player bar
 * below is plain HTMLMediaElement. Speed is playbackRate only — Kokoro's
 * service synthesizes at a hardcoded 1.0, so every provider answers at normal
 * speed and the player scales it, instantly, without re-synthesizing.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, Pause, Play, RotateCcw, RotateCw, Volume2, Wand2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

import type { Choice, Models, Settings } from "../lib/types";
import { resolveChoice } from "../lib/settings";
import { SPEAK_URL } from "../lib/son";
import { cleanText } from "../lib/clean";
import { Picker } from "./Picker";

const MAX_CHARS = 8000; // mirrors _SPEAK_MAX_CHARS in son.py
const SPEEDS = [0.75, 1, 1.5, 2];

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
}: {
  models: Models;
  settings: Settings;
  onChangeVoice: (c: Choice) => void;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [clean, setClean] = useState(true); // strip markdown noise before speaking
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

  const speak = async () => {
    const t = clean ? cleaned : text.trim();
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

  const downloadAudio = () => {
    const url = urlRef.current;
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = audioName(text);
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

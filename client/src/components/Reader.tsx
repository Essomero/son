/**
 * The "Read out" page: paste text, pick a voice, press Speak — no AI, no mic,
 * no session. A one-shot POST to /speak returns a WAV (synthesized locally by
 * Kokoro, or by whichever provider the voice picker selects); the player bar
 * below is plain HTMLMediaElement. Speed is playbackRate only — Kokoro's
 * service synthesizes at a hardcoded 1.0, so every provider answers at normal
 * speed and the player scales it, instantly, without re-synthesizing.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Pause, Play, RotateCcw, RotateCw, Volume2 } from "lucide-react";

import type { Choice, Models, Settings } from "../lib/types";
import { resolveChoice } from "../lib/settings";
import { SPEAK_URL } from "../lib/son";
import { Picker } from "./Picker";

const MAX_CHARS = 8000; // mirrors _SPEAK_MAX_CHARS in son.py
const SPEEDS = [0.75, 1, 1.5, 2];

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);

  const audioRef = useRef<HTMLAudioElement>(null);
  const urlRef = useRef<string | null>(null);
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
    const t = text.trim();
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

      <textarea
        className="reader-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste or type something to read out…"
        aria-label="Text to read out"
        maxLength={MAX_CHARS}
      />
      <div className="reader-meta">
        <span>{text.length.toLocaleString()} chars</span>
        <span>Max {MAX_CHARS.toLocaleString()}</span>
      </div>

      <div className="reader-actions">
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

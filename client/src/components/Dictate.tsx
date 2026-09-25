/**
 * The "Speak" side of the Read | Speak page: dictation with no AI, no session
 * and no server round-trip. Recognition runs in this tab — Chrome's Web Speech
 * API, the same engine the chat uses when its STT is `web-speech` — so the audio
 * never reaches Son, and every finished sentence is copied to the clipboard on
 * its way into the box. That copy is the point: dictate here, paste anywhere.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ClipboardCopy, Eraser, Loader2, Mic, Square, Wand2 } from "lucide-react";

import { useWebSpeech, webSpeechAvailable } from "../hooks/useWebSpeech";
import { copyText } from "../lib/clipboard";
import { cleanTranscript } from "../lib/son";

/** Why a recognizer died, in words a user can act on — the keys are the API's
 *  own error codes (see useWebSpeech). */
const FAILURE_HINT: Record<string, string> = {
  "not-allowed": "microphone access is blocked — allow the mic in the address bar",
  "service-not-allowed": "microphone access is blocked — allow the mic in the address bar",
  "audio-capture": "no microphone is available",
  network: "Chrome's speech service is unreachable (blocker, VPN, or offline)",
  unavailable: "this browser has no recognizer — Chrome or Edge only",
  "start-failed": "the recognizer would not start",
  "language-not-supported": "en-US isn't offered by this recognizer",
};

/** Codes that mean "stop asking": those other than these resolve by themselves
 *  (a barge-in abort, a silent stretch). */
const FATAL: Record<string, true> = {
  "not-allowed": true,
  "service-not-allowed": true,
  "audio-capture": true,
  unavailable: true,
  "start-failed": true,
  "language-not-supported": true,
};

/** Codes not worth a sentence in the UI — silence and barge-ins are normal. */
const QUIET: Record<string, true> = { "no-speech": true, aborted: true };

/** One utterance onto the end of the transcript. The box is editable, so what
 *  the user typed is never trimmed — only a doubled space at the seam avoided. */
function append(existing: string, addition: string): string {
  if (!existing) return addition.replace(/^\s+/, "");
  if (!addition) return existing;
  return /\s$/.test(existing) || /^\s/.test(addition) ? existing + addition : `${existing} ${addition}`;
}

export function Dictate() {
  const [text, setText] = useState("");
  const [interim, setInterim] = useState("");
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tidyBusy, setTidyBusy] = useState(false);
  const [supported] = useState(webSpeechAvailable);
  const textRef = useRef("");
  const copyTimer = useRef<number | null>(null);

  const setTextNow = useCallback((value: string): void => {
    textRef.current = value;
    setText(value);
  }, []);

  /** Copy the transcript and flash the button. The clipboard is this page's
   *  output, so a refused write has to be visible rather than silent. */
  const copy = useCallback(async (value: string): Promise<void> => {
    if (!value.trim()) return;
    const ok = await copyText(value);
    setCopied(ok);
    if (ok) setError(null);
    else setError("Couldn't reach the clipboard — press Copy, or select and ⌘C.");
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
  }, []);

  const onResult = useCallback(
    (chunk: string, final: boolean): void => {
      if (!final) {
        setInterim(chunk);
        return;
      }
      setInterim("");
      const joined = append(textRef.current, chunk);
      setTextNow(joined);
      void copy(joined);
    },
    [copy, setTextNow],
  );

  const onError = useCallback((reason: string): void => {
    if (QUIET[reason]) return;
    if (FATAL[reason]) setListening(false);
    setError(FAILURE_HINT[reason] ?? `recognition failed (${reason})`);
  }, []);

  // This panel *is* the page while it is mounted, so the mic follows the
  // listening flag alone; leaving for the Read page unmounts it, which stops the
  // recognizer in the hook's cleanup.
  useWebSpeech(onResult, listening && supported, undefined, onError);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const toggle = (): void => {
    setError(null);
    setListening((on) => !on);
  };

  /** The same normalizer the server runs on STT output (/cleanup), on demand —
   *  never automatically: it can take seconds, and dictation must not wait. */
  const tidy = async (): Promise<void> => {
    const raw = textRef.current.trim();
    if (!raw || tidyBusy) return;
    setTidyBusy(true);
    setError(null);
    try {
      const cleaned = (await cleanTranscript(raw)) || raw;
      if (cleaned.trim() === raw) {
        setError("Tidy left it alone — cleanup is off (STT_CLEANUP_MODEL) or found nothing to change.");
        return;
      }
      setTextNow(cleaned);
      void copy(cleaned);
    } finally {
      setTidyBusy(false);
    }
  };

  const live = listening;

  return (
    <section className="reader dictate">
      <textarea
        className="reader-text"
        value={text}
        onChange={(event) => setTextNow(event.target.value)}
        placeholder="Press the mic and talk — each finished sentence lands here, and on your clipboard…"
        aria-label="Dictated text"
        spellCheck={false}
      />
      <p className="dictate-interim" aria-live="polite">
        {interim}
      </p>
      <div className="reader-meta">
        <span>{text.trim() ? `${text.trim().length.toLocaleString()} chars` : "Empty"}</span>
        <span className={copied ? "dictate-copied" : ""}>
          {copied ? "copied to the clipboard" : "every finished sentence is copied as you go"}
        </span>
      </div>

      <div className="reader-actions">
        <button
          type="button"
          className={`btn ghost${copied ? " copied" : ""}`}
          onClick={() => void copy(textRef.current)}
          disabled={!text.trim()}
        >
          {copied ? <Check size={14} aria-hidden /> : <ClipboardCopy size={14} aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="btn ghost" onClick={() => void tidy()} disabled={!text.trim() || tidyBusy}>
          {tidyBusy ? <Loader2 size={14} className="spin" aria-hidden /> : <Wand2 size={14} aria-hidden />}
          Tidy
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            setTextNow("");
            setInterim("");
            setError(null);
          }}
          disabled={!text && !interim}
        >
          <Eraser size={14} aria-hidden />
          Clear
        </button>
        <button
          type="button"
          className={`start-btn${live ? " dictate-live" : ""}`}
          onClick={toggle}
          disabled={!supported}
        >
          {live ? <Square size={17} aria-hidden /> : <Mic size={17} aria-hidden />}
          {live ? "Stop" : "Start listening"}
        </button>
      </div>

      <p className="field-hint">
        {!supported
          ? "Dictation needs Chrome or Edge — this browser has no speech recognizer."
          : live
            ? "Listening — talk normally; a pause ends the sentence."
            : "Recognition runs in this tab. With Chrome's on-device language pack installed the audio stays on this machine; otherwise it goes to Google."}
      </p>
      {error && (
        <p className="reader-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

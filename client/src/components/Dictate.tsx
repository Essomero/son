/**
 * The "Speak" side of the Read | Speak page: dictation with no AI, no session
 * and no server round-trip. Recognition runs in this tab — Chrome's Web Speech
 * API, the same engine the chat uses when its STT is `web-speech` — so the audio
 * never reaches Son, and every finished sentence is copied to the clipboard on
 * its way into the box. That copy is the point: dictate here, paste anywhere.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, ClipboardCopy, Eraser, Info, Loader2, Wand2 } from "lucide-react";

import { useWebSpeech, webSpeechAvailable } from "../hooks/useWebSpeech";
import { useAudioAnalyzer } from "../hooks/useAudioAnalyzer";
import { useMicTrack } from "../hooks/useMicTrack";
import { MicButton } from "./MicButton";
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
  /** True between the recognizer's soundstart and soundend — what lights the ring. */
  const [soundActive, setSoundActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** What a manual Tidy reports when it changed nothing — information, not an
   *  error: "nothing to fix" is a fine outcome, not a failure. */
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tidyBusy, setTidyBusy] = useState(false);
  const [supported] = useState(webSpeechAvailable);
  const textRef = useRef("");
  const copyTimer = useRef<number | null>(null);
  const tidyingRef = useRef(false);

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
  // recognizer in the hook's cleanup. The ring is the chat's mic visual, and it
  // wants the same thing the chat gives it: a real track, so the bars are the
  // actual spectrum. Web Speech exposes no audio, so the page captures the mic
  // itself while listening (released again on mute) — the same double-capture
  // the chat runs with WebRTC. The recognizer's sound events stay wired as the
  // fallback for when that capture is refused.
  useWebSpeech(onResult, listening && supported, setSoundActive, onError);
  const micTrack = useMicTrack(listening && supported);
  const { subscribe } = useAudioAnalyzer({
    micTrack,
    active: supported,
    micPulse: soundActive,
  });

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const toggle = (): void => {
    setError(null);
    setNote(null);
    setListening((on) => !on);
    setSoundActive(false); // a lit ring must not outlive the listening
  };

  /** The server's STT normalizer (/cleanup) over what's in the box: punctuation,
   *  casing, fillers dropped, false starts resolved. With the local s1-mini this
   *  is ~0.2 s, so it also runs by itself the moment listening stops (below).
   *  `silent` keeps that automatic pass from reporting "nothing to change": a
   *  disabled or unreachable normalizer must not add noise to a fine dictation,
   *  while a press of the button is an explicit ask and deserves an answer. */
  const tidy = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}): Promise<void> => {
      const before = textRef.current;
      const raw = before.trim();
      if (!raw || tidyingRef.current) return;
      tidyingRef.current = true;
      setTidyBusy(true);
      if (!silent) {
        setError(null);
        setNote(null);
      }
      try {
        const answer = await cleanTranscript(raw);
        // Typing during the round trip wins: never replace newer text.
        if (textRef.current !== before) return;
        // "" means the endpoint did not answer — it 503s when
        // STT_CLEANUP_MODEL is unset, and timeouts (or a refused connection)
        // land here too. Anything else is a real answer that may simply match
        // what was already in the box.
        if (!answer) {
          if (!silent) {
            setNote(
              "Cleanup didn't answer — check STT_CLEANUP_MODEL, and that `son start cleanup` is running.",
            );
          }
          return;
        }
        if (answer.trim() === raw) {
          if (!silent) setNote("Nothing to fix — the text came back unchanged.");
          return;
        }
        setTextNow(answer);
        void copy(answer);
      } finally {
        tidyingRef.current = false;
        setTidyBusy(false);
      }
    },
    [copy, setTextNow],
  );

  // Tidy the moment listening stops: stopping is exactly when a dictation wants
  // its punctuation and false starts resolved, and the local model makes that
  // cheaper than reaching for the button.
  const wasListening = useRef(false);
  useEffect(() => {
    if (wasListening.current && !listening && textRef.current.trim()) {
      void tidy({ silent: true });
    }
    wasListening.current = listening;
  }, [listening, tidy]);

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

      {/* The chat's mic ring, which is also the page's start/pause: there is no
          session to mute here, so the same control does the whole job — muting
          pauses the recognition, unmuting carries on appending to the same
          text, and Clear is what starts a fresh one. */}
      <div className="dictate-mic">
        <MicButton
          subscribe={subscribe}
          muted={!listening}
          disabled={!supported}
          onToggle={toggle}
        />
        <p className="dictate-state" aria-live="polite">
          {live
            ? "Listening — click the mic to pause; your text stays."
            : "Paused — click the mic to carry on dictating."}
        </p>
      </div>
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
      </div>

      <p className="field-hint">
        {!supported
          ? "Dictation needs Chrome or Edge — this browser has no speech recognizer."
          : live
            ? "Listening — talk normally; a pause ends the sentence."
            : "Recognition runs in this tab. With Chrome's on-device language pack installed the audio stays on this machine; otherwise it goes to Google."}
      </p>
      {note && (
        <p className="reader-note" role="status">
          <Info size={13} aria-hidden />
          <span>{note}</span>
        </p>
      )}
      {error && (
        <p className="reader-error" role="alert">
          <CircleAlert size={13} aria-hidden />
          <span>{error}</span>
        </p>
      )}
    </section>
  );
}

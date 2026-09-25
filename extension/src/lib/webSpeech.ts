/**
 * Browser-side STT via the Web Speech API (Chrome/Edge: `SpeechRecognition` or
 * `webkitSpeechRecognition`). Recognized text arrives as events and the audio
 * never reaches the server — which is why a session on this provider has no
 * server-side STT service at all, and why the mic stays closed
 * (lib/mediaManager.ts: a track would only be sent for the server to ignore).
 *
 * Ported from the web client's useWebSpeech with one addition: `onFatal`. In a
 * page tab a dead recognizer costs that tab its transcription; here the session
 * *is* the panel, so the caller switches the session's STT provider instead of
 * leaving the user talking into nothing.
 *
 * The API ends on silence, so it restarts itself — with backoff, so a failing
 * engine doesn't spin — until the returned stop function runs.
 *
 * Trade-off worth knowing: recognition is Chrome's, i.e. Google's servers,
 * unless an on-device language pack is installed (the `processLocally` attempt
 * below). No download and no resident model is the point of this default; the
 * audio leaving the machine is its price.
 */

/** The slices of the API this module touches. The Web Speech API is not in the
 *  standard DOM lib, so the shape is declared here rather than cast per call. */
interface SpeechResult {
  isFinal: boolean;
  readonly [index: number]: { transcript?: string } | undefined;
}

interface SpeechResultEvent {
  resultIndex: number;
  results: { length: number; readonly [index: number]: SpeechResult | undefined };
}

interface SpeechErrorEvent {
  error?: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  /** Chrome extension: keep recognition on-device (needs a language pack). */
  processLocally?: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onsoundstart: (() => void) | null;
  onsoundend: (() => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionCtor {
  new (): SpeechRecognitionLike;
  /** Chrome extensions of the API: is an on-device pack available/installable? */
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
  install?: (options: { langs: string[] }) => Promise<boolean>;
}

export interface WebSpeechHandlers {
  /** An utterance segment. `final` marks one the engine considers done.
   *  Interims arrive too; this panel shows only finals. */
  onResult: (text: string, final: boolean) => void;
  /** The engine is dead in a way restarting won't fix (permission, no mic, no
   *  service). Fired once; the caller must stop this recognizer and switch. */
  onFatal: (reason: string) => void;
  /** Sound activity, for the listening indicator. */
  onSound?: (active: boolean) => void;
}

/** Errors that won't fix themselves by restarting: Chrome's two permanent ones,
 *  plus no-mic, no-service, no-language. `no-speech` (silence) and `aborted`
 *  (barge-in) are normal and swallowed. */
const FATAL_ERRORS: Record<string, true> = {
  "not-allowed": true,
  "service-not-allowed": true,
  "audio-capture": true,
  network: true,
  "language-not-supported": true,
};

/** Undeclared in lib.dom: read them off `window` through a stated cast. */
function recognitionCtor(): SpeechRecognitionCtor | null {
  const target = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return target.SpeechRecognition ?? target.webkitSpeechRecognition ?? null;
}

/** Is there a recognizer in this context at all? Chrome and Edge only. */
export function webSpeechSupported(): boolean {
  return recognitionCtor() !== null;
}

/** Start listening. Returns the stop function; `onFatal` means stop is moot. */
export function startWebSpeech(handlers: WebSpeechHandlers): () => void {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    handlers.onFatal("unavailable");
    return () => {};
  }
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";
  // Best-effort on-device recognition: with the language pack installed the
  // audio stays on this machine instead of going to Google.
  try {
    if (typeof Ctor.available === "function") {
      void Ctor.available({ langs: ["en-US"], processLocally: true })
        .then(async (status: string) => {
          if (status === "available") rec.processLocally = true;
          else if (status === "downloadable" || status === "downloading") {
            await Ctor.install?.({ langs: ["en-US"] });
          }
        })
        .catch(() => {
          /* leave it to the cloud engine */
        });
    }
  } catch {
    /* older Chrome: cloud recognition only */
  }

  let stopped = false;
  let restartTimer: number | null = null;
  /** Consecutive sessions that ended immediately: the backoff exponent. A
   *  result proves the engine is listening again, so it resets. */
  let quickEnds = 0;

  rec.onresult = (event) => {
    quickEnds = 0;
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const transcript = result?.[0]?.transcript;
      if (transcript) handlers.onResult(transcript, Boolean(result?.isFinal));
    }
  };
  rec.onsoundstart = () => handlers.onSound?.(true);
  rec.onsoundend = () => handlers.onSound?.(false);
  rec.onerror = (event) => {
    const reason = String(event?.error ?? "unknown");
    if (!FATAL_ERRORS[reason]) {
      // A dying engine's errors come in bursts (no-speech storms after a
      // barge-in): log everything but the routine silence case.
      if (reason !== "no-speech") console.warn("[son] Web Speech error:", reason);
      return;
    }
    console.warn(`[son] Web Speech fatal: ${reason}`);
    stopped = true;
    if (restartTimer !== null) window.clearTimeout(restartTimer);
    try {
      rec.stop();
    } catch {
      /* already stopped */
    }
    handlers.onFatal(reason);
  };
  rec.onend = () => {
    if (stopped) return;
    // stop() fires onend too, hence the flag. 0.6 s → 5 s while ends stay quick.
    const delay = Math.min(600 * 2 ** quickEnds, 5000);
    quickEnds += 1;
    restartTimer = window.setTimeout(() => {
      restartTimer = null;
      if (stopped) return;
      try {
        rec.start();
      } catch {
        /* already starting/stopping — the next onend retries */
      }
    }, delay);
  };

  try {
    rec.start();
  } catch (err) {
    // Starting can fail outright (an engine already running, a denied device):
    // that is a session with no STT, so let the caller fall back.
    console.warn("[son] Web Speech start failed:", err);
    stopped = true;
    handlers.onFatal("start-failed");
  }

  return () => {
    stopped = true;
    if (restartTimer !== null) window.clearTimeout(restartTimer);
    try {
      rec.stop();
    } catch {
      /* already stopped */
    }
  };
}

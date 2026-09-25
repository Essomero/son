/**
 * Browser-side STT via the Web Speech API (Chrome/Edge only — webkitSpeech-
 * Recognition). Transcriptions are delivered as text events; the mic audio
 * never reaches the server. The API stops on long silences, so `onend`
 * restarts unless we're stopping. Finals and interims go to `onResult`.
 */

import { useEffect, useRef } from "react";

type ResultHandler = (text: string, final: boolean) => void;

// The Web Speech API isn't in the standard TS DOM lib — access it untyped.
function speechRecognitionCtor(): any | null {
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/** Is there a recognizer in this browser at all? Chrome and Edge only. */
export function webSpeechAvailable(): boolean {
  return speechRecognitionCtor() !== null;
}

export function useWebSpeech(
  onResult: ResultHandler,
  enabled: boolean,
  onSound?: (active: boolean) => void,
  /** Every recognition error, by the API's own code. This hook only decides
   *  when to stop restarting; what a reason *means* is the caller's business. */
  onError?: (reason: string) => void,
) {
  const handlerRef = useRef(onResult);
  handlerRef.current = onResult;
  const soundRef = useRef(onSound);
  soundRef.current = onSound;
  const errorRef = useRef(onError);
  errorRef.current = onError;

  useEffect(() => {
    if (!enabled) return;
    const SR = speechRecognitionCtor();
    if (!SR) {
      console.warn("[Son] Web Speech API unavailable (Chrome/Edge only)");
      return;
    }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    // Best-effort on-device recognition (Chrome's processLocally): keeps the
    // audio on this machine when a language pack is installed. Otherwise
    // recognition stays server-based (cloud) and we kick off the pack
    // download — future sessions will be local too.
    try {
      if (typeof SR.available === "function") {
        void SR.available({ langs: ["en-US"], processLocally: true }).then(
          async (status: string) => {
            if (status === "available") {
              rec.processLocally = true;
            } else if (status === "downloadable" || status === "downloading") {
              console.log("[Son] Installing on-device speech pack (en-US)…");
              const ok = await SR.install({ langs: ["en-US"] });
              if (ok) console.log("[Son] On-device speech pack installed");
            }
          },
        );
      }
    } catch {
      /* older Chrome — cloud recognition only */
    }
    rec.onresult = (e: any) => {
      // Any result proves the engine is listening again — reset the
      // failed-restart counter and the per-burst error log.
      quickEnds = 0;
      for (let i = e.resultIndex; i < e.results.length; ++i) {
        const r = e.results[i];
        if (r?.[0]?.transcript) handlerRef.current(r[0].transcript, r.isFinal);
      }
    };
    // The mic waveform has no track to tap in this mode (enableMic=false),
    // so the UI drives its ring from these sound events instead.
    rec.onsoundstart = () => soundRef.current?.(true);
    rec.onsoundend = () => soundRef.current?.(false);
    rec.onerror = (e: any) => {
      const reason: string = e?.error ?? "unknown";
      errorRef.current?.(reason);
      // "not-allowed"/"service-not-allowed" is permanent — stop restarting.
      if (reason === "not-allowed" || reason === "service-not-allowed") {
        console.warn("[Son] Web Speech permission denied:", reason);
        rec.stop();
        return;
      }
      // A dying session's errors come in bursts (no-speech storms after
      // barge-ins) as the engine restarts; log the first of a burst only.
      if (reason !== "no-speech" || quickEnds === 0) {
        console.warn("[Son] Web Speech error:", reason);
      }
    };
    // The API ends on silence; restart to keep listening (onend fires after
    // stop() too, hence the flag). A burst of quick failed sessions backs
    // the restart off (0.6 s → 5 s) instead of churning the engine.
    let restarting = true;
    let quickEnds = 0;
    let restartTimer: number | null = null;
    rec.onend = () => {
      if (!restarting) return;
      const delay = Math.min(600 * 2 ** quickEnds, 5000);
      quickEnds += 1;
      restartTimer = window.setTimeout(() => {
        restartTimer = null;
        if (!restarting) return;
        try {
          rec.start();
        } catch {
          /* already starting/stopping — next onend will retry */
        }
      }, delay);
    };
    try {
      rec.start();
    } catch (e) {
      console.warn("[Son] Web Speech start failed:", e);
    }
    return () => {
      restarting = false;
      if (restartTimer !== null) window.clearTimeout(restartTimer);
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    };
  }, [enabled]);
}

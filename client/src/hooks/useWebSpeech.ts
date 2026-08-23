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

export function useWebSpeech(onResult: ResultHandler, enabled: boolean) {
  const handlerRef = useRef(onResult);
  handlerRef.current = onResult;

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
      for (let i = e.resultIndex; i < e.results.length; ++i) {
        const r = e.results[i];
        if (r?.[0]?.transcript) handlerRef.current(r[0].transcript, r.isFinal);
      }
    };
    rec.onerror = (e: any) => {
      // "not-allowed"/"service-not-allowed" is permanent — stop restarting.
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        console.warn("[Son] Web Speech permission denied:", e.error);
        rec.stop();
      } else {
        console.warn("[Son] Web Speech error:", e.error);
      }
    };
    // The API ends on silence; restart to keep listening (onend fires after
    // stop() too, hence the flag).
    let restarting = true;
    rec.onend = () => {
      if (restarting) {
        try {
          rec.start();
        } catch {
          /* already starting/stopping — next onend will retry */
        }
      }
    };
    try {
      rec.start();
    } catch (e) {
      console.warn("[Son] Web Speech start failed:", e);
    }
    return () => {
      restarting = false;
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    };
  }, [enabled]);
}

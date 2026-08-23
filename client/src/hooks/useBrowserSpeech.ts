/**
 * Browser-native TTS via speechSynthesis (Chrome's Google neural voices).
 * The LLM text already streams to the client, so the browser can speak it
 * itself — no server audio at all. speak() queues sentence-chunked
 * utterances with the chosen voice; cancel() stops everything (wire it to
 * user speech for barge-in and to disconnect). Voice resolution mirrors the
 * server roster (BROWSER_TTS_VOICES) with graceful fallbacks: exact Google
 * voice → any Google English voice → any English voice → the default.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { cleanText } from "../lib/clean";

const ID_TO_NAME: Record<string, string> = {
  "google-us-english": "Google US English",
  "google-uk-english-female": "Google UK English Female",
  "google-uk-english-male": "Google UK English Male",
};

function pickVoice(voiceId?: string): SpeechSynthesisVoice | null {
  const synth = window.speechSynthesis;
  const voices = synth.getVoices();
  if (!voices.length) return null;
  const exact = voiceId ? voices.find((v) => v.name === ID_TO_NAME[voiceId]) : undefined;
  if (exact) return exact;
  return (
    voices.find((v) => v.name.includes("Google") && v.lang.startsWith("en")) ??
    voices.find((v) => v.lang.startsWith("en")) ??
    null
  );
}

export function useBrowserSpeech(enabled: boolean, voiceId?: string) {
  const [speaking, setSpeaking] = useState(false);
  const pendingRef = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const markEnd = useCallback(() => {
    pendingRef.current = Math.max(0, pendingRef.current - 1);
    if (pendingRef.current === 0) setSpeaking(false);
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!enabledRef.current || !text.trim()) return;
      const synth = window.speechSynthesis;
      if (!synth) return;
      const voice = pickVoice(voiceId);
      // Sentence-chunk so speech starts streaming in as the reply grows
      // (each utterance also resets Chrome's ~15s speech-synthesis pause).
      const sentences = text.split(/(?<=[.!?…])\s+/).filter(Boolean);
      for (const s of sentences) {
        const u = new SpeechSynthesisUtterance(cleanText(s));
        if (voice) u.voice = voice;
        u.rate = 1.0;
        u.onstart = () => {
          pendingRef.current += 1;
          setSpeaking(true);
        };
        u.onend = markEnd;
        u.onerror = markEnd;
        synth.speak(u);
      }
    },
    [voiceId, markEnd],
  );

  const cancel = useCallback(() => {
    pendingRef.current = 0;
    setSpeaking(false);
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* already stopped */
    }
  }, []);

  // Stop everything when the mode turns off or the hook unmounts.
  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);

  return { speak, cancel, speaking };
}

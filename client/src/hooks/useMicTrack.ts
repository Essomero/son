/**
 * A mic track for the page's own ring, while `enabled`.
 *
 * The Web Speech API hands out no audio, so the Speak page captures the device
 * itself to get real spectrum bars. That is the same double-capture the chat
 * already does — pipecat's WebRTC holds the mic while the recognizer runs — so
 * it is a proven shape rather than a new trick. Released the moment dictation
 * pauses: no stream outlives the ring that wants it.
 */

import { useEffect, useState } from "react";

export function useMicTrack(enabled: boolean): MediaStreamTrack | null {
  const [track, setTrack] = useState<MediaStreamTrack | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let stream: MediaStream | null = null;
    let cancelled = false;

    void navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        setTrack(s.getAudioTracks()[0] ?? null);
      })
      .catch((e: unknown) => {
        // Refused or unavailable: the ring falls back to the recognizer's
        // sound events, so the page still works — only less pretty.
        console.warn("[Son] mic capture for the ring failed:", e);
      });

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      setTrack(null);
    };
  }, [enabled]);

  return track;
}

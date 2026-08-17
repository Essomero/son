/**
 * The mute/unmute control: a mic icon button whose ring visualizes the
 * user's live mic audio (real AnalyserNode data — talking lights it up).
 * Muting dims the ring and swaps Mic for MicOff.
 */

import { useEffect, useRef } from "react";
import { Mic, MicOff } from "lucide-react";

import type { LevelSubscriber } from "../hooks/useAudioAnalyzer";
import { drawRing } from "../lib/ring";

const RING = { size: 132, radius: 47, thickness: 2.5, minBar: 2, maxBar: 22, color: "#ef9f43", alpha: 0.85 };

export function MicButton({
  subscribe,
  muted,
  disabled,
  onToggle,
}: {
  subscribe: (kind: "mic", cb: LevelSubscriber) => () => void;
  muted: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const ringRef = useRef<HTMLCanvasElement>(null);
  const mutedRef = useRef(muted);
  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    return subscribe("mic", ({ bars }) => {
      if (ringRef.current) drawRing(ringRef.current, RING, bars, mutedRef.current);
    });
  }, [subscribe]);

  return (
    <div className="mic-wrap">
      <canvas ref={ringRef} className="mic-ring" aria-hidden />
      <button
        type="button"
        className={`mic-btn${muted ? " muted" : ""}`}
        onClick={onToggle}
        disabled={disabled}
        title={muted ? "Unmute microphone" : "Mute microphone"}
        aria-label={muted ? "Unmute microphone" : "Mute microphone"}
        aria-pressed={!muted}
      >
        {muted ? <MicOff size={24} /> : <Mic size={24} />}
      </button>
    </div>
  );
}

/**
 * One shared Web-Audio pipeline feeding the voice rings: the local mic track
 * and the bot's audio element each get an AnalyserNode; a single rAF loop
 * samples frequency data and notifies subscribers (canvas drawers) with a
 * per-frame 0..1 level and a bar array.
 *
 * The mic analyser taps the live MediaStreamTrack WITHOUT consuming it — the
 * track still flows to the WebRTC transport. The bot analyser is inserted via
 * createMediaElementSource, which reroutes the audio element through the
 * context: the chain must reach ctx.destination or the bot falls silent.
 *
 * The AudioContext is created lazily on first `active` frame (right after the
 * connect click, so autoplay policy is satisfied) and kept for the session.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type LevelData = { level: number; bars: number[] };
export type LevelSubscriber = (data: LevelData) => void;

const BAR_COUNT = 44;

interface AnalyzerOpts {
  /** The user's live mic track (null when not connected). */
  micTrack: MediaStreamTrack | null;
  /** Ref to the hidden <audio> element playing the bot's WebRTC track
   *  (resolved inside the effect, after the element has mounted). */
  botAudio: { current: HTMLAudioElement | null };
  /** Whether the session is live (the loop runs only while connected). */
  active: boolean;
}

export function useAudioAnalyzer({ micTrack, botAudio: botAudioRef, active }: AnalyzerOpts) {
  const [subscribers] = useState(() => ({
    mic: new Set<LevelSubscriber>(),
    bot: new Set<LevelSubscriber>(),
  }));

  const ctxRef = useRef<AudioContext | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const botAnalyserRef = useRef<AnalyserNode | null>(null);
  const botSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const rafRef = useRef<number>(0);

  const subscribe = useCallback(
    (kind: "mic" | "bot", cb: LevelSubscriber) => {
      subscribers[kind].add(cb);
      return () => {
        subscribers[kind].delete(cb);
      };
    },
    [subscribers],
  );

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    // Lazy context; resume() covers the (rare) case where the effect runs
    // before the browser grants the gesture.
    if (!ctxRef.current) {
      try {
        ctxRef.current = new AudioContext();
      } catch (e) {
        console.warn("[Son] AudioContext unavailable:", e);
        return;
      }
    }
    const ctx = ctxRef.current;
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});

    // Bot chain — built once, persists for the element's lifetime.
    const botAudio = botAudioRef.current;
    if (botAudio && !botSourceRef.current) {
      try {
        const source = ctx.createMediaElementSource(botAudio);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.72;
        source.connect(analyser);
        analyser.connect(ctx.destination);
        botSourceRef.current = source;
        botAnalyserRef.current = analyser;
      } catch (e) {
        console.warn("[Son] bot audio chain failed:", e);
      }
    }

    // Mic chain — rebuilt whenever the track changes.
    if (micTrack) {
      try {
        if (micSourceRef.current) micSourceRef.current.disconnect();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.72;
        const source = ctx.createMediaStreamSource(new MediaStream([micTrack]));
        source.connect(analyser);
        micSourceRef.current = source;
        micAnalyserRef.current = analyser;
      } catch (e) {
        console.warn("[Son] mic audio chain failed:", e);
        micAnalyserRef.current = null;
      }
    }

    const sample = (analyser: AnalyserNode | null): LevelData => {
      const data = new Uint8Array(analyser ? analyser.frequencyBinCount : 0);
      if (analyser) analyser.getByteFrequencyData(data);
      const bars = new Array<number>(BAR_COUNT);
      let sum = 0;
      for (let i = 0; i < BAR_COUNT; i++) {
        const v = data.length ? data[Math.floor((i / BAR_COUNT) * data.length)] / 255 : 0;
        bars[i] = v;
        sum += v;
      }
      return { level: data.length ? sum / BAR_COUNT : 0, bars };
    };

    const loop = () => {
      if (cancelled) return;
      if (subscribers.mic.size) {
        const d = sample(micAnalyserRef.current);
        for (const cb of subscribers.mic) cb(d);
      }
      if (subscribers.bot.size) {
        const d = sample(botAnalyserRef.current);
        for (const cb of subscribers.bot) cb(d);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      if (micSourceRef.current) {
        micSourceRef.current.disconnect();
        micSourceRef.current = null;
      }
      micAnalyserRef.current = null;
    };
  }, [active, micTrack, botAudioRef, subscribers]);

  return { subscribe };
}

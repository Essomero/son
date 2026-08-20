#!/usr/bin/env python3
"""Input audio filters for Son: the "clean and magnify" stage.

Cloud STT providers denoise and normalize loudness before the model ever
sees audio; the local path gets raw mic audio and is expected to cope.
Soft speech is where it breaks: the voice drops toward a constant room
noise floor and the SNR collapses.

These filters sit on the transport's audio-in path (TransportParams
audio_in_filter), BEFORE VAD and every STT provider:

  RNNoiseFilter   — neural noise suppression (pipecat's, open-source)
  GainAGCFilter   — quiet-speech AGC: normalizes level toward a target
                    RMS with a noise gate (silence is not amplified) and
                    a max-gain cap, so the downstream STT/VAD always see
                    audio near the level they were trained on.

Env knobs (all optional):
  SON_DENOISE       1|0 — noise suppression on/off (default on when the
                         pipecat rnnoise extra is installed)
  SON_AGC           1|0 — quiet-speech AGC on/off (default on)
  SON_AGC_TARGET_DB target level in dBFS (default -22)
  SON_AGC_MAX_DB    max gain in dB (default +18)
  SON_AGC_GATE_DB   below this input level the gain stays 1 (default -45)
"""

import os

import numpy as np

from pipecat.audio.filters.base_audio_filter import BaseAudioFilter
from pipecat.audio.filters.rnnoise_filter import RNNoiseFilter
from pipecat.frames.frames import FilterControlFrame, FilterEnableFrame


def repeat_phrase(text: str) -> bool:
    """True when any 2+ word n-gram repeats verbatim — the whisper
    repetition-loop signature ("I'm just chilling I'm just chilling")."""
    words = text.lower().split()
    if len(words) < 4:
        return False
    for n in range(2, min(len(words) // 2, 8) + 1):
        for i in range(len(words) - n + 1):
            gram = tuple(words[i : i + n])
            if gram and tuple(words[i + n : i + 2 * n]) == gram:
                return True
    return False


class RepeatCapture:
    """Rolling capture of the last ~25 s of mic audio, pre- and post-filter.

    Filled by the TeeFilter (raw mic, pre-chain) and by Son's pipeline
    (post-filter 16 kHz). Dumped to ~/.cache/son/debug only when a repeated
    phrase is detected in a transcript — the debug instrument for whisper
    repetition loops on live audio. Writes nothing until triggered, so
    normal use costs no disk.
    """

    def __init__(self, seconds: float = 25.0) -> None:
        self._seconds = seconds
        self.pre = bytearray()
        self.post = bytearray()
        self.pre_rate = 16000
        self.post_rate = 16000

    def feed_pre(self, data: bytes, rate: int) -> None:
        self.pre_rate = rate
        self.pre += data
        self._trim("pre", rate)

    def feed_post(self, data: bytes, rate: int) -> None:
        self.post_rate = rate
        self.post += data
        self._trim("post", rate)

    def _trim(self, which: str, rate: int) -> None:
        buf = getattr(self, which)
        limit = int(self._seconds * rate * 2)  # int16 mono
        if len(buf) > limit:
            del buf[: len(buf) - limit]

    def dump(self, raw_text: str, cleaned_text: str) -> None:
        import time
        import wave
        from pathlib import Path

        out_dir = Path.home() / ".cache" / "son" / "debug"
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        for which, buf, rate in (
            ("pre", self.pre, self.pre_rate),
            ("post", self.post, self.post_rate),
        ):
            path = out_dir / f"repeat-{stamp}-{which}.wav"
            with wave.open(str(path), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(rate)
                w.writeframes(bytes(buf))
        (out_dir / f"repeat-{stamp}.txt").write_text(
            f"raw: {raw_text!r}\ncleaned: {cleaned_text!r}\n"
        )
        # Instrument leftovers are small, but storage matters — drop any
        # older than a week on each dump.
        cutoff = time.time() - 7 * 86400
        for p in out_dir.glob("repeat-*"):
            if p.stat().st_mtime < cutoff:
                p.unlink()


capture = RepeatCapture()


class TeeFilter(BaseAudioFilter):
    """Feed the raw (pre-chain) mic audio into the repeat capture roll."""

    async def start(self, sample_rate: int):
        capture.pre_rate = sample_rate

    async def stop(self):
        pass

    async def process_frame(self, frame: FilterControlFrame):
        pass

    async def filter(self, audio: bytes) -> bytes:
        capture.feed_pre(audio, capture.pre_rate)
        return audio


class ChainedFilter(BaseAudioFilter):
    """Run several audio filters in sequence (denoise, then AGC)."""

    def __init__(self, filters: list[BaseAudioFilter]) -> None:
        self._filters = filters

    async def start(self, sample_rate: int):
        for f in self._filters:
            await f.start(sample_rate)

    async def stop(self):
        for f in self._filters:
            await f.stop()

    async def process_frame(self, frame: FilterControlFrame):
        for f in self._filters:
            await f.process_frame(frame)

    async def filter(self, audio: bytes) -> bytes:
        for f in self._filters:
            audio = await f.filter(audio)
        return audio


class GainAGCFilter(BaseAudioFilter):
    """Quiet-speech AGC on int16 PCM.

    Per-frame gain with fast attack / slow release, a noise gate so
    silences don't get amplified (which would feed VAD false turns), and
    a max-gain cap so the quietest audible speech isn't pushed into the
    noise. Frame-level uniform gain is enough here — the transport
    delivers ~20 ms frames and the smoothing makes it inaudible.
    """

    def __init__(
        self,
        target_db: float = -22.0,
        max_gain_db: float = 18.0,
        gate_db: float = -45.0,
    ) -> None:
        self._target = 10 ** (target_db / 20)
        self._max_gain = 10 ** (max_gain_db / 20)
        self._gate = 10 ** (gate_db / 20)
        self._gain = 1.0
        self._filtering = True

    async def start(self, sample_rate: int):
        self._gain = 1.0

    async def stop(self):
        pass

    async def process_frame(self, frame: FilterControlFrame):
        if isinstance(frame, FilterEnableFrame):
            self._filtering = frame.enable

    async def filter(self, audio: bytes) -> bytes:
        if not self._filtering or len(audio) < 2:
            return audio
        arr = np.frombuffer(audio, dtype=np.int16).astype(np.float32) / 32768.0
        rms = float(np.sqrt(np.mean(arr ** 2) + 1e-12))
        if rms >= self._gate:
            desired = min(self._target / rms, self._max_gain)
            # attack faster than release: normalize quickly, let go slowly
            rate = 0.6 if desired > self._gain else 0.08
            self._gain = (1 - rate) * self._gain + rate * desired
        else:
            # Below the gate: slowly release the held gain so pauses don't
            # sit with the floor boosted. Fast attack recovers on the next
            # speech onset (~2-3 frames).
            self._gain = 1.0 + (self._gain - 1.0) * 0.95
        out = np.clip(arr * self._gain, -1.0, 1.0) * 32767.0
        return out.astype(np.int16).tobytes()


def build_input_filter() -> BaseAudioFilter | None:
    """The transport's audio-in filter chain, per env config.

    Returns None when every stage is off, so the pipeline runs exactly as
    before on machines that don't want the processing.
    """
    filters: list[BaseAudioFilter] = []
    if os.getenv("SON_DENOISE", "1") != "0":
        filters.append(RNNoiseFilter())
    if os.getenv("SON_AGC", "1") != "0":
        filters.append(
            GainAGCFilter(
                target_db=float(os.getenv("SON_AGC_TARGET_DB", "-22")),
                max_gain_db=float(os.getenv("SON_AGC_MAX_DB", "18")),
                gate_db=float(os.getenv("SON_AGC_GATE_DB", "-45")),
            )
        )
    if not filters:
        return None
    # The tee is only a debug instrument (repeat capture): first in the
    # chain so it sees the raw mic audio, zero cost to the signal path.
    return ChainedFilter([TeeFilter(), *filters])

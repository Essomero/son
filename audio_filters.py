#!/usr/bin/env python3
"""Input audio filters for Son: the "clean and magnify" stage.

Cloud STT providers denoise and normalize loudness before the model ever
sees audio; the local path gets raw mic audio and is expected to cope.
Soft speech is where it breaks: the voice drops toward a constant room
noise floor and the SNR collapses.

These filters sit on the transport's audio-in path (TransportParams
audio_in_filter), BEFORE VAD and every STT provider:

  RNNoiseFilter      — neural noise suppression (pipecat's, open-source)
  MultibandAGCFilter — per-band quiet-speech AGC (PCEN-lite): splits the
                       signal into 3 bands (Linkwitz-Riley crossovers at
                       1 kHz / 3.5 kHz) and normalizes each band to its
                       own target, so the quiet 1-3.5 kHz speech band gets
                       lifted even when low-frequency energy dominates the
                       total RMS. A single-band AGC spends its gain budget
                       on the low end and leaves the intelligibility band
                       below the STT's input range (see
                       docs/RESEARCH-QUIET-SPEECH.md). A 90 Hz high-pass
                       removes the rumble that hijacks the RMS estimate;
                       a composite peak limiter caps the summed bands at
                       -1 dBFS.

Env knobs (all optional):
  SON_DENOISE         1|0 — noise suppression on/off (default on when the
                           pipecat rnnoise extra is installed)
  SON_AGC             1|0 — quiet-speech AGC on/off (default on)
  SON_AGC_TARGET_DB   mid-band target in dBFS (default -18)
  SON_AGC_LOW_TARGET_DB   low-band (0-1 kHz) target (default -25)
  SON_AGC_HIGH_TARGET_DB  high-band (3.5-8 kHz) target (default -20)
  SON_AGC_MAX_DB      max gain per band in dB (default +48)
  SON_AGC_GATE_DB     low-band gate in dBFS; the speech bands gate 10 dB
                      lower so the quietest speech still gets gain
                      (default -45)
"""

import os

import numpy as np
from scipy.signal import lfilter

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
        # Turn-level telemetry for the quiet-turn trigger (reset per turn by
        # the cleanup processor): the loudest pre-filter frame RMS and the
        # highest AGC gain applied, so a dump fires when the turn was quiet.
        self.pre_rms = 0.0
        self.pre_turn_max = -1.0  # -1 = no data (filter chain off)
        self.agc_gain = 1.0
        self.agc_turn_max = 1.0
        self._last_quiet_dump = 0.0

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

    def _write(self, out_dir, prefix: str, stamp: str, note: str) -> None:
        import wave

        for which, buf, rate in (
            ("pre", self.pre, self.pre_rate),
            ("post", self.post, self.post_rate),
        ):
            path = out_dir / f"{prefix}-{stamp}-{which}.wav"
            with wave.open(str(path), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(rate)
                w.writeframes(bytes(buf))
        (out_dir / f"{prefix}-{stamp}.txt").write_text(note)

    def dump(self, raw_text: str, cleaned_text: str) -> None:
        import time
        from pathlib import Path

        out_dir = Path.home() / ".cache" / "son" / "debug"
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        self._write(
            out_dir, "repeat", stamp,
            f"raw: {raw_text!r}\ncleaned: {cleaned_text!r}\n",
        )
        # Instrument leftovers are small, but storage matters — drop any
        # older than a week on each dump.
        cutoff = time.time() - 7 * 86400
        for p in out_dir.glob("repeat-*"):
            if p.stat().st_mtime < cutoff:
                p.unlink()

    def dump_quiet(
        self, raw_text: str, pre_turn_max: float, agc_turn_max: float
    ) -> None:
        """Dump the roll for a turn that was quiet (the soft-speech failure
        case). Throttled to one a minute and capped at the 8 newest. The
        trigger values are passed in — they describe the turn that JUST
        ended, not whatever the roll holds now."""
        import time
        from pathlib import Path

        if time.time() - self._last_quiet_dump < 60:
            return
        self._last_quiet_dump = time.time()
        out_dir = Path.home() / ".cache" / "son" / "debug"
        out_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        self._write(
            out_dir, "quiet", stamp,
            f"raw: {raw_text!r}\n"
            f"pre_turn_max: {pre_turn_max:.4f}\n"
            f"agc_turn_max: {agc_turn_max:.2f}\n",
        )
        files = sorted(out_dir.glob("quiet-*"))
        for p in files[:-24]:  # 8 captures x (txt + 2 wav)
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
        if len(audio) >= 2:
            arr = np.frombuffer(audio, dtype=np.int16)
            capture.pre_rms = float(
                np.sqrt(np.mean((arr.astype(np.float64) / 32768.0) ** 2))
            )
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


def _butter_biquad(kind: str, f0: float, fs: float) -> tuple[float, float, float, float, float]:
    """2nd-order Butterworth (Q = 1/sqrt(2)) biquad, normalized (a0 = 1).

    Two cascaded copies of the same biquad form a Linkwitz-Riley 4th-order
    section: -6 dB at the crossover, flat amplitude sum with its sibling.
    """
    w0 = 2.0 * np.pi * f0 / fs
    c, s = np.cos(w0), np.sin(w0)
    alpha = s / np.sqrt(2.0)
    a0 = 1.0 + alpha
    if kind == "lowpass":
        b0 = (1.0 - c) / 2.0
        b1 = 1.0 - c
        b2 = (1.0 - c) / 2.0
    else:  # highpass
        b0 = (1.0 + c) / 2.0
        b1 = -(1.0 + c)
        b2 = (1.0 + c) / 2.0
    return b0 / a0, b1 / a0, b2 / a0, -2.0 * c / a0, (1.0 - alpha) / a0


class _BiquadChain:
    """A cascade of biquad sections with lfilter state carried across frames."""

    def __init__(self, sections: list[tuple[float, float, float, float, float]]):
        self._b = np.array([[b0, b1, b2] for b0, b1, b2, _, _ in sections], dtype=np.float64)
        self._a = np.array([[1.0, a1, a2] for _, _, _, a1, a2 in sections], dtype=np.float64)
        self._zi = np.zeros((len(sections), 2), dtype=np.float64)

    def process(self, x: np.ndarray) -> np.ndarray:
        for i in range(len(self._b)):
            y, self._zi[i] = lfilter(self._b[i], self._a[i], x, zi=self._zi[i])
            x = y
        return x


class MultibandAGCFilter(BaseAudioFilter):
    """Per-band quiet-speech AGC on int16 PCM (PCEN-lite).

    A 90 Hz high-pass strips the rumble that dominates the RMS estimate,
    then the signal is split into three bands at Linkwitz-Riley 4th-order
    crossovers (1 kHz, 3.5 kHz) and each band is AGC'd to its own target
    with its own noise gate. The 1-3.5 kHz speech band is lifted even when
    low-frequency energy dominates — the failure mode of the single-band
    AGC it replaces (captured live: the low band sat 20-40 dB above the
    speech band and the gain budget went to the rumble). A composite peak
    limiter caps the summed bands at -1 dBFS so the high-crest transients
    of quiet speech don't clip (clipping distortion is a whisper
    hallucination trigger).

    Per-band gains use fast attack / slow release; below a band's gate the
    gain releases toward 1.0 so silence isn't amplified (which would feed
    VAD false turns). The speech bands gate 10 dB lower than the low band
    so the quietest speech still gets gain while room noise doesn't pump.

    Defaults (max +48 dB, low gate -70 dBFS) are set for soft talkers —
    measured live: natural speech lands ~-50..-75 dBFS band RMS on quiet
    mics, which the old +24/-45 defaults gated out entirely. Safe because
    RNNoise runs first: the post-suppression noise floor is ~-100 dBFS,
    far below any gate here.
    """

    def __init__(
        self,
        mid_target_db: float = -18.0,
        low_target_db: float = -25.0,
        high_target_db: float = -20.0,
        max_gain_db: float = 48.0,
        gate_db: float = -70.0,
    ) -> None:
        self._targets = [10 ** (t / 20) for t in (low_target_db, mid_target_db, high_target_db)]
        self._max_gain = 10 ** (max_gain_db / 20)
        # Low band gates at gate_db; speech bands 10 dB lower.
        self._gates = [10 ** (gate_db / 20), 10 ** ((gate_db - 10) / 20), 10 ** ((gate_db - 10) / 20)]
        self._gain = np.array([1.0, 1.0, 1.0])
        self._filtering = True
        self._hp = None  # built in start() from the sample rate
        self._bands = None

    async def start(self, sample_rate: int):
        fs = float(sample_rate)
        # One-pole high-pass at 90 Hz: y[n] = x[n] - x[n-1] + R y[n-1].
        r = np.exp(-2.0 * np.pi * 90.0 / fs)
        self._hp = _BiquadChain([(1.0, -1.0, 0.0, -r, 0.0)])
        # LR4 crossovers at 1 kHz and 3.5 kHz (2 cascaded biquads each).
        lp1k = [_butter_biquad("lowpass", 1000.0, fs)] * 2
        hp1k = [_butter_biquad("highpass", 1000.0, fs)] * 2
        lp35k = [_butter_biquad("lowpass", 3500.0, fs)] * 2
        hp35k = [_butter_biquad("highpass", 3500.0, fs)] * 2
        self._bands = [
            _BiquadChain(lp1k),        # 0-1 kHz
            _BiquadChain([*hp1k, *lp35k]),  # 1-3.5 kHz
            _BiquadChain(hp35k),       # 3.5-8 kHz
        ]
        self._gain = np.array([1.0, 1.0, 1.0])

    async def stop(self):
        pass

    async def process_frame(self, frame: FilterControlFrame):
        if isinstance(frame, FilterEnableFrame):
            self._filtering = frame.enable

    async def filter(self, audio: bytes) -> bytes:
        if not self._filtering or len(audio) < 2 or self._bands is None:
            return audio
        x = np.frombuffer(audio, dtype=np.int16).astype(np.float64) / 32768.0
        x = self._hp.process(x)
        banded = [self._bands[i].process(x) for i in range(3)]
        for i in range(3):
            rms = float(np.sqrt(np.mean(banded[i] ** 2) + 1e-12))
            if rms >= self._gates[i]:
                desired = min(self._targets[i] / rms, self._max_gain)
                # attack faster than release: normalize quickly, let go slowly
                rate = 0.6 if desired > self._gain[i] else 0.08
                self._gain[i] = (1 - rate) * self._gain[i] + rate * desired
            else:
                # Below the gate: slowly release the held gain so pauses
                # don't sit with the floor boosted. Fast attack recovers on
                # the next speech onset (~2-3 frames).
                self._gain[i] = 1.0 + (self._gain[i] - 1.0) * 0.95
        capture.agc_gain = float(np.max(self._gain))  # telemetry for the quiet-turn trigger
        out = banded[0] * self._gain[0] + banded[1] * self._gain[1] + banded[2] * self._gain[2]
        # Peak-aware limiter: quiet speech has a high crest factor, so a
        # big RMS-driven gain clips the transients (captured live: peaks at
        # 0 dBFS). Cap this frame so its peak lands at -1 dBFS.
        peak = float(np.max(np.abs(out)))
        if peak > 1e-6:
            out = out * min(1.0, 10 ** (-1.0 / 20) / peak)
        return (np.clip(out, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()


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
            MultibandAGCFilter(
                mid_target_db=float(os.getenv("SON_AGC_TARGET_DB", "-18")),
                low_target_db=float(os.getenv("SON_AGC_LOW_TARGET_DB", "-25")),
                high_target_db=float(os.getenv("SON_AGC_HIGH_TARGET_DB", "-20")),
                max_gain_db=float(os.getenv("SON_AGC_MAX_DB", "24")),
                gate_db=float(os.getenv("SON_AGC_GATE_DB", "-45")),
            )
        )
    if not filters:
        return None
    # The tee is only a debug instrument (repeat capture): first in the
    # chain so it sees the raw mic audio, zero cost to the signal path.
    return ChainedFilter([TeeFilter(), *filters])

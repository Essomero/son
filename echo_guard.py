# Echo guard — keep the bot's own voice out of the user STT.
#
# The bot's TTS plays in the room, and the mic picks it up. There is no
# acoustic echo canceller in this pipeline: when playback reaches the mic
# late (client autoplay/buffer lag, headphone leak), the VAD hears the bot's
# audio as a "user" turn and the STT faithfully transcribes the bot's own
# words — live evidence: the user turn 'YOUR HEAD OF OVERTO' was the tail of
# the bot's own sentence "...running on pure spite this morning?" played ~2 s
# after the server-side "bot stopped speaking" signal (past the browser AEC
# window, which does not cancel reference delays beyond ~0.5 s).
#
# The guard is a correlation test: the bot-branch audio (TTS output, rolling
# 15 s) is compared against the first few hundred ms of each candidate user
# turn. When the turn's onset matches a slice of the recent bot audio (echo
# path delay 0.2–6 s), the turn is echo, and the STT drops it — no interim,
# no final, so the user aggregator's empty turn pushes nothing and the bot
# does not answer its own echo.

import threading
import time

import numpy as np

from pipecat.frames.frames import TTSAudioRawFrame
from pipecat.processors.frame_processor import FrameProcessor

ECHO_SAMPLE_RATE = 16000  # the STT rate; the roll stores 16 kHz mono


class BotAudioRoll:
    """Rolling record of the bot's TTS audio (16 kHz float32 mono)."""

    def __init__(self, seconds: float = 15.0):
        self._seconds = seconds
        self._chunks: list[tuple[float, np.ndarray]] = []  # (start_time, samples)
        self._lock = threading.Lock()

    def feed(self, samples: np.ndarray, rate: int) -> None:
        """Record one TTS chunk. `rate` may differ from 16 kHz (piper is
        22050) — linear resample is fine, the correlation only needs the
        envelope shape."""
        if len(samples) == 0:
            return
        if rate != ECHO_SAMPLE_RATE:
            t_old = np.linspace(0.0, 1.0, num=len(samples), endpoint=False)
            t_new = np.linspace(0.0, 1.0, num=int(len(samples) * ECHO_SAMPLE_RATE / rate), endpoint=False)
            samples = np.interp(t_new, t_old, samples)
        with self._lock:
            now = time.monotonic()
            self._chunks.append((now, samples.astype(np.float32)))
            cutoff = now - self._seconds
            while self._chunks and self._chunks[0][0] < cutoff:
                del self._chunks[0]

    def match(self, onset: np.ndarray, reference_time: float) -> tuple[bool, float]:
        """Is `onset` (16 kHz float32, ~0.5 s of a candidate user turn) the
        echo of bot audio that played shortly before `reference_time`?

        Returns (is_echo, best_score) with score = envelope NCC over the best
        echo-path lag in [0.2, 6] s. The envelope (20 ms RMS) comparison makes
        the test robust to the mic channel (denoise, AGC, room response)."""
        if len(onset) < int(0.3 * ECHO_SAMPLE_RATE):
            return False, 0.0
        with self._lock:
            if not self._chunks:
                return False, 0.0
            chunks = self._chunks.copy()
        enc = self._envelope(onset)
        d = float(np.sqrt((enc * enc).sum()))
        if d < 1e-9:
            return False, 0.0
        # The probe window matches the onset's duration (the envelope is a
        # per-sample RMS trace, so enc covers exactly len(onset) samples).
        n = len(onset)
        step = int(0.02 * ECHO_SAMPLE_RATE)  # 20 ms lag resolution
        best = 0.0
        for lag in range(int(0.2 * ECHO_SAMPLE_RATE), int(6.0 * ECHO_SAMPLE_RATE), step):
            # `lag` is in samples here; reference_time is in seconds.
            window = self._window_at(chunks, reference_time - lag / ECHO_SAMPLE_RATE, n)
            if window is None:
                continue
            wen = self._envelope(window)
            dw = float(np.sqrt((wen * wen).sum()))
            if dw < 1e-9:
                continue
            c = float((enc * wen).sum() / (d * dw))
            if c > best:
                best = c
                if best >= 0.45:
                    break
        return best >= 0.45, best

    @staticmethod
    def _envelope(x: np.ndarray) -> np.ndarray:
        # 20 ms RMS envelope, mean-subtracted (NCC needs zero-mean).
        w = int(0.02 * ECHO_SAMPLE_RATE)
        e = np.sqrt(np.convolve(x * x, np.ones(w), "same") / w)
        return e - e.mean()

    @staticmethod
    def _window_at(
        chunks: list[tuple[float, np.ndarray]], at: float, n: int
    ) -> np.ndarray | None:
        """The roll's audio covering [at, at + n/16000 s).

        Each chunk is placed at its own offset in the window: a gap in the
        roll means the bot was silent there, so the window keeps real silence
        (zero samples) instead of compressing the gap. Returns None when less
        than half the window has real bot audio."""
        end = at + n / ECHO_SAMPLE_RATE
        out = np.zeros(n, dtype=np.float32)
        covered = 0
        for t0, seg in chunks:  # chronological
            if t0 + len(seg) / ECHO_SAMPLE_RATE <= at:
                continue  # entirely before the window
            if t0 >= end:
                break  # all later chunks are past the window too
            # Where this chunk starts within the window / the window within
            # the chunk — one of the two is zero, never a negative index.
            # round(), not int(): float deltas like (1.0 - 0.9) truncate a
            # sample short after int() and shift the whole layout.
            k0 = max(0, round((at - t0) * ECHO_SAMPLE_RATE))
            w0 = max(0, round((t0 - at) * ECHO_SAMPLE_RATE))
            take = seg[k0 : k0 + (n - w0)]
            if len(take) > 0:
                out[w0 : w0 + len(take)] = take
                covered += len(take)
        if covered < n * 0.5:
            return None  # the window mostly falls outside the roll
        return out


class BotAudioCaptureProcessor(FrameProcessor):
    """Tee the bot-branch audio (TTS → transport) into the echo guard roll.

    Sits between the TTS service and transport.output: the TTS frames pass
    through it on the way down, and the TTS audio frames are copied into the
    roll's 16 kHz history (any rate gets resampled at feed time).

    Only TTSAudioRawFrame is recorded — not every AudioRawFrame. The mic
    audio also flows downstream along this chain (the STT service passes
    audio through by default), and it arrives here as InputAudioRawFrame /
    plain AudioRawFrame; recording it would let a turn "match" the user's own
    voice a few seconds back and drop every real turn as echo."""

    def __init__(self, roll: BotAudioRoll):
        super().__init__()
        self._roll = roll

    async def process_frame(self, frame, direction):
        if isinstance(frame, TTSAudioRawFrame):
            samples = np.frombuffer(frame.audio, dtype=np.int16).astype(np.float32) / 32768.0
            self._roll.feed(samples, frame.sample_rate)
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)

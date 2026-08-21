#!/usr/bin/env python3
"""Regenerate whisper.cpp's whisper/assets/mel_filters.npz.

whisper.cpp v1.9.2 no longer vendors this file (the whisper/ submodule is
gone from the tree), and it isn't in the HF repo either. models/convert-
h5-to-ggml.py hard-requires it to exist at <whisper.cpp>/whisper/assets/.
It must contain key "mel_80" as float32 (80, 201) — and the values must
match the filterbank OpenAI's feature extractor produces bit-for-bit, or
the GGML model transcribes garbage. whisper.cpp loads these from the model
file at runtime (whisper_model_load), so a wrong bank poisons serving while
HF transformers (which computes its own) stays fine — the divergence shows
up hardest on low-SNR audio because the scales differ most in the low mel
bins where speech fundamentals and room noise live.

OpenAI's reference is librosa.filters.mel(..., htk=False, norm="slaney"):
slaney MEL SCALE (piecewise-linear below 1 kHz, log above) with slaney area
normalization. An earlier version of this script used the HTK mel scale
(2595·log10(1+f/700)) with slaney norm — close enough for clean audio, but
structurally wrong, and it cost real WER on quiet takes served through
whisper.cpp. This reproduces the librosa bank exactly (verified allclose
against librosa.filters.mel). Pure numpy, no torch.

Run:  uv run python finetune/convert/gen_mel.py [whisper.cpp repo root]
      (default: ~/.cache/son/whisper.cpp)
"""

import sys
from pathlib import Path

import numpy as np

WHISPER_CPP = Path(sys.argv[1]) if len(sys.argv) > 1 else \
    Path.home() / ".cache" / "son" / "whisper.cpp"

n_freqs, sr, f_min, f_max, n_mels = 201, 16000, 0.0, 8000.0, 80


F_MIN, F_SP = 0.0, 200.0 / 3        # slaney grid: linear ramp below ...
MIN_LOG_HZ = 1000.0                 # ... 1 kHz, log above
MIN_LOG_MEL = (MIN_LOG_HZ - F_MIN) / F_SP
LOGSTEP = np.log(6.4) / 27.0


def hz_to_mel(f):
    lin = (f - F_MIN) / F_SP
    return np.where(f >= MIN_LOG_HZ,
                    MIN_LOG_MEL + np.log(f / MIN_LOG_HZ) / LOGSTEP,
                    lin)


def mel_to_hz(m):
    lin = F_MIN + F_SP * m
    return np.where(m >= MIN_LOG_MEL,
                    MIN_LOG_HZ * np.exp(LOGSTEP * (m - MIN_LOG_MEL)),
                    lin)


all_freqs = np.linspace(0, sr // 2, n_freqs)
with np.errstate(divide="ignore"):   # f=0 hits log(0) in the unused branch
    m_pts = np.linspace(hz_to_mel(f_min), hz_to_mel(f_max), n_mels + 2)
    f_pts = mel_to_hz(m_pts)

f_diff = f_pts[1:] - f_pts[:-1]
slopes = f_pts[None, :] - all_freqs[:, None]           # (n_freqs, n_mels+2)
down = -1.0 * slopes[:, :-2] / f_diff[:-1]
up = slopes[:, 2:] / f_diff[1:]
fb = np.clip(np.minimum(down, up), 0.0, None)          # (201, 80)

enorm = 2.0 / (f_pts[2:n_mels + 2] - f_pts[:n_mels])   # slaney area norm
fb *= enorm[None, :]

mel_80 = fb.T.astype(np.float32)                       # (80, 201)

out = WHISPER_CPP / "whisper" / "assets" / "mel_filters.npz"
out.parent.mkdir(parents=True, exist_ok=True)
np.savez(out, mel_80=mel_80)
print(f"written: {out}  {mel_80.shape} {mel_80.dtype} "
      f"min/max: {mel_80.min():.4f}/{mel_80.max():.4f}")

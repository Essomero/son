#!/usr/bin/env python3
"""Regenerate whisper.cpp's whisper/assets/mel_filters.npz.

whisper.cpp v1.9.2 no longer vendors this file (the whisper/ submodule is
gone from the tree), and it isn't in the HF repo either. models/convert-
h5-to-ggml.py hard-requires it to exist at <whisper.cpp>/whisper/assets/.
It must contain key "mel_80" as float32 (80, 201) — and the values must
match the filterbank OpenAI's feature extractor produces bit-for-bit, or
the GGML model transcribes garbage.

This reproduces torchaudio.functional.melscale_fbanks(n_freqs=201, f_min=0,
f_max=8000, n_mels=80, sample_rate=16000, norm="slaney", mel_scale="htk")
— the exact algorithm behind the original file. Pure numpy, no torch.

Run:  uv run python finetune/convert/gen_mel.py [whisper.cpp repo root]
      (default: ~/.cache/son/whisper.cpp)
"""

import sys
from pathlib import Path

import numpy as np

WHISPER_CPP = Path(sys.argv[1]) if len(sys.argv) > 1 else \
    Path.home() / ".cache" / "son" / "whisper.cpp"

n_freqs, sr, f_min, f_max, n_mels = 201, 16000, 0.0, 8000.0, 80


def hz_to_mel(f):
    return 2595.0 * np.log10(1.0 + f / 700.0)


def mel_to_hz(m):
    return 700.0 * (10.0 ** (m / 2595.0) - 1.0)


all_freqs = np.linspace(0, sr // 2, n_freqs)
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

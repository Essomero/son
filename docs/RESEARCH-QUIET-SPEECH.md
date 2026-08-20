# Quiet-speech STT research — why whisper mishears soft speech, and what to do about it

Researched 2026-08-20 (browser research via real Chrome profile; captures
analyzed from `~/.cache/son/debug/quiet-*.wav`).

## 1. Why whisper fails on low-volume speech (and Grok/Gemini don't)

**Whisper's input stage has no loudness normalization.** Whisper turns audio
into a static log-mel spectrogram (`log10(max(mel, 1e-10)) · 4.0`) with a fixed
floor. Quiet speech pushes the mel features toward that floor, so the encoder
sees something close to the "no speech" state. There is no AGC, no dynamic
compression, no per-band energy normalization anywhere in the pipeline —
OpenAI's own discussions describe denoising as "rarely works" unless the model
was *trained* on denoised audio
([whisper#2125](https://github.com/openai/whisper/discussions/2125)).

**Whisper's decoder is an unconstrained language model.** Unlike CTC/transducer
models (which can emit "blank"), whisper's decoder always produces the most
probable next token. Combined with zero-padding to 30 s windows and training
data that pairs low-information audio with boilerplate subtitles, quiet audio
elicits *confident* continuations — mishears and hallucinations, not refusals.
([multigrid whisper-explained](https://multigrid.ai/learn/whisper-explained),
[whisper#1606](https://github.com/openai/whisper/discussions/1606))

**Google's frontend is the opposite.** Chirp-family STT uses a trainable
frontend whose key ingredient is **PCEN — per-channel energy normalization**:
"an automatic gain control based dynamic compression to replace the static log
compression… to improve robustness to loudness variation"
([Sainath et al., ICASSP 2017](https://research.google/pubs/trainable-frontend-for-robust-and-far-field-keyword-spotting/)).
The AGC lives *inside* the feature extractor, per frequency band, adapting to
background level. Whisper's static log-mel is exactly the thing PCEN was
designed to replace.

**xAI Grok STT is far-field/telephony-trained.** "Built on the same stack that
powers Grok Voice, Tesla vehicles, and Starlink customer support"
([x.ai announcement](https://x.ai/news/grok-stt-and-tts-apis)) and benchmarked
on phone-call/telephony corpora — i.e. real loudness-varying audio. Whisper's
corpus is web-video subtitles, mostly broadcast-loudness speech.

**Bottom line:** the two cloud STTs that don't mishear your quiet speech both
(1) normalize loudness per frequency band before the model, and (2) were
trained on loudness-varied audio. Whisper has neither.

## 2. Our own captures — the failure signature

Analyzed all 8 quiet-turn captures (`quiet-*.pre/post.wav`). Band energies of
the loudest 1 s of speech (dBFS):

| capture | raw | pre 1–3.5 kHz | post 1–3.5 kHz | post 0–250 Hz | gap | result |
|---|---|---|---|---|---|---|
| 170747 | "Yeah, what do you like about" | −32.6 | −26.6 | +0.9 | 27 dB | correct |
| 170852 | "Mamukrojekat" | −37.7 | −25.5 | +3.0 | 28 dB | **misheard** |
| 171438 | "No, that's chilling, what's up" | −46.4 | −38.2 | +2.4 | 41 dB | correct (2nd try louder) |
| 171839 | "The last purchase was exciting about yours" | −38.4 | −23.8 | −2.8 | 21 dB | **misheard** |
| 174654 | "Don't I not just check" | −41.6 | −36.6 | −18.5 | 18 dB | **misheard**, AGC capped at +18 dB, post still −25 dBFS |
| 174756 | "I'm just swimming with a flow…" | −34.9 | −28.1 | +2.7 | 31 dB | correct |
| 175059 | "I don't know much, just chilling." | −51.1 | −27.5 | −6.4 | 21 dB | correct |
| 175228 | "Nothing more, just chilling." | −31.6 | −21.4 | +2.1 | 23 dB | correct |

Two structural problems, both in the enhancement chain (`audio_filters.py`):

1. **Low-frequency dominance.** In every capture the 0–250 Hz band sits
   20–40 dB above the 1–3.5 kHz speech band, before *and* after the chain. The
   single-band RMS AGC normalizes the whole signal, so its gain budget is spent
   on low-frequency energy (room rumble / near-field low end); the
   intelligibility band stays 20–30 dB below it and never reaches whisper's
   mel-floor region. This is exactly the failure PCEN's per-band AGC was built
   to fix.
2. **Max-gain cap is too low for the quietest turns.** 174654 hit the +18 dB
   cap (`agc_turn_max 7.94`) and the turn still finished at −25 dBFS RMS —
   below the −22 target and whisper's training loudness. Quiet speech at the
   very bottom of the range is left too quiet.

Note the positive control: 175059 (the quietest *pre* capture, mid-band
−51.1) transcribed **correctly** — the chain lifted 3.5–8 kHz by ~42 dB and
whisper heard it. The enhancement chain does work; it just spends its budget
on the wrong band.

## 3. Ranked levers for Son (enhancement first)

All local, all in `audio_filters.py` / env config, A/B-able with the existing
debug dumps (`quiet-*` + cleanup.log).

### A. Enhancement (the main fix)

1. **High-pass / low-band attenuation before the AGC.** A gentle rolloff on
   0–250 Hz (or a plain 80–120 Hz high-pass) removes the energy that hijacks
   the RMS gain. Cheapest structural fix, pure DSP.
2. **Multiband AGC (PCEN-lite).** Split the signal into ~3 bands (e.g.
   0–1 kHz, 1–3.5 kHz, 3.5–8 kHz), AGC each band to its own target with its
   own gate. The quiet-speech band gets lifted regardless of what the low end
   does. This is the closest practical emulation of Google's PCEN frontend.
   (Full PCEN requires training the features in; per-band AGC is the
   engineering approximation.)
3. **Raise the AGC target from −22 → −18 dBFS and the max gain from +18 → +24
   dB.** Puts the overall level closer to whisper's broadcast-loudness training
   distribution and covers the 174654-style capped turns.
4. **A/B `SON_DENOISE=0`.** RNNoise's suppression is visible in the captures
   (speech-active fraction drops after the chain — e.g. 41% → 22%, 18% → 6%)
   and community reports say it can eat low-level speech. For whisper-soft
   input the denoiser may do more harm than good; test both.
5. **Match training to the runtime chain.** The 2125 insight: denoising helps
   an ASR only if the model has *seen* denoised audio. The next finetune
   (gen3) should apply the exact runtime chain (RNNoise → AGC → 16 kHz int16)
   to training audio, so the model knows the enhanced spectrum. (gen2 used
   soft/noisy augmentation — check whether it included the real chain.)

### B. Decode fail-safes (cheap, complementary — task #15)

From the multigrid "what actually helps" table, for the running
whisper-server (`whisper.cpp` build, currently default everywhere except
`-bs 5`):

6. `--no-speech-thold 0.75` (default 0.6) — reject low-information audio more
   aggressively instead of transcribing it confidently.
7. `--logprob-thold -0.5` (default −1.0) + temperature fallback on — retry at
   higher temperature when the first pass is unsure, instead of committing a
   confident misread. (`-nf` is currently off, so fallback exists but never
   triggers at −1.0.)
8. `--entropy-thold` tuned slightly down (2.4 default) if repetition loops
   reappear.
9. `--no-timestamps` — the shim transcript doesn't need them; removes a
   timestamp-hallucination surface.

### C. Model-side (only if A+B don't close the gap)

10. **Calm-Whisper-style decoder-head tuning** — 3 of 20 large-v3 decoder heads
    account for >75% of hallucinations; fine-tuning just those on non-speech
    data cuts hallucinations ~80% with <0.1% WER loss (Interspeech 2025,
    [arXiv:2505.12969](https://arxiv.org/abs/2505.12969)). A gen4 candidate
    for whisper-small-son.
11. Whisper-large-v3 locally (Metal) is more robust at low SNR but much slower
    on CPU/Metal — only if enhancement can't close the gap, since Groq's
    large-v3 already mishears the same quiet turns.

## 4. Sources

- [PCEN: trainable frontend for robust and far-field keyword spotting (Sainath et al., ICASSP 2017)](https://research.google/pubs/trainable-frontend-for-robust-and-far-field-keyword-spotting/)
- [Whisper's architecture and known failure modes (multigrid.ai)](https://multigrid.ai/learn/whisper-explained)
- [do whisper need preprocessing, enhancing, or denoising (openai/whisper #2125)](https://github.com/openai/whisper/discussions/2125)
- [Hallucination on audio with no speech (openai/whisper #1606)](https://github.com/openai/whisper/discussions/1606)
- [Grok STT/TTS API announcement (x.ai)](https://x.ai/news/grok-stt-and-tts-apis)
- [Calm-Whisper: reduce hallucination by fine-tuning 3 decoder heads (arXiv:2505.12969)](https://arxiv.org/abs/2505.12969)
- Local captures: `~/.cache/son/debug/quiet-*.{pre,post}.wav` + `*.txt`

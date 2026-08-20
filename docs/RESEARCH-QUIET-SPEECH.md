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

**Post-multiband-AGC captures (same day, after the PCEN-lite chain landed).**
Three more quiet turns dumped at 18:20–18:24; whisper's raw outputs:
182013 `'May I hide in'`, 182114 `'STT failing me'`, 182445 `'[BLANK_AUDIO]'`
(ground truth unknown — these read as mishears/failures). All three hit the
+24 dB max gain (`agc_turn_max 15.85`) with pre-filter RMS −25 to −13 dBFS.
So the chain fix is in and, alone, not sufficient: the quietest turns still
land below whisper's input range. This is the A/B case for the model swaps
in §4.

## 3. Ranked levers for Son (enhancement first)

All local, all in `audio_filters.py` / env config, A/B-able with the existing
debug dumps (`quiet-*` + cleanup.log).

### A. Enhancement (the main fix)

1. **High-pass / low-band attenuation before the AGC.** A gentle rolloff on
   0–250 Hz (or a plain 80–120 Hz high-pass) removes the energy that hijacks
   the RMS gain. Cheapest structural fix, pure DSP. (Confirmed load-bearing
   by the offline A/B in lever 4: HP + one scalar gain ≥ the multiband AGC
   on every capture.)
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
   input the denoiser may do more harm than good; test both. An offline
   replay of the pre captures (`scripts/ab_denoise.py`: cold-start, current
   multiband AGC, both variants, transcribed with the server's whisper
   flags) points the same way:

   | capture | RNNoise on | RNNoise off (multiband) | RNNoise off (HP + scalar) |
   |---|---|---|---|
   | 174654 (GT unknown) | "(indistinct)" | "Not that much, just chill out" | "Not that much, just chill out" — **both recover speech from a failure** |
   | 175059 (GT known) | WER 1.17 | WER 0.67 "Not too much, just chilling" | WER 0.67 (identical) |
   | 175228 (GT known) | WER 2.00 | WER 2.00 (keeps "…much, just chilling") | WER 1.50 "It's not a lot of stress" |
   | 174756 (GT known) | WER 3.33 | WER 3.33 | WER 3.17 |
   | 171839 (GT unknown) | "The last purchase…" | "My last purchase…" | "My last purchase…" |
   | 182013 (GT unknown) | "May I hide in" | "Hi, how are you doing" | "Hi, how are you doing" — DeepFilterNet independently heard "Hey, how are you doing" on the same raw audio (§5) |
   | 182114 | repetition loop | repetition loop | repetition loop (both fail) |
   | 182445 | "Thank you." — input is −78.6 dBFS ≈ silence | "[MUSIC]" | "[MUSIC]" (both fail; RNNoise suppressed the turn to silence) |

   RNNoise off is at least as good on every row, clearly better on two
   (174654, 182013), and never makes a GT-scored capture worse. **The
   HP + scalar variant** (`scripts/ab_denoise.py`, a 90 Hz high-pass + ONE
   scalar AGC with the multiband's target/cap/gate/limiter params) matches
   or beats the multiband on every row — 3.17/0.67/1.50 vs 3.33/0.67/2.00
   on the GT-scored captures, identical transcripts on the recovered ones.
   The old single-band AGC (git history, commit a904fe0^) had no
   high-pass, which is why its gain went to the rumble: the HP is the
   load-bearing piece, and the multiband's per-band split buys little on
   this data. Caveats: only the 18:xx captures postdate the multiband AGC
   (commit a904fe0, 18:18) and replay faithfully — 182013's sim-vs-live
   correlation is 0.856; the 17:xx rows are fair *within* the sim but their
   `.txt` baselines describe the old single-band chain; all variants start
   cold while the live filters are warm. Strongly suggestive, not
   conclusive — the deciding test is flipping `SON_DENOISE=0` in the
   running recorder for a day, and if the simpler chain holds live it's the
   candidate to swap in. The two denoisers bracket whisper's tolerance:
   DeepFilterNet (§5) made every row worse, RNNoise removal improves some —
   consistent with
   [whisper#2125](https://github.com/openai/whisper/discussions/2125): the
   model must be *trained* on the enhanced spectrum (see lever 5).
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

## 4. Model swaps to try locally (web research, 2026-08-20)

Whisper and Parakeet aren't the only local options. Researched via the real
Chrome profile; every claim below is a vendor or paper claim, so A/B them on
the quiet-* captures before trusting them (`scripts/bench_stt_models.py`).

### Drop-in (sherpa-onnx, same picker as Parakeet)

- **Moonshine base-en int8** (`sherpa-onnx-moonshine-base-en-int8`):
  27–331M, whisper-family decoder; WER claims near large-v3; quiet-speech
  robustness unproven — the last untested local candidate.

### Ruled out for this use case

- **GLM-ASR-Nano-2512** — the only open model with an explicit low-volume
  training claim ("specifically trained for whisper/quiet speech scenarios");
  tested 2026-08-20 and failed the A/B: WER 1.00 on both GT-scored quiet
  captures (whisper hears them exactly), a repetition loop on 182114, and
  Chinese/empty transcripts on the post-AGC dumps. Seq2seq, so not immune to
  whisper's hallucination class.
- **FunASR-Nano-2512 int8** — NAR (architecturally cannot do whisper's
  confident hallucination) but tested 2026-08-20 and drifted to
  Chinese/Japanese on 5 of 8 quiet captures, with a loop on raw audio too.
- **Qwen3-ASR** — Mega-ASR (arXiv, 2026-05) reports 100% WER on far-field
  quiet audio (empty transcript); also an unfixed endless-token-repetition
  bug (GH #129).
- **Canary-Qwen 2.5B** — the best robustness numbers anywhere (2.41% WER
  @ 10 dB SNR) but NVIDIA NeMo + GPU only; no Apple Silicon path. Revisit if
  Son ever runs on an NVIDIA box.
- **Cohere Transcribe 2B** — no int8/CPU export; fp32 too heavy on this Mac.
- **FireRedASR2** — 60 s hard input cap; the LLM variant needs 32 GB VRAM.
- **Dolphin (base/small)**, **IBM Granite Speech 8B** — no robustness
  evidence, or too heavy for local.

### A/B results (same day, `scripts/bench_stt_models.py`)

Both top candidates were tested on all 8 quiet captures (pre- and post-chain)
the day the doc was written. WER is against the three captures with known
ground truth (whisper hears these *correctly*, so a replacement must match
or beat it):

| capture | whisper-small-son-soft | GLM-ASR-Nano-2512 (mps fp16) | FunASR-Nano-2512 (int8) |
|---|---|---|---|
| 174756 "I'm just swimming with a flow…" | 2.6 (correct, long-form) | 3.17 "Just wing it, the flow…" | 3.17 "Just going with the flow…" |
| 175059 "I don't know much, just chilling." | **0.00** ✅ | 1.00 "Okay, my sister." | 1.00 `/sil あ、友達助してる？` |
| 175228 "Nothing more, just chilling." | **0.00** ✅ | 1.00 "It's not lustrous. Nothing was just chilling." | 1.00 "It's not illustrious…" |

On the five captures without ground truth (171839, 174654 mishears + three
post-AGC dumps): GLM produced plausible-but-wrong English or Chinese
(`'你好，点'` on 182013, empty transcript on 182445), and **looped the
repetition signature on 182114** ("…STT failing me. STT failing me. It's just
STT failing me…") — the exact hallucination class the NAR architecture was
supposed to dodge; GLM is seq2seq, so this is consistent with §4's caveat.
FunASR drifted to Chinese/Japanese on 5 of 8 (`'我真的是气人。'`, `'うん。'`)
and looped on the raw 182114 pre capture.

**Verdict: neither model replaces whisper-small-son-soft.** The low-volume
training-data claim did not transfer to these captures at default decode
settings; both are also 3–4× the model size for no gain. The enhancement
chain remains the right lever (both models score better on the enhanced
post-chain audio than on raw), and the cloud STTs' edge on quiet speech is
their *trained frontend* (PCEN), which no local model swap reproduces. Next
levers, in order: A/B `SON_DENOISE=0` live, gen3 fine-tune with the real
runtime chain applied to training audio (§3A.5), then Calm-Whisper-style
decoder-head tuning (§3C.10) — and, if quiet speech still mishears after
that, a per-turn cloud fallback on the quiet-turn trigger.

### Why any of these should help (and might not)

The 2025–26 robustness recipe is "encoder + LLM decoder trained on
real-world, loudness-varied audio" — the same recipe as Grok STT and Chirp,
now open-sourced. NAR models (Parakeet) fix the other half: whisper's
decoder always emits a confident continuation, while NAR decoders can emit
blank instead. Neither replaces the enhancement chain: PCEN-lite + a
robustness-trained model is the full local emulation of the cloud
frontends.

## 5. Enhancement-tool survey — the pasted table, evaluated (2026-08-20)

A comparison table (RNNoise / DeepFilterNet 3 / WebRTC APM via
pywebrtc-audio / Krisp, plus virtual-mic setups) landed in the session; every
row was checked against what actually exists and what Son can use, and the
one tool that could plausibly help was A/B'd on the quiet captures.

| tool | claim | verdict |
|---|---|---|
| RNNoise | ~10 ms | already in the chain (`SON_DENOISE`); the A/B question from §3A.4 is still open |
| DeepFilterNet 3 | 10–40 ms, best open-source | A/B'd below — **degrades whisper on every quiet capture**; also no clean macOS real-time path |
| WebRTC APM via pywebrtc-audio | — | `pywebrtc-audio 0.0.1` is an empty placeholder (1-byte `__init__.py`). The real APM is a C++ module whose AGC is single-band — strictly worse than the multiband AGC (§3A.2) Son already has |
| Krisp | on-device | commercial closed SDK; no local integration path |
| NoiseTorch-ng / Easy Effects / VB-Audio Cable / OBS | virtual-mic routing | Linux/Windows routing tools; Son's chain is already in-process (`audio_filters.py`), a virtual-mic detour adds latency for nothing |

**DeepFilterNet 3 A/B.** Run with the prebuilt `deep-filter-0.5.6-aarch64-apple-darwin`
binary + the official ONNX models (`DeepFilterNet3_onnx.tar.gz`) on all 16
quiet captures, both at default attenuation (full suppression) and `-a 6`
(gently limited), then transcribed with whisper-small-son-soft under the same
flags as the live server. WER against the known-GT captures (same REFERENCE
strings as `scripts/bench_stt_models.py`):

| capture | whisper on chain output | + DeepFilterNet (default) | + DeepFilterNet (`-a 6`) |
|---|---|---|---|
| 174756 "I'm just swimming with a flow…" | 2.50 | 2.83 | 3.17 |
| 175059 "I don't know much, just chilling." | **0.00** ✅ | 1.17 ❌ | 0.83 ❌ |
| 175228 "Nothing more, just chilling." | **0.00** ✅ | 2.00 ❌ | 2.00 ❌ |

The DNN denoiser makes *every* row worse and breaks the two captures whisper
currently gets exactly right; the gentle `-a 6` limit does not rescue them
("The mic is just chilling" / "It's not a lot of stress…"). On the misheard
captures it just substitutes different wrong words (174654 → "Okay, now it's
the first channel"). Mechanism is the §3A.4 class: the suppressor eats the
low-level speech components, and whisper's static log-mel frontend has no way
to reconstruct them. Integration would be blocked anyway — the PyPI package
needs `libdf` (Rust extension, not on PyPI), the real-time LADSPA path is
Linux/PipeWire-only, and the prebuilt binary is a file CLI, not an embeddable
library — so this closes the question on both axes.

**What survives:** the in-process chain with the multiband AGC stays; the
tool's answer to "does enhancement help" is *loudness normalization yes, noise
suppression no*. Remaining levers in order: A/B `SON_DENOISE=0` live (§3A.4),
gen3 fine-tune with the runtime chain applied to training audio (§3A.5), then
Calm-Whisper-style decoder-head tuning (§3C.10).

## 6. Sources

- [PCEN: trainable frontend for robust and far-field keyword spotting (Sainath et al., ICASSP 2017)](https://research.google/pubs/trainable-frontend-for-robust-and-far-field-keyword-spotting/)
- [Whisper's architecture and known failure modes (multigrid.ai)](https://multigrid.ai/learn/whisper-explained)
- [do whisper need preprocessing, enhancing, or denoising (openai/whisper #2125)](https://github.com/openai/whisper/discussions/2125)
- [Hallucination on audio with no speech (openai/whisper #1606)](https://github.com/openai/whisper/discussions/1606)
- [Grok STT/TTS API announcement (x.ai)](https://x.ai/news/grok-stt-and-tts-apis)
- [Calm-Whisper: reduce hallucination by fine-tuning 3 decoder heads (arXiv:2505.12969)](https://arxiv.org/abs/2505.12969)
- [GLM-ASR-Nano-2512 model card (zai-org)](https://huggingface.co/zai-org/GLM-ASR-Nano-2512)
- [Mega-ASR: in-the-wild² speech recognition (2026-05)](https://github.com/xzf-thu/Mega-ASR)
- [sherpa-onnx pre-trained model index](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/index.html)
- [Best open-source speech-to-text models in 2026 (Gladia)](https://www.gladia.io/blog/best-open-source-speech-to-text-models)
- [ASR in 2025–2026: a deep dive into model selection (ruoqijin.com)](https://ruoqijin.com/blog/asr-deep-dive-2025-2026)
- [DeepFilterNet 3 (RikVoort) — repo and macOS prebuilt `deep-filter` binary](https://github.com/RikVoort/deep-filter)
- Local captures: `~/.cache/son/debug/quiet-*.{pre,post}.wav` + `*.txt`

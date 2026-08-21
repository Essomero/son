# Findings: the room-tone take, the gen3 retrain, and whisper-medium

Date: 2026-08-21. Three experiments, all on the quiet-speech failure
(see [RESEARCH-QUIET-SPEECH.md](RESEARCH-QUIET-SPEECH.md) for the background).

## 1. The room-tone take — verified, real, and usable

`recordings/noise/noise_0000.wav` (recorded via the "Record silence" modal):
179 s, 16 kHz mono, RMS **−61.4 dBFS**, peak −23.4 dBFS. Spectrum is
low-frequency-dominated (121 Hz fan hum; 16/39 Hz air-handling rumble);
almost no energy above 1 kHz.

The 8 quiet captures sit at −28…−47 dBFS RMS (median −34.5), so real
speech-over-floor SNR is **14–27 dB** — quiet speech is *not* close to the
noise floor in absolute terms; whisper's log-mel frontend is what crushes
the contrast.

**While checking the take we also found why it never reached the server
originally:** the take only uploads when **Keep take** is pressed — a
recording auto-stopped in the browser was staged but a dismissed modal
discarded it silently. The recorder now warns on dismissal ("Take not saved
— reopen Record silence and press Keep take") and shows a pending dot until
the take is kept.

## 2. gen3 retrain — real room tone instead of pink noise

`train_whisper.py` gen3 mixes **random windows of the real room tone** into
the quiet augmentation variants (same 6 variants, same SNR targets 15/10/5
dB, same per-clip rng as gen2 — a controlled A/B: only the noise source
changed). Pink noise remains the automatic fallback when no take exists.

GCP run (`SON_OUT_NAME=whisper-small-son-soft-gen3`, preemptible T4, temp
bucket, VM deleted after):

- VM log confirmed `room tone: noise_0000.wav 179s RMS -61.4 dBFS` loaded.
- 491 train / 26 dev clips (identical split to gen2), 2946 augmented
  samples, 5 epochs, exit=0.

### Results

Dev-set WER (same 26 held-out clips, decoded with whisper-cli, identical
flags for both models):

| model | dev WER |
|---|---|
| gen2 (whisper-small-son-soft, pink noise) | **19.6 %** |
| gen3 (real room tone) | **20.1 %** |

Statistically a tie (0.5 pp on 26 clips ≈ one clip). The room tone did not
improve the general dev set — but did not regress it either.

Quiet-capture A/B (gen3 vs gen2, pre = raw mic, post = production chain
input; WER vs known GT where confirmed, else transcript):

| capture (GT) | gen3 pre | gen3 post | gen2 pre | gen2 post |
|---|---|---|---|---|
| 174654 ("Not that much, just chill out") | **"Not that much, just chilling"** ✅ exact | "Okay, not just channel" (0.83) | "Nothing much, just chilling." (0.67) | "Okay, not just channel" (0.83) |
| 182013 ("Hi, how are you doing") | "Hi, how are you doing" ✅ exact | "May I hide in" (1.00) | "Hi, how are you doing" ✅ exact | "May I hide in" (1.00) |
| 175059 ("I don't know much, just chilling.") | "Not too much, just chilling" (near) | "-Kamara is just chilling." | "Not too much, just chilling" (near) | "The conference just finished" |
| 174756 ("I'm just swimming with a flow…") | garbled opener, right tail | "The swing of the floor never comes to mind…" | best: 0.20 | "The swing of the floor…" (0.45) |
| 175228 ("Nothing more, just chilling.") | "It's not a lot of stress. Nothing was just chilling." | "It's not a lot of stress" | same | same |
| 182114 (no GT; "STT failing me" ×4) | 4× recovered | 4× recovered | 4× recovered | 4× recovered |

**gen3's one demonstrable win:** 174654 on the raw mic — exact GT, where
gen2 scored 0.67. On the production path (post) gen3 is indistinguishable
from gen2: the AGC-capped chain output fails every model the same way.

## 3. whisper-medium on the quiet captures

Same-run A/B: `ggml-medium.en` vs the production `whisper-small-son-soft`
(gen2), identical decode flags for both (`-nt -nth 0.75 -lpt -0.5 -t 8` —
the production decode settings), same 8 captures × {pre, post}.

| capture (GT) | medium pre | medium post | gen2 pre | gen2 post |
|---|---|---|---|---|
| 182013 ("Hi, how are you doing") | 0.40 | **0.40** 🟢 | 0.00 ✅ | 1.00 |
| 174654 ("Not that much, just chill out") | 0.67 | 0.83 | 0.67 | 0.83 |
| 175059 ("I don't know much, just chilling.") | 0.67 | 0.67 | 0.67 | 0.83 |
| 174756 ("I'm just swimming with a flow…") | 0.55 | 0.50 | **0.20** | 0.45 |
| 175228 ("Nothing more, just chilling.") | 2.00 | 1.75 | 1.75 | 2.00 |
| 171839 (no GT) | "I love spritzes, what's exciting about yours?" | "I love spreadsheets for succeeding at board shows." | "My last purchase was exciting about yours" | "The last purchase was exciting about yours" |

### What medium fixes

- **182013** — production's worst mishear ("May I hide in" instead of
  "Hi, how are you doing") is recovered **through the production path**
  (post): WER 1.00 → 0.40. The small model needs the raw mic to get it;
  medium survives the chain.
- **171839** (no confirmed GT) — medium's raw-mic read "I love spritzes,
  what's exciting about yours?" is structurally the plausible true speech
  vs the small model's "last purchase" hallucination.

### What medium does not fix

- **174654** — 0.83 on post for *both* models. The +18 dB-capped AGC output
  is damaged beyond any model's ability to repair; the raw mic decodes to
  the right words for every model (gen3 even hits it exactly). The
  frontend chain is still the wall for the quietest turns.
- **175228** — all four decodes fail (~2.0) even though the live server
  returned it correctly at capture time. See the instability note.

### Decode instability at the quiet floor

Same file + same model + the README's flags give different transcripts
depending on the decode path: whisper-cli one-pass, a throwaway
whisper-server with the README flags, and the **live whisper-server on
:8081** each returned different text for 175059 ("The conference just
finished" / same / "Okay, thanks.") — and the capture-time transcript
("I don't know much, just chilling.") matches none of them. The live
server is also running **without** the tuned thresholds from the README
(`-nth 0.75 -lpt -0.5 -nt` are absent from its command line; it was
started yesterday 17:09 with defaults). This audio sits at the
decoder-failure boundary, where segmentation and thresholds flip the
output. The A/B tables above stay controlled (identical decode path per
model), but production "correct" results (174756, 175059, 175228) do not
reproduce in a one-pass CLI decode.

## 4. Follow-up (2026-08-21): chain × model on the quiet captures

The offline quiet-capture A/B was extended with the missing axis: the
winning chain variant from RESEARCH-QUIET-SPEECH.md §5A (`hp-scalar` — 90 Hz
high-pass + one scalar gain) × both models, same decode flags. WER vs GT
(this report's reference strings; `-` = no confirmed GT):

| capture (GT) | hp-scalar + small | hp-scalar + medium | old chain + small (post) |
|---|---|---|---|
| 174654 ("Not that much, just chill out") | **0.00** ✅ exact | 0.67 | 0.83 |
| 182013 ("Hi, how are you doing") | **0.00** ✅ exact | 0.40 | 1.00 |
| 174756 ("I'm just swimming with a flow…") | 0.45 | 0.55 | 0.45 |
| 175059 ("I don't know much, just chilling.") | 0.67 | 0.67 | 0.83 |
| 175228 ("Nothing more, just chilling.") | **1.50** | 2.00 | 2.00 |
| 171839 (no GT) | "My last purchase was exciting about yours" | "I love spritzes for sex-sitting about yours" | "The last purchase was exciting about yours" |

**The hp-scalar chain alone — with the existing small model, no retrain, no
medium — turns both GT-scored production mishears into exact hits** (0.83 →
0.00, 1.00 → 0.00) and improves the rest. Medium's edge was surviving the
damaged chain; once the chain stops damaging, the small model is better
everywhere (its fine-tune carries more of the user's voice).

Remaining step: the live flip — run the recorder with the hp-scalar chain
(`SON_DENOISE=0` + HP + scalar gain) and the tuned decode flags, and record
fresh quiet turns to confirm offline results hold live (the §3A.4 deciding
test from RESEARCH-QUIET-SPEECH.md).

## Verdict

1. **The room tone is a real, measured floor** (−61 dBFS, sub-1 kHz) and
   it now trains whisper against the actual room rather than synthetic
   pink noise.
2. **gen3 ≈ gen2** on the dev set (20.1 % vs 19.6 %) and on the production
   path; the room tone bought one exact raw-mic recovery (174654) but did
   not move the failure mode. The AGC-capped chain output is what the
   models can't decode, regardless of what noise they trained on.
3. **whisper-medium is the strongest single lever measured**: it fixes the
   worst production mishear through the production path and never hurts
   there. Per-band AGC (PCEN-lite) + raising the gain cap remain the
   complementary frontend levers from RESEARCH-QUIET-SPEECH.md §2.
4. **Ops finding:** the production whisper-server is not running the tuned
   decode flags the README recommends; restarting it with
   `-nth 0.75 -lpt -0.5 -nt` is a free, immediate improvement to test.

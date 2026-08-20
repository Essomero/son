#!/usr/bin/env python3
"""A/B the quiet-speech captures across local STT models.

Feeds every ~/.cache/son/debug/quiet-* capture (pre- and post-filter) to a
model and prints its transcript per capture, so the quiet-speech failures
in docs/RESEARCH-QUIET-SPEECH.md can be re-judged per model. Models share
one interface: (wav_path) -> text. No API keys, no audio leaving the box;
model weights download on first use.

    uv run python scripts/bench_stt_models.py glm        # GLM-ASR-Nano-2512 (MPS/CPU)
    uv run python scripts/bench_stt_models.py funasr     # FunASR-Nano-2512 int8 (CPU)
    uv run python scripts/bench_stt_models.py parakeet   # the in-repo Parakeet TDT v3
    uv run python scripts/bench_stt_models.py all

Captures whose reference phrase is known (docs/RESEARCH-QUIET-SPEECH.md §2)
are scored with WER; the rest print the raw transcript for a human verdict.
"""

import argparse
import wave
from pathlib import Path

import numpy as np

# Ground truth from docs/RESEARCH-QUIET-SPEECH.md §2, by capture timestamp.
# Only the rows whisper heard CORRECTLY are included — 171839/174654 are
# whisper's mishears (no known ground truth), so scoring a model against
# them would credit whoever repeats whisper's mistake.
REFERENCE = {
    "174756": "I'm just swimming with a flow",
    "175059": "I don't know much, just chilling.",
    "175228": "Nothing more, just chilling.",
}

DEFAULT_CAPTURES = Path.home() / ".cache" / "son" / "debug"


def load_wav(path: Path, rate: int = 16000) -> np.ndarray:
    """Read a mono int16 WAV and return float32 in [-1, 1] at `rate` Hz."""
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        n = w.getnframes()
        data = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    if sr != rate:
        # resample_poly keeps the phase right for speech; captures are
        # 48 kHz (pre-chain mic) or 16 kHz (post-chain), so this is a
        # straight 1/3 or 1/1 step.
        from scipy.signal import resample_poly

        gcd = np.gcd(sr, rate)
        data = resample_poly(data, rate // gcd, sr // gcd)
    return data


def wer(reference: str, hypothesis: str) -> float:
    from jiwer import wer as jiwer_wer

    return jiwer_wer(reference, hypothesis)


# --- model runners: each returns (text, note) ---------------------------------


def run_glm(path: Path) -> tuple[str, str]:
    import torch
    from transformers import AutoModelForSeq2SeqLM, AutoProcessor

    model_id = "zai-org/GLM-ASR-Nano-2512"
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    dtype = torch.float16 if device == "mps" else torch.float32
    processor = AutoProcessor.from_pretrained(model_id)
    # .to() rather than device_map="mps": accelerate's device-map path for
    # mps is unsupported and dies silently mid-load.
    model = AutoModelForSeq2SeqLM.from_pretrained(model_id, dtype=dtype).to(device)
    audio = load_wav(path, processor.feature_extractor.sampling_rate)
    inputs = processor.apply_transcription_request([audio])
    # Float inputs must match the model dtype (fp16 on MPS — no autocast) or
    # the first conv raises "Input type (float) and bias type (Half)". Int
    # tensors (input_ids) move as-is.
    inputs = {
        k: v.to(device=device, dtype=dtype) if v.is_floating_point() else v.to(device=device)
        for k, v in inputs.items()
    }
    with torch.no_grad():
        out = model.generate(**inputs, do_sample=False, max_new_tokens=500)
    text = processor.batch_decode(out[:, inputs["input_ids"].shape[1] :], skip_special_tokens=True)[0]
    return text.strip(), f"glm ({device})"


def run_funasr(path: Path) -> tuple[str, str]:
    import sherpa_onnx

    model_id = "csukuangfj/sherpa-onnx-funasr-nano-int8-2025-12-30"
    cache = Path.home() / ".cache" / "son" / "funasr-nano"
    base = cache / model_id.rsplit("/", 1)[-1]
    files = {
        "encoder_adaptor": base / "encoder_adaptor.int8.onnx",
        "llm": base / "llm.int8.onnx",
        "embedding": base / "embedding.int8.onnx",
    }
    tokenizer_dir = base / "Qwen3-0.6B"
    import requests

    for name, dest in files.items():
        if dest.is_file():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        r = requests.get(
            f"https://huggingface.co/{model_id}/resolve/main/{dest.name}",
            stream=True,
            timeout=300,
        )
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(8192):
                f.write(chunk)
    tokenizer_dir.mkdir(parents=True, exist_ok=True)
    for fname in ("tokenizer.json", "vocab.json", "merges.txt"):
        if not (tokenizer_dir / fname).is_file():
            r = requests.get(
                f"https://huggingface.co/{model_id}/resolve/main/Qwen3-0.6B/{fname}",
                timeout=300,
            )
            r.raise_for_status()
            (tokenizer_dir / fname).write_bytes(r.content)
    recognizer = sherpa_onnx.OfflineRecognizer.from_funasr_nano(
        encoder_adaptor=str(files["encoder_adaptor"]),
        llm=str(files["llm"]),
        embedding=str(files["embedding"]),
        tokenizer=str(tokenizer_dir),
        num_threads=2,
        sample_rate=16000,
        language="en",
        itn=True,
    )
    samples = load_wav(path)
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, samples)
    recognizer.decode_stream(stream)
    return stream.result.text.strip(), "funasr-nano int8 (cpu)"


def run_parakeet(path: Path) -> tuple[str, str]:
    from parakeet_stt import PARAKEET_MODELS, _get_recognizer

    model_id = next(iter(PARAKEET_MODELS))
    recognizer, _ = _get_recognizer(model_id)
    samples = load_wav(path)
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, samples)
    recognizer.decode_stream(stream)
    return stream.result.text.strip(), "parakeet-tdt-0.6b-v3 int8 (cpu)"


RUNNERS = {
    "glm": run_glm,
    "funasr": run_funasr,
    "parakeet": run_parakeet,
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("model", choices=[*RUNNERS, "all"], nargs="?", default="all")
    ap.add_argument("--dir", type=Path, default=DEFAULT_CAPTURES)
    args = ap.parse_args()

    picks = list(RUNNERS) if args.model == "all" else [args.model]
    for pick in picks:
        fn = RUNNERS[pick]
        print(f"\n== {pick} ==")
        # Both the raw mic audio (pre) and the enhanced chain output (post)
        # — pre shows whether the model survives raw quiet audio on its own.
        for wav in sorted(args.dir.glob("quiet-*.wav")):
            # quiet-20260820-171839-post.wav -> parts[2] = HHMMSS stamp
            stamp, which = wav.name.split("-")[2], "pre" if "-pre." in wav.name else "post"
            ref = REFERENCE.get(stamp)
            text, note = fn(wav)
            tag = f"WER {wer(ref, text):.2f}" if ref else "no reference"
            print(f"{stamp} {which:4s}  {note}  {tag}  {text!r}")


if __name__ == "__main__":
    main()

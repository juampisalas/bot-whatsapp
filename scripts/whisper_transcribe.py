#!/usr/bin/env python3
"""One-shot faster-whisper CLI used by the bot (detect + transcribe)."""

from __future__ import annotations

import argparse
import json
import os
import sys


def load_model():
    from faster_whisper import WhisperModel

    model_name = os.environ.get("WHISPER_MODEL", "medium")
    device = os.environ.get("WHISPER_DEVICE", "auto")
    compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "default")
    return WhisperModel(model_name, device=device, compute_type=compute_type)


def pick_language(
    prior: str | None,
    detected: str | None,
    confidence: float,
    threshold: float,
) -> str | None:
    if confidence >= threshold and detected:
        return detected
    if prior:
        return prior
    if detected:
        return detected
    return None


def cmd_process(
    model,
    wav_path: str,
    preferred_language: str | None,
    confidence_threshold: float,
) -> int:
    from faster_whisper.audio import decode_audio

    audio = decode_audio(wav_path)
    detected, probability, _all_probs = model.detect_language(audio)
    language = pick_language(
        preferred_language,
        detected,
        float(probability or 0.0),
        confidence_threshold,
    )
    kwargs = {"beam_size": 5, "vad_filter": True}
    if language:
        kwargs["language"] = language
    segments, _info = model.transcribe(wav_path, **kwargs)
    text = "".join(segment.text for segment in segments).strip()
    print(
        json.dumps(
            {
                "text": text,
                "language": language or detected or "",
                "confidence": float(probability or 0.0),
            }
        )
    )
    return 0


def cmd_detect(model, wav_path: str) -> int:
    from faster_whisper.audio import decode_audio

    audio = decode_audio(wav_path)
    language, probability, _all_probs = model.detect_language(audio)
    payload = {
        "language": language or "",
        "confidence": float(probability or 0.0),
    }
    print(json.dumps(payload))
    return 0


def cmd_transcribe(model, wav_path: str, language: str | None) -> int:
    kwargs = {"beam_size": 5, "vad_filter": True}
    if language:
        kwargs["language"] = language
    segments, _info = model.transcribe(wav_path, **kwargs)
    text = "".join(segment.text for segment in segments).strip()
    print(json.dumps({"text": text}))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Local faster-whisper runner for bot-whatsapp")
    subparsers = parser.add_subparsers(dest="command", required=True)

    detect = subparsers.add_parser("detect", help="Detect spoken language")
    detect.add_argument("wav_path")

    transcribe = subparsers.add_parser("transcribe", help="Transcribe audio to plain text")
    transcribe.add_argument("wav_path")
    transcribe.add_argument("--language", default=None)

    process = subparsers.add_parser(
        "process",
        help="Detect language, apply policy, and transcribe in one model load",
    )
    process.add_argument("wav_path")
    process.add_argument("--preferred-language", default=None)
    process.add_argument("--confidence-threshold", type=float, default=0.8)

    args = parser.parse_args()
    model = load_model()

    if args.command == "detect":
        return cmd_detect(model, args.wav_path)
    if args.command == "transcribe":
        return cmd_transcribe(model, args.wav_path, args.language)
    if args.command == "process":
        return cmd_process(
            model,
            args.wav_path,
            args.preferred_language,
            args.confidence_threshold,
        )
    parser.error(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 - surface runner failures to the bot
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        raise SystemExit(1) from error

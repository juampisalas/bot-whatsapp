# Audio transcription with context-biased language

**Date:** 2026-09-01  
**Status:** Approved in chat; awaiting final review of this written spec  
**Goal:** Voice notes in summarized ranges become real transcripts via local open-source Whisper, with chat language as a soft prior (not a hard lock).

## Problem

Today `MediaModel.transcribe` under Ollama always fails with `audio transcription unavailable with this provider`. Summaries keep `[voice note, Ns]` markers. For a serious bot, voice notes must be transcribed locally without cloud STT, and language handling must prefer the chat’s language while still allowing a different language when the audio clearly uses one.

## Non-goals

- Cloud STT (OpenAI Whisper API, Deepgram, etc.)
- Transcribing video or documents
- Real-time / streaming transcription while messages arrive
- Changing image `describe` behavior (stays on the chat LLM / Ollama multimodal path)
- Auto-installing Python/ffmpeg via the bot process (ops remain documented prerequisites)

## Architecture

Enrichment stays lazy inside `enrichRange` (already called per day bucket while summarizing):

1. Download attachment if needed (existing).
2. For audio without a cached derivation: resolve a **language decision**, then `transcribe(path, mime, options?)`.
3. Upsert `attachment_derivations` (`kind=transcript`, `model=<whisper model id>`).
4. `renderTranscript` already shows `[voice note] <text>` when a derivation exists.

New pieces:

| Piece | Responsibility |
|--------|----------------|
| Chat language prior | Heuristic over recent text messages in the enrichment range (and optional future chat preference). |
| Whisper language probe | `faster-whisper` language detection on the converted audio. |
| Language policy | Soft prefer prior; high-confidence detection can override. |
| `ffmpeg` convert | `.ogg`/opus (and other WhatsApp audio) → 16 kHz mono wav. |
| Whisper runner | Local `faster-whisper` (CLI or small HTTP sidecar) behind `MediaModel`. |

```text
enrichRange(from, to)
  → L_chat = inferChatLanguagePrior(texts in range)   // once per range
  → for each audio without derivation:
       ensureDownloaded
       → ffmpeg → wav
       → whisper.detect_language(wav)
       → pickLanguage(L_chat, detection)
       → whisper.transcribe(wav, language=picked)
       → upsertDerivation (skip if transcript empty)
```

## Language policy (preference, not lock)

Inputs:

- **Prior** `L_chat`: majority / strongest signal from non-empty message texts in the same conversation range being enriched. If too little text, prior is `null`. Optional later: stored chat preference overrides the heuristic prior.
- **Detection** `(L_audio, confidence)` from Whisper’s language detection on the clip.

Decision:

1. If `confidence >= HIGH` (default **0.80**): use `L_audio` even if it differs from `L_chat`.
2. Else if `L_chat` is present: use `L_chat`.
3. Else: use `L_audio` (whatever detection returned), or let Whisper auto-select if detection is unusable.

Rationale: short/noisy notes often mis-detect; chat text is a good bias. Clearly foreign-language audio with high confidence must not be forced to Spanish.

Config knobs (env):

- `WHISPER_MODEL` (default `medium`; allow `large-v3` for quality)
- `WHISPER_LANGUAGE_CONFIDENCE` (default `0.80`)
- `WHISPER_BIN` / `WHISPER_URL` (how to invoke the runner)
- `FFMPEG_PATH` (default `ffmpeg` on `PATH`)

## MediaModel API

Extend transcription without breaking callers that ignore options:

```ts
type TranscribeOptions = {
  /** Soft prior from chat context; may be overridden by high-confidence detection. */
  preferredLanguage?: string | null
}

transcribe(path: string, mime: string | null, options?: TranscribeOptions): Promise<string>
```

Implementation (Whisper-backed):

1. Convert input file with ffmpeg when needed.
2. Run language detection on wav.
3. Apply policy with `preferredLanguage`.
4. Transcribe with the chosen language code.
5. Return plain text (no timestamps required for v1).

If ffmpeg or Whisper is missing/unreachable: log a clear warning and throw (enrichment already swallows errors and keeps the duration marker).

Ollama-backed `createMediaModel` today: keep image `describe`; replace audio stub with the Whisper-backed path when configured, otherwise keep current unavailable behavior.

## Chat language prior

v1 heuristic (no extra ML dependency):

- Collect non-empty `messages.text` in `[from, to)` for that conversation (same window as enrichment).
- Strip URLs; require a minimum amount of letters.
- Score with a small built-in signal set (e.g. Spanish vs English function words / character clues) **or** a tiny optional `franc`/`tinyld`-style detector if we accept a dependency.
- Return ISO-ish codes Whisper understands (`es`, `en`, …) or `null`.

v1 can start with **Spanish vs English vs null** if that covers this product; expand later. Do not call the chat LLM for language ID on every audio (latency/cost).

`enrichRange` / `enrichOne` loads texts once per range (or passes prior into the pool) so N audios share one prior.

## Ops / runtime

Prerequisites documented in README + `.env.example`:

- `ffmpeg` installed
- Python env or binary providing faster-whisper (exact packaging chosen in the implementation plan: sidecar script in-repo vs external service)

Bot process stays TypeScript/Bun; it shells out or HTTP-calls Whisper. No Python import inside Bun.

## Failure behavior

| Failure | Behavior |
|---------|----------|
| No ffmpeg | warn, no derivation, summary continues |
| Whisper down / timeout | warn, no derivation, summary continues |
| Empty transcript | **Skip upsert** so a later retry can fill it |
| Partial range with some audios failing | other attachments still enrich; summary ships |

## Testing

- Unit: language policy matrix (high conf override, low conf prior, null prior).
- Unit: chat prior heuristic on sample Spanish/English mixes.
- Media model: ffmpeg/whisper mocked; verifies convert → detect → pick → transcribe order.
- Enrich: preferred language computed once per range and passed into `transcribe`.
- Existing enrich tests keep working with FakeMedia.

## Success criteria

- Summarizing a chat with voice notes produces `[voice note] <transcript>` when Whisper is available.
- A Spanish chat prior does not force a high-confidence English voice note to Spanish.
- A short ambiguous note in a Spanish chat uses `es`.
- Missing Whisper does not crash control replies.

## Defaults for the implementation plan

Unless we change them in the plan:

1. **Runner:** in-repo one-shot CLI (`scripts/whisper_transcribe.py`) first; HTTP sidecar only if CLI latency with model reload hurts.
2. **Model default:** `medium` (override with `WHISPER_MODEL=large-v3`).
3. **Chat prior:** hand-rolled es/en heuristic in TypeScript for v1 (no new npm lang-id dependency).

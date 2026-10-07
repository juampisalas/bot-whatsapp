export type LanguageDetection = {
  language: string
  confidence: number
}

/**
 * Soft language pick: high-confidence audio detection wins; otherwise chat prior;
 * otherwise detected language or Whisper auto-select (undefined).
 */
export function pickTranscriptionLanguage(
  prior: string | null | undefined,
  detection: LanguageDetection,
  highConfidenceThreshold: number,
): string | undefined {
  const detected = detection.language?.trim()
  if (detection.confidence >= highConfidenceThreshold && detected) {
    return detected
  }
  if (prior?.trim()) return prior.trim()
  if (detected) return detected
  return undefined
}

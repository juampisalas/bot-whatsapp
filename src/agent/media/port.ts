export type TranscribeOptions = {
  /** Soft prior from chat context; may be overridden by high-confidence detection. */
  preferredLanguage?: string | null
}

export interface MediaModel {
  /** Model id used for image descriptions (LLM). */
  readonly describeModel: string
  /** Model id used for audio transcripts (Whisper). */
  readonly transcriptModel: string
  /** @deprecated Use describeModel or transcriptModel. */
  readonly model: string
  transcribe(path: string, mime: string | null, options?: TranscribeOptions): Promise<string>
  describe(path: string, mime: string | null): Promise<string>
}

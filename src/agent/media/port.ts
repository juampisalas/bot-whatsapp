export interface MediaModel {
  readonly model: string
  transcribe(path: string, mime: string | null): Promise<string>
  describe(path: string, mime: string | null): Promise<string>
}

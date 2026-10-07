import type { MediaModel, TranscribeOptions } from './port.ts'

type QueuedItem = { text: string } | { error: Error }

export type FakeMediaCall = {
  method: 'transcribe' | 'describe'
  path: string
  mime: string | null
  options?: TranscribeOptions
}

/**
 * Test double that returns pre-queued text (or errors) keyed by `localPath`.
 */
export class FakeMediaModel implements MediaModel {
  readonly describeModel: string
  readonly transcriptModel: string
  readonly calls: FakeMediaCall[] = []

  private readonly transcriptQueue = new Map<string, QueuedItem[]>()
  private readonly describeQueue = new Map<string, QueuedItem[]>()

  constructor(model = 'fake-media') {
    this.describeModel = model
    this.transcriptModel = model
  }

  get model(): string {
    return this.describeModel
  }

  enqueueTranscript(localPath: string, text: string): void {
    this.push(this.transcriptQueue, localPath, { text })
  }

  enqueueDescribe(localPath: string, text: string): void {
    this.push(this.describeQueue, localPath, { text })
  }

  enqueueTranscriptError(localPath: string, error: Error = new Error('FakeMediaModel: injected failure')): void {
    this.push(this.transcriptQueue, localPath, { error })
  }

  enqueueDescribeError(localPath: string, error: Error = new Error('FakeMediaModel: injected failure')): void {
    this.push(this.describeQueue, localPath, { error })
  }

  async transcribe(path: string, mime: string | null, options?: TranscribeOptions): Promise<string> {
    this.calls.push({ method: 'transcribe', path, mime, options })
    return this.take(this.transcriptQueue, path, 'transcribe')
  }

  async describe(path: string, mime: string | null): Promise<string> {
    this.calls.push({ method: 'describe', path, mime })
    return this.take(this.describeQueue, path, 'describe')
  }

  private push(queue: Map<string, QueuedItem[]>, path: string, item: QueuedItem): void {
    const list = queue.get(path) ?? []
    list.push(item)
    queue.set(path, list)
  }

  private take(queue: Map<string, QueuedItem[]>, path: string, method: string): string {
    const list = queue.get(path)
    const next = list?.shift()
    if (!next) {
      throw new Error(`FakeMediaModel: no queued ${method} for ${path}`)
    }
    if ('error' in next) throw next.error
    return next.text
  }
}

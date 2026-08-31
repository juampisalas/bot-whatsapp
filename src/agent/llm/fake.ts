import type { Llm, LlmGenerateInput, LlmGenerateResult } from './port.ts'

export type FakeLlmQueuedResponse = {
  text: string
  output?: unknown
  toolsToCall?: Array<{ name: string; input: Record<string, unknown> }>
}

type QueuedItem = FakeLlmQueuedResponse | { error: Error }

export class FakeLlm implements Llm {
  readonly provider = 'fake'
  readonly model = 'fake'
  readonly calls: LlmGenerateInput[] = []

  private readonly queue: QueuedItem[] = []

  enqueue(response: FakeLlmQueuedResponse): void {
    this.queue.push(response)
  }

  /** Next `generate` call records the input then throws `error`. */
  enqueueError(error: Error = new Error('FakeLlm: injected failure')): void {
    this.queue.push({ error })
  }

  async generate(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    this.calls.push(input)
    const next = this.queue.shift()
    if (!next) {
      throw new Error('FakeLlm: no queued responses')
    }

    if ('error' in next) {
      throw next.error
    }

    if (next.toolsToCall?.length && input.tools?.length) {
      for (const call of next.toolsToCall) {
        const match = input.tools.find((tool) => tool.name === call.name)
        if (!match) {
          throw new Error(`FakeLlm: unknown tool "${call.name}"`)
        }
        await match.execute(call.input)
      }
    }

    return {
      text: next.text,
      output: next.output ?? null,
    }
  }
}

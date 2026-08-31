import { expect, test } from 'bun:test'
import { FakeLlm } from '../../src/agent/llm/fake.ts'

test('returns an enqueued response then throws when the queue is empty', async () => {
  const fake = new FakeLlm()
  fake.enqueue({ text: 'hello', output: { kind: 'help' } })

  const result = await fake.generate({ system: 's', prompt: 'p' })
  expect(result).toEqual({ text: 'hello', output: { kind: 'help' } })
  expect(fake.calls).toHaveLength(1)
  expect(fake.calls[0]).toEqual({ system: 's', prompt: 'p' })

  await expect(fake.generate({ system: 's', prompt: 'again' })).rejects.toThrow(
    /no queued responses/i,
  )
})

test('enqueueError records the call then throws', async () => {
  const fake = new FakeLlm()
  fake.enqueueError(new Error('injected'))

  await expect(fake.generate({ system: 's', prompt: 'p' })).rejects.toThrow(/injected/)
  expect(fake.calls).toHaveLength(1)
})

test('executes toolsToCall against provided tools before returning', async () => {
  const fake = new FakeLlm()
  const seen: Record<string, unknown>[] = []
  fake.enqueue({
    text: 'done',
    output: null,
    toolsToCall: [{ name: 'search', input: { q: 'facu' } }],
  })

  await fake.generate({
    system: 's',
    prompt: 'p',
    tools: [
      {
        name: 'search',
        description: 'search',
        inputSchema: {},
        execute: async (input) => {
          seen.push(input)
          return []
        },
      },
    ],
  })

  expect(seen).toEqual([{ q: 'facu' }])
})

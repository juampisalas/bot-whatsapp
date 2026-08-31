import { expect, test } from 'bun:test'
import { createLlm } from '../../src/agent/llm/registry.ts'
import { loadConfig } from '../../src/config/index.ts'

const base = { DATABASE_URL: 'postgres://bot:bot@localhost:5433/botwhatsapp' }

test('createLlm for openai does not throw without an API key at construction', () => {
  const config = loadConfig({ ...base, LLM_PROVIDER: 'openai', LLM_MODEL: 'gpt-4.1-mini' })
  const llm = createLlm(config)
  expect(llm.provider).toBe('openai')
  expect(llm.model).toBe('gpt-4.1-mini')
})

test('createLlm builds adapters for each configured provider', () => {
  expect(createLlm(loadConfig({ ...base, LLM_PROVIDER: 'ollama' })).provider).toBe('ollama')
  expect(
    createLlm(
      loadConfig({ ...base, LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant' }),
    ).provider,
  ).toBe('anthropic')
  expect(
    createLlm(
      loadConfig({ ...base, LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'sk-ds' }),
    ).provider,
  ).toBe('deepseek')
})

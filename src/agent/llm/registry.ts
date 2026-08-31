import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAI } from '@ai-sdk/openai'
import {
  generateText,
  isStepCount,
  Output,
  tool,
  type FlexibleSchema,
  type ToolSet,
} from 'ai'
import { createOllama } from 'ai-sdk-ollama'
import type { Config } from '../../config/index.ts'
import type { Llm, LlmGenerateInput, LlmGenerateResult, LlmTool } from './port.ts'

const TOOL_STOP_STEPS = 4

export function createLlm(config: Config): Llm {
  switch (config.LLM_PROVIDER) {
    case 'ollama':
      return createOllamaLlm(config)
    case 'openai':
      return createOpenAiLlm(config)
    case 'anthropic':
      return createAnthropicLlm(config)
    case 'deepseek':
      return createDeepSeekLlm(config)
  }
}

function createOllamaLlm(config: Config): Llm {
  const ollama = createOllama({ baseURL: config.LLM_BASE_URL })
  return sdkLlm({
    provider: 'ollama',
    modelId: config.LLM_MODEL,
    model: () => ollama(config.LLM_MODEL),
  })
}

function createOpenAiLlm(config: Config): Llm {
  const openai = createOpenAI({ apiKey: config.OPENAI_API_KEY })
  return sdkLlm({
    provider: 'openai',
    modelId: config.LLM_MODEL,
    model: () => openai(config.LLM_MODEL),
  })
}

function createAnthropicLlm(config: Config): Llm {
  const anthropic = createAnthropic({ apiKey: config.ANTHROPIC_API_KEY })
  return sdkLlm({
    provider: 'anthropic',
    modelId: config.LLM_MODEL,
    model: () => anthropic(config.LLM_MODEL),
    cacheSystemPrompt: true,
  })
}

function createDeepSeekLlm(config: Config): Llm {
  const deepseek = createDeepSeek({ apiKey: config.DEEPSEEK_API_KEY })
  return sdkLlm({
    provider: 'deepseek',
    modelId: config.LLM_MODEL,
    model: () => deepseek(config.LLM_MODEL),
  })
}

type SdkLlmOptions = {
  provider: string
  modelId: string
  model: () => Parameters<typeof generateText>[0]['model']
  cacheSystemPrompt?: boolean
}

function sdkLlm(options: SdkLlmOptions): Llm {
  return {
    provider: options.provider,
    model: options.modelId,
    async generate(input: LlmGenerateInput): Promise<LlmGenerateResult> {
      const tools = toSdkTools(input.tools)
      const hasTools = tools !== undefined
      const hasSchema = input.schema != null

      const result = await generateText({
        model: options.model(),
        ...(options.cacheSystemPrompt
          ? {
              messages: [
                {
                  role: 'system' as const,
                  content: input.system,
                  providerOptions: {
                    anthropic: { cacheControl: { type: 'ephemeral' as const } },
                  },
                },
                { role: 'user' as const, content: input.prompt },
              ],
            }
          : {
              system: input.system,
              prompt: input.prompt,
            }),
        ...(tools ? { tools } : {}),
        ...(hasSchema
          ? { output: Output.object({ schema: input.schema as FlexibleSchema }) }
          : {}),
        ...(hasTools ? { stopWhen: isStepCount(TOOL_STOP_STEPS) } : {}),
      })

      return {
        text: result.text,
        output: hasSchema ? (result.output ?? null) : null,
      }
    },
  }
}

function toSdkTools(tools: LlmTool[] | undefined): ToolSet | undefined {
  if (!tools?.length) return undefined
  const set: ToolSet = {}
  for (const item of tools) {
    set[item.name] = tool({
      description: item.description,
      inputSchema: item.inputSchema as FlexibleSchema,
      execute: async (args) => item.execute(args as Record<string, unknown>),
    })
  }
  return set
}

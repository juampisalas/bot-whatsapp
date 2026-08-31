// src/agent/llm/port.ts
export interface LlmGenerateInput {
  system: string
  prompt: string
  tools?: LlmTool[]
  schema?: unknown
}

export interface LlmTool {
  name: string
  description: string
  inputSchema: unknown
  execute: (input: Record<string, unknown>) => Promise<unknown>
}

export interface LlmGenerateResult {
  text: string
  output: unknown
}

export interface Llm {
  readonly provider: string
  readonly model: string
  generate(input: LlmGenerateInput): Promise<LlmGenerateResult>
}

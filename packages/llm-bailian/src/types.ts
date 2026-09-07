import z from '@deepseek-ai/schemastery'

export type WireContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | WireContentPart[] }
  | {
      role: 'assistant'
      content: string
      reasoning_content?: string
      tool_calls?: WireToolCall[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options: { include_usage: true }
  tools?: WireTool[]
  temperature?: number
  max_tokens?: number
  max_completion_tokens?: number
  stop?: string[]
  enable_thinking?: boolean
  reasoning_effort?: string
  thinking_budget?: number
}

export interface WireChunk {
  choices: WireChoice[]
  usage?: WireUsage | null
}

export interface WireChoice {
  index: number
  delta?: WireDelta | null
  finish_reason?: string | null
}

export interface WireDelta {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: WireToolCallDelta[] | null
}

export interface WireToolCallDelta {
  index: number
  id?: string | null
  function?: { name?: string | null; arguments?: string | null } | null
}

export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_cache_hit_tokens?: number | null
  prompt_tokens_details?: { cached_tokens?: number | null; cache_write_tokens?: number | null } | null
  completion_tokens_details?: { reasoning_tokens?: number | null } | null
}

const count = z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER)
// Schemastery containers default to empty values; wire omission stays absent.
function optional<S, T>(schema: z<S, T>): z<S | null, T | null> {
  return z.union([z.const(null), schema.required()])
}

const toolCall = z.object({
  index: count.required(),
  id: z.string(),
  type: z.const('function'),
  function: optional(z.object({ name: z.string(), arguments: z.string() })),
}).required()

export const WireChunkSchema: z<WireChunk> = z.object({
  choices: z.array(z.object({
    index: count.required(),
    delta: optional(z.object({
      content: z.string(),
      reasoning_content: z.string(),
      tool_calls: optional(z.array(toolCall)),
    })),
    finish_reason: z.string().min(1),
  }).required()).required(),
  usage: optional(z.object({
    prompt_tokens: count.required(),
    completion_tokens: count.required(),
    prompt_cache_hit_tokens: count,
    prompt_tokens_details: optional(z.object({ cached_tokens: count, cache_write_tokens: count })),
    completion_tokens_details: optional(z.object({ reasoning_tokens: count })),
  })),
}).required()

export interface WireError {
  error?: { message?: string; type?: string; code?: string }
  message?: string
  code?: string
}

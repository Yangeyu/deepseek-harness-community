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
  choices?: WireChoice[]
  usage?: WireUsage | null
}

export interface WireChoice {
  delta?: WireDelta
  finish_reason?: string | null
}

export interface WireDelta {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: WireToolCallDelta[]
}

export interface WireToolCallDelta {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

export interface WireError {
  error?: { message?: string; type?: string; code?: string }
  message?: string
  code?: string
}

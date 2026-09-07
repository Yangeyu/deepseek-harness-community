import z from '@deepseek-ai/schemastery'
import { EMPTY_RESPONSE_CODE, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { WireChunkSchema, type WireChunk, type WireUsage } from './types.ts'

interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  toolIndex?: number
  callId?: string
  name?: string
}

export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: { message: `Bailian model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? undefined
  const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens ?? undefined
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? undefined
  return {
    inputTokens: Math.max(0, usage.prompt_tokens - (cacheRead ?? 0) - (cacheWrite ?? 0)),
    outputTokens: usage.completion_tokens,
    ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
    ...cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite },
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
  }
}

function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': {
      if (!block.callId?.trim() || !block.name?.trim()) {
        throw new LlmError(
          `Bailian choice 0 tool index ${String(block.toolIndex)} completed without a non-empty id or name`,
          'MALFORMED_RESPONSE',
        )
      }
      return {
        type: 'tool-call',
        id: ToolCallId(block.callId),
        name: block.name,
        arguments: block.text,
      }
    }
  }
}

function toolIdentity(
  previous: string | undefined,
  value: string | null | undefined,
  field: 'id' | 'name',
  index: number,
): string | undefined {
  if (!value) return previous
  if (previous !== undefined && previous !== value) {
    throw new LlmError(
      `Bailian choice 0 tool index ${String(index)} changed ${field} while streaming`
      + ` (${JSON.stringify(previous.slice(0, 80))} -> ${JSON.stringify(value.slice(0, 80))})`,
      'MALFORMED_RESPONSE',
    )
  }
  return value
}

export async function* translateResponse(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: order.length, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === '[DONE]') {
      const reason = pendingFinish ?? { kind: 'stop' as const }
      // Harness assembly drops unfinished tool calls at the token limit.
      const completed = reason.kind === 'error' || reason.kind === 'max-tokens'
        ? []
        : order.map(block => ({ type: 'block-end' as const, index: block.index, block: closeBlock(block) }))
      yield* completed
      if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
      if (reason.kind === 'error') throw new LlmError(reason.failure.message, reason.failure.code, reason.failure)
      if (reason.kind === 'stop' && order.length === 0) {
        throw new LlmError('Bailian model returned a completed response with no content', EMPTY_RESPONSE_CODE)
      }
      yield { type: 'finish', reason }
      return
    }

    let chunk: WireChunk
    try {
      chunk = WireChunkSchema(JSON.parse(payload))
    } catch (error: unknown) {
      const path = error instanceof z.ValidationError ? (error.options.path ?? []).map(String).join('.') : 'JSON'
      throw new LlmError(`Malformed Bailian SSE payload at ${path || 'root'}`, 'MALFORMED_RESPONSE')
    }

    const choice = chunk.choices.find(choice => choice.index === 0)
    if (choice !== undefined) {
      const reasoning = choice.delta?.reasoning_content
      if (reasoning) {
        if (reasoningBlock === undefined) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }

      const content = choice.delta?.content
      if (content) {
        if (textBlock === undefined) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }

      for (const call of choice.delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (block === undefined) {
          block = open('tool-call')
          block.toolIndex = call.index
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        const previousId = block.callId
        const callId = toolIdentity(previousId, call.id, 'id', call.index)
        const name = toolIdentity(block.name, call.function?.name, 'name', call.index)
        if (callId !== undefined) block.callId = callId
        if (name !== undefined) block.name = name
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        if (block.callId === undefined) continue
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(block.callId),
          ...block.name === undefined ? {} : { name: block.name },
          argumentsDelta: previousId === undefined ? block.text : fragment,
        }
      }

      if (choice.finish_reason) pendingFinish = mapFinishReason(choice.finish_reason)
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
  }
  throw new LlmError('Bailian response stream ended without [DONE]', 'STREAM_CLOSED')
}

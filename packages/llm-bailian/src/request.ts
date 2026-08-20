import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { ResolvedBailianModel } from './config.ts'
import { resolveMaxTokens, resolveReasoningLevel } from './model.ts'
import type { WireContentPart, WireMessage, WireRequest } from './types.ts'

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function imagePart(
  attachment: Extract<ContentBlock, { type: 'image' }>['attachment'],
  attachments: AttachmentStore | undefined,
  signal: AbortSignal,
): Promise<WireContentPart> {
  if (attachments === undefined) {
    throw new LlmError('Bailian image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
  }
  const stored = await attachments.readImage(attachment, signal)
  return {
    type: 'image_url',
    image_url: { url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}` },
  }
}

async function imageParts(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore | undefined,
  signal: AbortSignal,
): Promise<WireContentPart[]> {
  const images = blocks.filter(block => block.type === 'image')
  if (images.length === 0) return []
  return await Promise.all(images.map(({ attachment }) => imagePart(attachment, attachments, signal)))
}

async function orderedContentParts(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore | undefined,
  signal: AbortSignal,
): Promise<WireContentPart[]> {
  const parts = await Promise.all(blocks.map(async (block): Promise<WireContentPart | undefined> => {
    if (block.type === 'text') {
      return block.text === '' ? undefined : { type: 'text', text: block.text }
    }
    if (block.type !== 'image') return undefined
    return imagePart(block.attachment, attachments, signal)
  }))
  return parts.filter((part): part is WireContentPart => part !== undefined)
}

async function userContent(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore | undefined,
  signal: AbortSignal,
): Promise<string | WireContentPart[]> {
  if (!blocks.some(block => block.type === 'image')) return textOf(blocks)
  return orderedContentParts(blocks, attachments, signal)
}

function assistantMessage(message: Message): WireMessage {
  if (contentHasImage(message.content)) {
    throw new LlmError('Bailian does not support replaying assistant image blocks', 'UNSUPPORTED_CONTENT')
  }
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  return {
    role: 'assistant',
    content: textOf(message.content),
    ...reasoning.length === 0 ? {} : { reasoning_content: reasoning },
    ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
  }
}

async function serializeUserMessage(
  message: Message,
  attachments: AttachmentStore | undefined,
  signal: AbortSignal,
): Promise<WireMessage[]> {
  const wire: WireMessage[] = []
  const direct = message.content.filter(block => block.type !== 'tool-result')
  if (direct.length > 0) {
    wire.push({ role: 'user', content: await userContent(direct, attachments, signal) })
  }
  // First, emit all tool messages (required to be consecutive after assistant message with tool_calls)
  const toolResults = message.content.filter(block => block.type === 'tool-result')
  for (const result of toolResults) {
    const resultText = textOf(result.content)
    const hasImages = contentHasImage(result.content)
    wire.push({
      role: 'tool',
      tool_call_id: result.toolCallId,
      content: resultText.length > 0
        ? resultText
        : hasImages ? 'Image result attached in the following user message.' : '',
    })
  }
  // Then, emit all user messages with images (after all tool messages)
  for (const result of toolResults) {
    const hasImages = contentHasImage(result.content)
    if (hasImages) {
      const parts = await imageParts(result.content, attachments, signal)
      wire.push({
        role: 'user',
        content: [{ type: 'text', text: `Images returned by tool ${result.toolCallId}:` }, ...parts],
      })
    }
  }
  if (wire.length === 0) wire.push({ role: 'user', content: '' })
  return wire
}

export async function serializeMessages(
  options: GenerateOptions,
  attachments: AttachmentStore | undefined,
  signal: AbortSignal,
): Promise<WireMessage[]> {
  const wire: WireMessage[] = []
  if (options.system !== undefined) wire.push({ role: 'system', content: options.system })
  
  // Collect consecutive tool result messages to serialize them together
  let pendingToolResults: Message[] = []
  
  const flushToolResults = async () => {
    if (pendingToolResults.length === 0) return
    
    // First, emit all tool messages
    for (const message of pendingToolResults) {
      for (const result of message.content.filter(block => block.type === 'tool-result')) {
        const resultText = textOf(result.content)
        const hasImages = contentHasImage(result.content)
        wire.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: resultText.length > 0
            ? resultText
            : hasImages ? 'Image result attached in the following user message.' : '',
        })
      }
    }
    
    // Then, emit all user messages with images
    for (const message of pendingToolResults) {
      for (const result of message.content.filter(block => block.type === 'tool-result')) {
        const hasImages = contentHasImage(result.content)
        if (hasImages) {
          const parts = await imageParts(result.content, attachments, signal)
          wire.push({
            role: 'user',
            content: [{ type: 'text', text: `Images returned by tool ${result.toolCallId}:` }, ...parts],
          })
        }
      }
    }
    
    pendingToolResults = []
  }
  
  for (const message of options.messages) {
    if (message.role === 'assistant') {
      await flushToolResults()
      wire.push(assistantMessage(message))
    } else if (message.role === 'system') {
      await flushToolResults()
      if (contentHasImage(message.content)) {
        throw new LlmError('Bailian system messages do not support image blocks', 'UNSUPPORTED_CONTENT')
      }
      wire.push({ role: 'system', content: textOf(message.content) })
    } else {
      // Check if this is a tool result message
      const hasToolResults = message.content.some(block => block.type === 'tool-result')
      if (hasToolResults) {
        pendingToolResults.push(message)
      } else {
        await flushToolResults()
        wire.push(...await serializeUserMessage(message, attachments, signal))
      }
    }
  }
  
  // Flush any remaining tool results
  await flushToolResults()
  
  return wire
}

export async function serializeRequest(
  options: GenerateOptions,
  model: ResolvedBailianModel,
  attachments: AttachmentStore | undefined,
  signal: AbortSignal,
): Promise<WireRequest> {
  if (contentHasImage(options.messages.flatMap(message => message.content)) && !model.input.includes('image')) {
    throw new LlmError(`Bailian model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
  }
  const reasoning = resolveReasoningLevel(model, options.reasoningEffort, options.purpose)
  const maxTokens = resolveMaxTokens(model, options.maxTokens)
  return {
    model: model.id,
    messages: await serializeMessages(options, attachments, signal),
    stream: true,
    stream_options: { include_usage: true },
    ...options.tools === undefined || options.tools.length === 0
      ? {}
      : {
          tools: options.tools.map(tool => ({
            type: 'function' as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...maxTokens === undefined ? {} : { [model.maxTokensField]: maxTokens },
    ...options.stop === undefined ? {} : { stop: [...options.stop] },
    ...reasoning?.enableThinking === undefined ? {} : { enable_thinking: reasoning.enableThinking },
    ...reasoning?.reasoningEffort === undefined ? {} : { reasoning_effort: reasoning.reasoningEffort },
    ...reasoning?.thinkingBudget === undefined ? {} : { thinking_budget: reasoning.thinkingBudget },
  }
}

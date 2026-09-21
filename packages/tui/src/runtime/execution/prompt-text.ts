import { readVisionEvidence } from '../session/input.ts'

interface PromptTextBlock {
  readonly type: string
  readonly text?: string
}

function isPromptTextBlock(value: unknown): value is PromptTextBlock {
  if (typeof value !== 'object' || value === null) return false
  const block = value as Record<string, unknown>
  return typeof block['type'] === 'string'
    && (block['text'] === undefined || typeof block['text'] === 'string')
}

/** Project exact durable or Controller-wire text without inventing image positions. */
export function promptTextFromContent(content: readonly unknown[]): string {
  return content.filter(isPromptTextBlock)
    .filter(block => block.type === 'text' && readVisionEvidence(block) === undefined)
    .map(block => block.text ?? '')
    .join('')
}

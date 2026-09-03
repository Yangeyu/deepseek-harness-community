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
  const blocks = content.filter(isPromptTextBlock)
  const textBlocks = blocks
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
  const hasImages = blocks.some(block => block.type === 'image')
  return textBlocks.join(hasImages ? '' : '\n')
}

export interface PromptTextBlock {
  readonly type: string
  readonly text?: string
}

/** Project exact durable text without inventing image positions. */
export function promptTextFromContent(content: readonly PromptTextBlock[]): string {
  const textBlocks = content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
  const hasImages = content.some(block => block.type === 'image')
  return textBlocks.join(hasImages ? '' : '\n')
}

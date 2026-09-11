import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import type { ContextForm, Message } from '@deepseek-ai/dsh-llm'
import { sanitizeTerminalLine } from '../../presentation/primitives/text.ts'

const FORM_TITLES = new Map<ContextForm, string>([
  ['instructions', 'Workspace instructions'], ['catalog', 'Catalog'], ['snapshot', 'Context snapshot'],
  ['notice', 'Context update'], ['relay', 'Agent message'], ['recall', 'Recalled context'],
])

/** Bound work before sanitizing; never read an entire body just to label it. */
export function messageExcerpt(text: string): string {
  const prefix = text.slice(0, 96).split(/[\r\n]/u, 1)[0]!.replace(/[\uD800-\uDBFF]$/u, '')
  return sanitizeTerminalLine(prefix) + (text.length > prefix.length ? '…' : '')
}

function contentExcerpt(content: Message['content']): string {
  for (const block of content) {
    if (block.type === 'text' || block.type === 'reasoning') {
      if (block.text !== '') return messageExcerpt(block.text)
    } else if (block.type === 'tool-call') return `Call ${messageExcerpt(block.name)}`
    else if (block.type === 'tool-result') {
      const text = contentExcerpt(block.content)
      if (text !== '') return text
    } else return `${messageExcerpt(block.type)} attachment`
  }
  return ''
}

/** Provenance identifies a producer; protocol role does not identify a human. */
export function messageLabel(message: Message): { title: string; summary: string } {
  const source = message.source
  let title: string
  if (isCompactCheckpointSource(source)) title = 'Compaction checkpoint'
  else if (source.kind === 'user') title = 'User input'
  else if (source.kind === 'model') title = 'Assistant response'
  else if (source.kind === 'tool') title = 'Tool result'
  else if (source.kind === 'community-vision') title = 'Vision analysis'
  else {
    const producer = source.kind === 'plugin' ? source.plugin : source.kind
    const form = 'form' in source ? source.form : undefined
    const category = message.role === 'system' ? 'System instructions'
      : form === undefined ? 'Context' : FORM_TITLES.get(form) ?? 'Context'
    title = `${category} · ${messageExcerpt(producer)}`
  }
  const summary = 'form' in source && source.form === 'notice'
    ? messageExcerpt(source.summary) : contentExcerpt(message.content)
  return { title, summary }
}

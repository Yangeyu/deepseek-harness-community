import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import type { ModelRequestDocument } from '../../runtime/execution/projection/model-call.ts'
import { messageExcerpt, messageLabel } from './message-label.ts'

export interface RequestField {
  readonly key: string
  readonly sectionKey: string
  readonly path: string
  readonly text: string
}

export interface RequestBodyBlock {
  readonly field: RequestField
  readonly label?: string
}

export interface RequestToolGroup {
  readonly key: string
  readonly label: string
  readonly path: string
  readonly paths: readonly string[]
  fields(): Iterable<RequestField>
}

export interface RequestTool {
  readonly key: string
  readonly name: string
  readonly nameField: RequestField
  readonly summary: string
  readonly groups: readonly RequestToolGroup[]
}

export interface RequestSection {
  readonly key: string
  readonly label: string
  readonly summary?: string
  readonly kind: 'config' | 'tools' | 'message'
  readonly messageIndex?: number
  readonly category?: 'checkpoint' | 'tool' | 'message'
  readonly eventSeq?: number
  readonly value: unknown
}

type Message = ModelRequestDocument['request']['messages'][number]

function childPath(parent: string, key: string): string {
  if (/^[A-Za-z_$][\w$]*$/u.test(key)) return parent === '' ? key : `${parent}.${key}`
  return `${parent}[${JSON.stringify(key)}]`
}

/** Walk one field at a time, without reading sibling values until next(). */
function* walk(value: unknown, path: string, sectionKey: string): Iterable<RequestField> {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      if (value.length === 0) yield { key: `${sectionKey}:${path}`, sectionKey, path, text: '[]' }
      for (let index = 0; index < value.length; index++) {
        yield* walk(value[index], `${path}[${index}]`, sectionKey)
      }
    } else {
      const keys = Object.keys(value)
      if (keys.length === 0) yield { key: `${sectionKey}:${path}`, sectionKey, path, text: '{}' }
      for (const key of keys) {
        yield* walk((value as Record<string, unknown>)[key], childPath(path, key), sectionKey)
      }
    }
    return
  }
  // Optional undefined properties are absent from the canonical JSON document.
  if (value === undefined) return
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text !== undefined) yield { key: `${sectionKey}:${path}`, sectionKey, path, text }
}

function contentBody(content: Message['content'], root: string, key: string): RequestBodyBlock[] {
  return content.flatMap((block, index): RequestBodyBlock[] => {
    const path = `${root}[${index}]`
    if (block.type === 'tool-result') return contentBody(block.content, `${path}.content`, key)
    const property = block.type === 'text' || block.type === 'reasoning' ? 'text'
      : block.type === 'tool-call' ? 'arguments' : 'type'
    const fieldPath = `${path}.${property}`
    const text = block.type === 'text' || block.type === 'reasoning' ? block.text
      : block.type === 'tool-call' ? block.arguments : block.type
    const label = block.type === 'reasoning' ? 'Thinking'
      : block.type === 'tool-call' ? `Tool call · ${messageExcerpt(block.name)}`
        : block.type === 'image' || block.type === 'file' ? 'Attachment' : undefined
    return [{ field: { key: `${key}:${fieldPath}`, sectionKey: key, path: fieldPath, text }, ...label === undefined ? {} : { label } }]
  })
}

/** Current canonical Request only: no Session replay, body flattening, or Step cache. */
export class RequestDocument {
  readonly sections: readonly RequestSection[]
  readonly latestInputKey: string | undefined
  private readonly byKey: ReadonlyMap<string, RequestSection>
  private toolList: readonly RequestTool[] | undefined

  constructor(input: ModelRequestDocument) {
    const { request, provenance } = input
    // A shallow read-only config lens avoids copying values or eagerly reading fields.
    const config = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(request)) {
      if (key === 'messages' || key === 'tools') continue
      Object.defineProperty(config, key, { enumerable: true, get: () => request[key as keyof typeof request] })
    }
    const sections: RequestSection[] = [
      { key: 'config', label: 'Config', kind: 'config', value: Object.freeze(config) },
    ]
    if (request.tools !== undefined) {
      sections.push({ key: 'tools', label: `Tools · ${request.tools.length}`, kind: 'tools', value: request.tools })
    }
    const calls = new Map<string, string>()
    let latestInputKey: string | undefined
    let lastMessageKey: string | undefined
    for (const [messageIndex, message] of request.messages.entries()) {
      // Source seq comes exclusively from the aligned canonical provenance map.
      const origin = provenance[messageIndex]
      const eventSeq = origin?.messageId === message.id ? origin.seq : undefined
      const key = `message:${eventSeq === undefined ? `index-${messageIndex}` : eventSeq}:${message.id}`
      let toolName: string | undefined
      for (const block of message.content) {
        if (block.type === 'tool-call') {
          calls.set(block.id, block.name)
          toolName ??= block.name
        }
      }
      if (message.source.kind === 'tool') toolName = calls.get(message.source.callId)
      const category = isCompactCheckpointSource(message.source)
        ? 'checkpoint'
        : message.source.kind === 'tool' ? 'tool' : 'message'
      const { title, summary } = messageLabel(message)
      const name = category === 'tool' && toolName !== undefined ? `: ${messageExcerpt(toolName)}` : ''
      sections.push({
        key, label: `#${messageIndex + 1} ${title}${name}`, summary, kind: 'message',
        messageIndex, category, value: message,
        ...eventSeq === undefined ? {} : { eventSeq },
      })
      lastMessageKey = key
      if (message.source.kind === 'user') latestInputKey = key
    }
    this.sections = Object.freeze(sections.map(section => Object.freeze(section)))
    this.byKey = new Map(this.sections.map(section => [section.key, section]))
    this.latestInputKey = latestInputKey ?? lastMessageKey
  }

  section(key: string): RequestSection | undefined {
    return this.byKey.get(key)
  }

  /** Tool headers are cheap; schema values are walked only on expansion/search. */
  get tools(): readonly RequestTool[] {
    if (this.toolList !== undefined) return this.toolList
    const tools = this.byKey.get('tools')?.value as ModelRequestDocument['request']['tools']
    this.toolList = (tools ?? []).map((tool, index) => {
      const key = `tool:${index}`
      const root = `tools[${index}]`
      const names = Object.keys(tool)
      const groups: RequestToolGroup[] = []
      const add = (id: string, label: string, properties: string[], path: string): void => {
        if (properties.length === 0) return
        groups.push({
          key: `${key}:${id}`, label, path, paths: properties.map(name => childPath(root, name)),
          *fields() {
            for (const name of properties) yield* walk((tool as unknown as Record<string, unknown>)[name], childPath(root, name), 'tools')
          },
        })
      }
      add('description', 'Description', names.filter(name => name === 'description'), `${root}.description`)
      add('parameters', 'Parameters schema', names.filter(name => name === 'parameters'), `${root}.parameters`)
      add('other', 'Other attributes', names.filter(name => name !== 'name' && name !== 'description' && name !== 'parameters'), root)
      const path = `${root}.name`
      const nameField = { key: `tools:${path}`, sectionKey: 'tools', path, text: tool.name }
      return { key, name: tool.name, nameField, summary: messageExcerpt(tool.description ?? ''), groups }
    })
    return this.toolList
  }

  toolForField(field: RequestField): { tool: RequestTool; group: RequestToolGroup | undefined } | undefined {
    if (field.sectionKey !== 'tools') return undefined
    const index = /^tools\[(\d+)\]/u.exec(field.path)?.[1]
    const tool = index === undefined ? undefined : this.tools[Number(index)]
    if (tool === undefined) return undefined
    const group = tool.groups.find(candidate => candidate.paths.some(path =>
      field.path === path || field.path.startsWith(`${path}.`) || field.path.startsWith(`${path}[`)))
    return { tool, group }
  }

  /** Reading order follows content blocks, not the order of JSON properties. */
  body(key: string): readonly RequestBodyBlock[] {
    const section = this.byKey.get(key)
    if (section?.kind !== 'message') return []
    return contentBody((section.value as Message).content, `messages[${section.messageIndex}].content`, key)
  }

  /** Details omitted from ordinary reading remain available on demand and in search. */
  *metadata(key: string): Iterable<RequestField> {
    const omitted = new Set(this.body(key).map(block => block.field.path))
    for (const field of this.sectionFields(key)) {
      if (!omitted.has(field.path)) yield field
    }
  }

  *fields(): Iterable<RequestField> {
    for (const section of this.sections) yield* this.sectionFields(section.key)
  }

  *sectionFields(key: string): Iterable<RequestField> {
    const section = this.byKey.get(key)
    if (section === undefined) return
    const path = section.kind === 'config' ? ''
      : section.kind === 'tools' ? 'tools' : `messages[${section.messageIndex}]`
    yield* walk(section.value, path, section.key)
  }
}

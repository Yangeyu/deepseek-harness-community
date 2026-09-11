import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import { describe, expect, it } from 'vitest'
import { RequestDocument } from '../../../src/modules/trajectory/request-document.ts'
import type { ModelRequestDocument } from '../../../src/runtime/execution/projection/model-call.ts'

type Message = ModelRequestDocument['request']['messages'][number]

function message(id: string, text: string, role: Message['role'] = 'user', source: Message['source'] = { kind: 'user' }): Message {
  return { id, role, source, content: [{ type: 'text', text }] } as Message
}

function canonical(messages: readonly Message[], seqs = messages.map((_, index) => index)): ModelRequestDocument {
  return {
    request: { provider: 'deepseek', model: 'chat', messages },
    provenance: messages.map((value, index) => ({
      seq: seqs[index]!, messageId: value.id, source: value.source,
      surfaceOp: 'append', sourceEventSeqs: undefined,
    })),
  }
}

describe('RequestDocument', () => {
  it('keeps every canonical message in order, including later System and non-monotonic event seqs', () => {
    const messages = [
      message('first', 'Input'),
      message('system', 'Later instructions', 'system', { kind: 'plugin', plugin: 'system-prompt' }),
      message('last', 'Reply', 'assistant', { kind: 'model', provider: 'deepseek', model: 'chat' }),
    ]
    const input = canonical(messages, [5, 9, 6])
    const document = new RequestDocument({ ...input, request: { ...input.request, tools: [] } })
    expect(document.sections.map(section => section.kind)).toEqual(['config', 'tools', 'message', 'message', 'message'])
    const sections = document.sections.filter(section => section.kind === 'message')
    expect(sections.map(section => section.eventSeq)).toEqual([5, 9, 6])
    sections.forEach((section, index) => {
      expect(section.messageIndex).toBe(index)
      expect(section.value).toBe(messages[index])
      expect(document.section(section.key)).toBe(section)
    })
    expect(document.section('missing')).toBeUndefined()
    expect(document.latestInputKey).toBe(sections[0]!.key)
  })

  it('identifies context by declared source and form without changing its protocol role', () => {
    const messages = [
      message('human', '<system-reminder>human text</system-reminder>'),
      message('instructions', 'Project rules', 'user', { kind: 'plugin', plugin: 'workspace', form: 'instructions' }),
      message('catalog', 'Available skills', 'user', { kind: 'plugin', plugin: 'skills', form: 'catalog' }),
      message('notice', 'Long detailed report', 'user', { kind: 'plugin', plugin: 'worker', form: 'notice', summary: 'Review finished' }),
      message('memory', '<memory-context>content</memory-context>', 'user', { kind: 'plugin', plugin: 'community-memory' }),
      message('relay', 'A colleague replied', 'user', { kind: 'plugin', plugin: 'agent', form: 'relay' }),
    ]
    const document = new RequestDocument(canonical(messages))
    const sections = document.sections.filter(section => section.kind === 'message')
    expect(sections.map(section => section.label)).toEqual([
      '#1 User input', '#2 Workspace instructions · workspace', '#3 Catalog · skills',
      '#4 Context update · worker', '#5 Context · community-memory', '#6 Agent message · agent',
    ])
    expect(sections[3]!.summary).toBe('Review finished')
    sections.forEach((section, index) => expect(section.value).toBe(messages[index]))
  })

  it('binds duplicate text fields to message identity, source seq and JSON path rather than text', () => {
    const input = canonical([message('one', 'Repeated'), message('two', 'Repeated')], [4, 12])
    const document = new RequestDocument(input)
    const fields = [...document.fields()].filter(field => field.text === 'Repeated')
    expect(fields.map(field => field.path)).toEqual(['messages[0].content[0].text', 'messages[1].content[0].text'])
    expect(new Set(fields.map(field => field.key)).size).toBe(2)
    expect(fields.map(field => field.key)).toEqual(
      [...new RequestDocument(input).fields()].filter(field => field.text === 'Repeated').map(field => field.key),
    )
    const changed = new RequestDocument(canonical([message('one', 'Edited'), message('two', 'Repeated')], [4, 12]))
    expect([...changed.fields()].find(field => field.text === 'Edited')!.key).toBe(fields[0]!.key)
  })

  it('recognizes checkpoint provenance with the public contract, not body labels', () => {
    const source = compactCheckpointSource('compaction-1' as Parameters<typeof compactCheckpointSource>[0])
    const document = new RequestDocument(canonical([
      message('checkpoint', 'Plain summary with no magic tag', 'user', source),
      message('fake', '<compaction_checkpoint>Compaction checkpoint</compaction_checkpoint>'),
    ]))
    const sections = document.sections.filter(section => section.kind === 'message')
    expect(sections.map(section => section.category)).toEqual(['checkpoint', 'message'])
    expect(sections[0]!.label).toContain('Compaction checkpoint')
    expect(document.latestInputKey).toBe(sections[1]!.key)
  })

  it('uses formal tool-call IDs for tool names and preserves the canonical result role', () => {
    const call = {
      ...message('call', '', 'assistant', { kind: 'model', provider: 'deepseek', model: 'chat' }),
      content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{ "path": "src/a.ts" }' }],
    } as Message
    const result = {
      ...message('result', '', 'user', { kind: 'tool', callId: 'call-1' } as Message['source']),
      content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'file contents' }] }],
    } as Message
    const unknown = message('unknown', 'read: not evidence', 'user', { kind: 'tool', callId: 'absent' } as Message['source'])
    const document = new RequestDocument(canonical([call, result, unknown]))
    const sections = document.sections.filter(section => section.kind === 'message')
    expect(sections.map(section => section.label)).toEqual(['#1 Assistant response', '#2 Tool result: read', '#3 Tool result'])
    expect(document.latestInputKey).toBe(sections[2]!.key)
    expect([...document.fields()].find(field => field.path === 'messages[0].content[0].arguments')!.text)
      .toBe('{ "path": "src/a.ts" }')
  })

  it('visits folded messages, config, schemas and all metadata with real JSON paths', () => {
    const input = canonical([{
      ...message('identity', 'Hidden body'),
      source: { kind: 'plugin', plugin: 'producer', form: 'notice', summary: 'Source metadata' },
      content: [
        { type: 'text', text: 'Hidden body' },
        { type: 'image', attachment: { attachmentId: 'sha256:metadata', mediaType: 'image/png', bytes: 42, width: 1, height: 1 } },
      ],
    } as Message])
    const request = {
      ...input.request, temperature: 0.25, enabled: false, nullable: null, empty: {},
      tools: [{ name: 'read', description: 'Schema text', parameters: {
        type: 'object', properties: { 'path.with.dots': { type: 'string', description: 'Find this schema' } }, required: [],
      } }],
    }
    const document = new RequestDocument({ ...input, request })
    const fields = [...document.fields()]
    const values = Object.fromEntries(fields.map(field => [field.path, field.text]))
    expect(values).toMatchObject({
      provider: 'deepseek', temperature: '0.25', enabled: 'false', nullable: 'null', empty: '{}',
      'tools[0].parameters.required': '[]',
      'tools[0].parameters.properties["path.with.dots"].description': 'Find this schema',
      'messages[0].id': 'identity',
      'messages[0].source.summary': 'Source metadata',
      'messages[0].content[0].text': 'Hidden body',
      'messages[0].content[1].attachment.attachmentId': 'sha256:metadata',
      'messages[0].content[1].attachment.bytes': '42',
    })
  })

  it('groups tool definitions without losing canonical fields or their search locations', () => {
    const input = canonical([])
    const tools = [
      { name: 'bash', description: 'Execute commands\nFull details', parameters: { type: 'object', properties: { 'work.dir': { type: 'string' } } }, strict: false },
      { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
    ]
    const document = new RequestDocument({ ...input, request: { ...input.request, tools } })
    expect(document.tools.map(tool => [tool.key, tool.name, tool.summary])).toEqual([
      ['tool:0', 'bash', 'Execute commands…'], ['tool:1', 'read', 'Read a file'],
    ])
    expect(document.tools[0]!.groups.map(group => group.label)).toEqual(['Description', 'Parameters schema', 'Other attributes'])
    const projected = document.tools.flatMap(tool => [tool.nameField, ...tool.groups.flatMap(group => [...group.fields()])])
    const originals = [...document.sectionFields('tools')]
    expect(projected).toHaveLength(originals.length)
    expect(projected).toEqual(expect.arrayContaining(originals))
    const schema = originals.find(field => field.path === 'tools[0].parameters.properties["work.dir"].type')!
    expect(document.toolForField(schema)).toEqual({ tool: document.tools[0], group: document.tools[0]!.groups[1] })
    expect(document.toolForField(document.tools[1]!.nameField)).toEqual({ tool: document.tools[1], group: undefined })
    expect(document.section('tools')!.value).toBe(tools)
  })

  it('does not read later scalar fields until the iterator reaches them, even within one object', () => {
    const reads: string[] = []
    const input = canonical([message('lazy', 'Body')])
    const request = { ...input.request }
    // Explicit descriptors preserve property order through the test transpiler.
    Object.defineProperties(request, {
      first: { enumerable: true, get() { reads.push('first'); return 'First' } },
      nested: { enumerable: true, value: {
        get before() { reads.push('before'); return 'Before' },
        get after() { reads.push('after'); return 'After' },
      } },
    })
    const document = new RequestDocument({ ...input, request })
    const iterator = document.sectionFields('config')[Symbol.iterator]()
    expect(reads).toEqual([])
    expect(iterator.next().value).toMatchObject({ path: 'provider' })
    expect(iterator.next().value).toMatchObject({ path: 'model' })
    expect(reads).toEqual([])
    expect(iterator.next().value).toMatchObject({ path: 'first', text: 'First' })
    expect(reads).toEqual(['first'])
    expect(iterator.next().value).toMatchObject({ path: 'nested.before', text: 'Before' })
    expect(reads).toEqual(['first', 'before'])
    expect(iterator.next().value).toMatchObject({ path: 'nested.after', text: 'After' })
    expect(reads).toEqual(['first', 'before', 'after'])
  })

  it('keeps message identity separate from its complete original body', () => {
    const text = '\u001b[31mOriginal\n' + 'x'.repeat(10 * 1024 * 1024)
    const document = new RequestDocument(canonical([message('large', text)]))
    const section = document.sections[1]!
    expect(section.label).toBe('#1 User input')
    expect(section.summary).toContain('Original')
    expect(section.summary!.length).toBeLessThan(100)
    expect(document.body(section.key).map(block => block.field.text)).toEqual([text])
  })

  it('reads mixed content in order while keeping technical metadata available separately', () => {
    const input = canonical([{
      ...message('mixed', '', 'assistant', { kind: 'model', provider: 'deepseek', model: 'chat' }),
      content: [
        { type: 'reasoning', text: 'Think first' },
        { type: 'text', text: 'Read the file' },
        { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a.ts"}' },
        { type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'File contents' }] },
      ],
    } as Message])
    const document = new RequestDocument(input)
    const key = document.sections[1]!.key
    expect(document.body(key).map(block => [block.label, block.field.text])).toEqual([
      ['Thinking', 'Think first'], [undefined, 'Read the file'],
      ['Tool call · read', '{"path":"a.ts"}'], [undefined, 'File contents'],
    ])
    const readable = [...document.body(key).map(block => block.field), ...document.metadata(key)]
    const originals = [...document.sectionFields(key)]
    expect(readable).toHaveLength(originals.length)
    expect(readable).toEqual(expect.arrayContaining(originals))
    const searchable = [...document.fields()]
    for (const { field } of document.body(key)) expect(searchable).toContainEqual(field)
    expect(searchable).toContainEqual(expect.objectContaining({ path: 'messages[0].role', text: 'assistant' }))
  })

  it('keeps empty containers inspectable and has no latest input for an empty request', () => {
    const input = canonical([])
    const document = new RequestDocument({ ...input, request: { ...input.request, tools: [] } })
    expect(document.latestInputKey).toBeUndefined()
    expect([...document.sectionFields('tools')].map(field => [field.path, field.text])).toEqual([['tools', '[]']])
  })
})

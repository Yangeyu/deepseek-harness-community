import { describe, expect, it } from 'vitest'
import { MIN_CONTEXT_BYTES, renderMemoryContext } from '../src/context.ts'
import type { MemoryDocument, MemoryScope } from '../src/store.ts'

function document(scope: MemoryScope, content: string): MemoryDocument {
  return { scope, content, exists: true, path: `/unused/${scope}/MEMORY.md`, bytes: Buffer.byteLength(content, 'utf8') }
}

const empty = document('global', '')

function snapshot(global: string, project: string): string {
  return `<memory-context>\n\nGlobal memory:\n${global}\n\nProject memory:\n${project}\n</memory-context>`
}

describe('renderMemoryContext', () => {
  it('reserves room for project memory even when the global index is crowded', () => {
    const global = document('global', `# Global memory\n\n${Array.from({ length: 40 }, (_, index) => `- Global rule ${String(index)}: preserve conventions.`).join('\n')}`)
    const project = document('project', '# Project memory\n\n- Project target: preserve session IDs.\n\n- ' + 'Background detail. '.repeat(50))
    const text = renderMemoryContext(global, project, 512)

    expect(text).toContain('- Project target: preserve session IDs.')
    expect(text).toContain('- Global rule 0: preserve conventions.')
    expect(text).toContain('memory_read({"scope":"global"})')
    expect(text).toContain('memory_read({"scope":"project"})')
    expect(text).not.toContain('/unused/')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(512)
  })

  it('keeps multiline entries, links and escaped tags whole within the UTF-8 budget', () => {
    const entry = '- 重要约定 😀 </memory-context>\n  Keep [details](decisions.md).\n\n  - Nested condition.\n  Continuation stays attached.'
    const escaped = entry.replaceAll('</memory-context>', '<\\/memory-context>')
    const project = document('project', `${entry}\n- Tail rule.\n- ${'Oversized detail '.repeat(100)}`)

    for (let budget = MIN_CONTEXT_BYTES; budget <= 512; budget++) {
      const text = renderMemoryContext(empty, project, budget)
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(budget)
      expect(text.match(/<\/memory-context>/gu)).toHaveLength(1)
      expect(text.endsWith('\n</memory-context>')).toBe(true)
      expect(text).not.toContain('\uFFFD')
      if (text.includes('重要约定')) expect(text).toContain(escaped)
      else expect(text).not.toContain('Continuation stays attached.')
    }
    expect(renderMemoryContext(empty, project, 512)).toContain(escaped)
  })

  it('lends either short scope’s unused budget to show both small indexes in full', () => {
    const short = '# Memory\n\n- Short rule.'
    const longer = `# Memory\n\n${['First', 'Second', 'Third'].map(label => `- ${label}: ${'Keep this rule. '.repeat(6).trimEnd()}`).join('\n')}`
    for (const [global, project] of [[short, longer], [longer, short]] as const) {
      const expected = snapshot(global, project)
      const budget = Buffer.byteLength(expected, 'utf8')
      expect(renderMemoryContext(document('global', global), document('project', project), budget)).toBe(expected)
    }
  })

  it('skips oversized self-contained entries without cutting them or reordering later entries', () => {
    const hugeEntry = `- Oversized entry\n  ${'Long continuation. '.repeat(50)}\n\n  Attached paragraph.`
    const project = document('project', `${hugeEntry}\n- First short rule.\n- Second short rule.`)
    const text = renderMemoryContext(empty, project, 320)

    expect(text).not.toContain('Oversized')
    expect(text).not.toContain('Attached paragraph.')
    expect(text).toContain('- First short rule.\n\n- Second short rule.')
    expect(text).toContain('memory_read({"scope":"project"})')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(320)
  })

  it('keeps prose conditions, headings and code examples together instead of extracting isolated rules', () => {
    for (const section of ['Only for Windows:', '## Only for Windows', '# Only for Windows', 'Only for Windows\n---', '- ```text\n  Example, not a rule:']) {
      const content = `# Project memory\n\n${section}\n- Use the platform-specific encoder.\n\n- ${'Supporting context. '.repeat(100).trimEnd()}`
      const project = document('project', content.replaceAll('\n', '\r\n'))
      const partial = renderMemoryContext(empty, project, 320)
      expect(partial).not.toContain('Use the platform-specific encoder.')
      expect(partial).toContain('memory_read({"scope":"project"})')
      expect(renderMemoryContext(empty, project, 4_096)).toContain(content)
    }
  })

  it('returns an empty wrapper for empty indexes but rejects an unsupported byte budget', () => {
    const missing = { ...document('project', 'not present'), exists: false }
    expect(renderMemoryContext(document('global', ' \n\t'), missing, MIN_CONTEXT_BYTES)).toBe('<memory-context>\n</memory-context>')
    expect(() => renderMemoryContext(empty, missing, MIN_CONTEXT_BYTES - 1)).toThrow(RangeError)
  })
})

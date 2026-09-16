import { describe, expect, it, vi } from 'vitest'
import type { MemoryDocument, MemoryOverview } from '@vascent/deepseek-harness-memory'
import { MemoryDialog } from '../../../src/modules/memory/view.ts'
import { createTheme } from '../../../src/presentation/primitives/theme.ts'

function document(
  scope: MemoryDocument['scope'],
  path: string,
  content: string,
  topic?: MemoryDocument['topic'],
): MemoryDocument {
  return {
    scope,
    ...topic === undefined ? {} : { topic },
    path,
    exists: true,
    content,
    bytes: Buffer.byteLength(content),
  }
}

const globalMemory = document('global', '/memories/global/MEMORY.md', '# Global memory\n\n- Prefer Chinese.\n')
const projectMemory = document('project', '/memories/projects/demo/MEMORY.md', '# Project memory\n\n- Use pnpm.\n')
const overview: MemoryOverview = {
  project: { id: 'demo-123', root: '/workspace', directory: '/memories/projects/demo' },
  policy: { useMemories: true, generateMemories: true },
  learning: { route: { provider: 'test', model: 'memory-model' }, idleDelayMs: 300000, maxRequests: 3 },
  global: globalMemory,
  projectMemory,
  documents: [
    projectMemory,
    document('project', '/memories/projects/demo/conventions.md', '# Conventions\n\n- Run focused checks.\n', 'conventions'),
    globalMemory,
  ],
}

describe('MemoryDialog', () => {
  it.each([
    { name: 'foreground', route: undefined, label: 'follows the foreground model' },
    { name: 'dedicated', route: overview.learning.route, label: 'test / memory-model' },
  ])('shows the $name route, enables learning and opens Markdown files', ({ route, label }) => {
    const policy = vi.fn()
    const cancel = vi.fn()
    const dialog = new MemoryDialog({
      ...overview,
      policy: { useMemories: true, generateMemories: false },
      learning: { ...overview.learning, route },
    }, () => 24, createTheme(false), policy, cancel)

    expect(dialog.render(120).join('\n')).toContain(label)

    expect(dialog.render(100).join('\n')).toContain('Use memories in this session  on')
    dialog.handleAction('surface.confirm')
    expect(policy).toHaveBeenLastCalledWith({ useMemories: false })
    dialog.handleAction('surface.next')
    dialog.handleAction('surface.confirm')
    expect(policy).toHaveBeenLastCalledWith({ generateMemories: true })

    dialog.handleAction('surface.next')
    dialog.handleAction('surface.confirm')
    const documentView = dialog.render(100).join('\n')
    expect(documentView).toContain('/memories/projects/demo/MEMORY.md')
    expect(documentView).toContain('- Use pnpm.')

    dialog.handleAction('surface.back')
    expect(dialog.render(100).join('\n')).toContain('Project · conventions')
    dialog.handleAction('surface.back')
    expect(cancel).toHaveBeenCalledOnce()
  })
})

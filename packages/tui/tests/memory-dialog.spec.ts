import { describe, expect, it, vi } from 'vitest'
import type { MemoryDocument, MemoryOverview } from '@vascent/deepseek-harness-memory'
import { MemoryDialog } from '../src/dialogs.ts'
import { createTheme } from '../src/theme.ts'

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
  global: globalMemory,
  projectMemory,
  documents: [
    projectMemory,
    document('project', '/memories/projects/demo/conventions.md', '# Conventions\n\n- Run focused checks.\n', 'conventions'),
    globalMemory,
  ],
}

describe('MemoryDialog', () => {
  it('toggles session policy and opens Markdown files without editing them', () => {
    const policy = vi.fn()
    const cancel = vi.fn()
    const dialog = new MemoryDialog(overview, () => 24, createTheme(false), policy, cancel)

    expect(dialog.render(100).join('\n')).toContain('Use memories in this session  on')
    dialog.handleInput('\r')
    expect(policy).toHaveBeenLastCalledWith({ useMemories: false, generateMemories: true })
    dialog.handleInput('\u001b[B')
    dialog.handleInput('\r')
    expect(policy).toHaveBeenLastCalledWith({ useMemories: false, generateMemories: false })

    dialog.handleInput('\u001b[B')
    dialog.handleInput('\r')
    const documentView = dialog.render(100).join('\n')
    expect(documentView).toContain('/memories/projects/demo/MEMORY.md')
    expect(documentView).toContain('- Use pnpm.')

    dialog.handleInput('\u001b')
    expect(dialog.render(100).join('\n')).toContain('Project · conventions')
    dialog.handleInput('\u001b')
    expect(cancel).toHaveBeenCalledOnce()
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ProjectMemoryService, type MemoryOverview, type MemorySessionPolicy } from '@vascent/deepseek-harness-memory'
import { MemoryProcess } from '../../../src/modules/memory/process.ts'
import type { MemoryPort } from '../../../src/modules/memory/contracts.ts'
import type { MemoryDialog } from '../../../src/modules/memory/view.ts'
import { createTheme } from '../../../src/presentation/primitives/theme.ts'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'
import type { RuntimeSessionSnapshot } from '../../../src/runtime/session/snapshot.ts'

const scopes: LifecycleScope[] = []
const contexts: Context[] = []
const directories: string[] = []
const overview: MemoryOverview = {
  project: { id: 'project', root: '/workspace', directory: '/memory/projects/project' },
  policy: { useMemories: true, generateMemories: true },
  global: { scope: 'global', path: '/memory/global/MEMORY.md', content: '', bytes: 0, exists: false },
  projectMemory: { scope: 'project', path: '/memory/projects/project/MEMORY.md', content: '', bytes: 0, exists: false },
  documents: [],
}

async function fixture(memory: MemoryPort, cwd = '/workspace') {
  const scope = new LifecycleScope('memory')
  scopes.push(scope)
  let dialog!: MemoryDialog
  const invalidate = vi.fn()
  const process = new MemoryProcess({
    memory,
    session: { current: { cwd, sessionId: SessionId('session') } as RuntimeSessionSnapshot },
    surfaces: {
      active: false,
      open: ({ component }) => { dialog = component as MemoryDialog; return { close: () => true } },
    },
    visibleRows: () => 24,
    theme: createTheme(false),
    onActivity: () => {},
    invalidate,
    scope,
  })
  await process.open()
  return { dialog, invalidate, scope }
}

function memoryPort(setPolicy: MemoryPort['setPolicy']): MemoryPort {
  return { onActivity: () => () => {}, overview: async () => overview, policy: async () => overview.policy, setPolicy }
}

afterEach(async () => {
  await Promise.all(scopes.splice(0).map(scope => scope.dispose()))
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('MemoryProcess policy updates', () => {
  it('shows the saved policy only after persistence completes and holds further toggles while saving', async () => {
    const saved = Promise.withResolvers<MemorySessionPolicy>()
    const setPolicy = vi.fn(() => saved.promise)
    const { dialog } = await fixture(memoryPort(setPolicy))
    dialog.handleAction('surface.confirm')
    dialog.handleAction('surface.confirm')

    expect(setPolicy).toHaveBeenCalledExactlyOnceWith('session', { useMemories: false })
    expect(dialog.render(100).join('\n')).toContain('Use memories in this session  on')
    expect(dialog.render(100).join('\n')).toContain('Saving memory policy')
    saved.resolve({ useMemories: false, generateMemories: true })
    await vi.waitFor(() => {
      expect(dialog.render(100).join('\n')).toContain('Use memories in this session  off')
    })
  })

  it('preserves the last saved policy and displays a failed save', async () => {
    const { dialog } = await fixture(memoryPort(async () => { throw new Error('Memory directory is read-only') }))
    dialog.handleAction('surface.confirm')

    await vi.waitFor(() => {
      expect(dialog.render(100).join('\n')).toContain('Memory directory is read-only')
    })
    expect(dialog.render(100).join('\n')).toContain('Use memories in this session  on')
    expect(dialog.render(100).join('\n')).not.toContain('Saving memory policy')
  })

  it('shows the persisted disabled policy and the cleanup failure together', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-memory-policy-ui-'))
    directories.push(cwd)
    const ctx = new Context()
    contexts.push(ctx)
    new SessionStore(ctx)
    new SystemPrompt(ctx, {})
    ctx.provide('tools', { register: () => () => {} } as unknown as Context['tools'])
    const session = ctx.sessions.create(SessionId('session'), { meta: { cwd } })
    const parent = {
      id: session.id, session, options: {}, status: 'idle',
      whenIdle: async () => {},
      runMaintenance: (run: (signal: AbortSignal) => Promise<void>) => run(new AbortController().signal),
    } as unknown as Agent
    const started = Promise.withResolvers<void>()
    ctx.provide('agents', {
      get: () => parent,
      withInitiator: (_agent: unknown, run: () => unknown) => run(),
      create: async () => ({
        agent: { followup: () => { started.resolve() }, whenIdle: () => new Promise(() => {}) },
        dispose: async () => { throw new Error('Learning child cleanup failed') },
      }),
    } as unknown as Context['agents'])
    const memory = new ProjectMemoryService(ctx, { root: join(cwd, 'memories'), idleDelayMs: 0 })
    const { dialog } = await fixture(memory, cwd)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: '记住：以后这个项目统一使用 pnpm。' }],
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await started.promise
    dialog.handleAction('surface.next')
    dialog.handleAction('surface.confirm')

    await vi.waitFor(() => {
      const output = dialog.render(100).join('\n')
      expect(output).toContain('Learning child cleanup failed')
      expect(output).toContain('Learn from this session  off')
    })
    expect(await memory.policy('session')).toEqual({ useMemories: true, generateMemories: false })
  })

  it('shows unknown policy and prevents toggles when the failed operation cannot be refreshed', async () => {
    const setPolicy = vi.fn(async () => { throw new Error('Learning child cleanup failed') })
    const { dialog } = await fixture({
      ...memoryPort(setPolicy),
      policy: async () => { throw new Error('Memory directory is unavailable') },
    })
    dialog.handleAction('surface.confirm')

    await vi.waitFor(() => {
      const output = dialog.render(100).join('\n')
      expect(output).toContain('Use memories in this session  unknown')
      expect(output).toContain('Learning child cleanup failed')
      expect(output).toContain('Memory directory is unavailable')
    })
    dialog.handleAction('surface.confirm')
    expect(setPolicy).toHaveBeenCalledOnce()
  })
})

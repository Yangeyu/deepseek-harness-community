import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectMemoryService, type Config } from '../src/index.ts'

const temporaryDirectories: string[] = []
const contexts: Context[] = []

async function memoryService(overrides: {
  config?: Partial<Config>
  agents?: unknown
} = {}): Promise<{ ctx: Context; cwd: string; service: ProjectMemoryService }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-service-test-'))
  temporaryDirectories.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('tools', { register: () => () => {} } as unknown as Context['tools'])
  ctx.provide('agents', overrides.agents ?? { get: () => undefined } as unknown as Context['agents'])
  ctx.provide('systemPrompt', {} as Context['systemPrompt'])
  return {
    ctx,
    cwd: root,
    service: new ProjectMemoryService(ctx, {
      root: join(root, 'memories'),
      useMemories: true,
      generateMemories: false,
      ...overrides.config,
    }),
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('ProjectMemoryService context projection', () => {
  it('publishes changed snapshots once and clears them when session use is disabled', async () => {
    const { ctx, cwd, service } = await memoryService()
    await service.write({ cwd, scope: 'project', summary: 'Use focused checks.' })
    const session = {
      id: SessionId('memory-session'),
      header: { cwd },
      events: [] as Array<Record<string, unknown>>,
      surface: { nodes: [] as number[] },
    }
    const agent = { id: session.id, session } as unknown as Agent
    const preStep = (): Promise<PreStepDecision> => ctx.waterfall('agent/pre-step', {
      agent,
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter', messages: [] }))
    const append = (decision: PreStepDecision): void => {
      if (decision.kind === 'reject') throw new Error('fixture unexpectedly rejected the step')
      const message = decision.messages.at(-1)
      if (message === undefined) throw new Error('fixture did not receive a memory message')
      const seq = session.events.length
      session.events.push({ type: 'user/message', seq, time: seq, data: message })
      session.surface.nodes.push(seq)
    }

    const initial = await preStep()
    if (initial.kind === 'reject') throw new Error('fixture unexpectedly rejected the step')
    expect(initial.messages).toHaveLength(1)
    expect(initial.messages[0]?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Use focused checks.') })
    append(initial)
    const unchanged = await preStep()
    if (unchanged.kind === 'reject') throw new Error('fixture unexpectedly rejected the step')
    expect(unchanged.messages).toHaveLength(0)

    service.setPolicy(String(session.id), { useMemories: false })
    const cleared = await preStep()
    if (cleared.kind === 'reject') throw new Error('fixture unexpectedly rejected the step')
    expect(cleared.messages[0]?.content[0]).toMatchObject({
      type: 'text',
      text: 'Project memory is disabled for this session. Earlier memory snapshots no longer apply.',
    })
    append(cleared)
    const stillCleared = await preStep()
    if (stillCleared.kind === 'reject') throw new Error('fixture unexpectedly rejected the step')
    expect(stillCleared.messages).toHaveLength(0)

    service.setPolicy(String(session.id), { useMemories: true })
    const restored = await preStep()
    if (restored.kind === 'reject') throw new Error('fixture unexpectedly rejected the step')
    expect(restored.messages[0]?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Use focused checks.') })
  })
})

describe('ProjectMemoryService quiet learning', () => {
  it('instructs the maintenance agent to reconcile with existing memory before recording', async () => {
    const followup = vi.fn()
    const handle = {
      agent: { followup, whenIdle: vi.fn(async () => {}) },
      dispose: vi.fn(async () => {}),
    }
    const { ctx, cwd, service } = await memoryService({
      config: { generateMemories: true, idleDelayMs: 0 },
      agents: {
        get: vi.fn(() => agent),
        withInitiator: vi.fn((_initiator: unknown, run: () => unknown) => run()),
        create: vi.fn(async () => handle),
      } as unknown,
    })
    const turnEnd = {
      type: 'turn/end',
      seq: 2,
      time: 3,
      data: { turn: 1, reason: { kind: 'completed' } },
    }
    const session = {
      id: SessionId('memory-quiet-learning'),
      header: { cwd },
      events: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: 2, data: {
          id: 'message-user-learning',
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: '记住：以后提交前必须先跑 lint。' }],
        } },
        turnEnd,
      ],
    } as unknown as Session
    const agent = {
      id: session.id,
      session,
      status: 'idle',
      options: {},
      whenIdle: vi.fn(async () => {}),
      runMaintenance: vi.fn(async (run: (signal: AbortSignal) => Promise<void>) => {
        await run(new AbortController().signal)
      }),
    } as unknown as Agent

    await ctx.parallel('session/event', session, turnEnd as Session['events'][number])
    await service.settle(String(session.id))

    expect(followup).toHaveBeenCalledTimes(1)
    const message = followup.mock.calls[0]?.[0] as { content: Array<{ type: string; text: string }> } | undefined
    const text = message?.content.find(block => block.type === 'text')?.text ?? ''
    expect(text).toContain('memory_read')
    expect(text).toContain('memory_forget')
    expect(text).toContain('exactly one current wording')
    expect(text).toContain('记住：以后提交前必须先跑 lint。')
    expect(text).toContain('Do not reply to the original user')
  })
})

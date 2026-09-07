import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, CreateAgentOptions, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore, type Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectMemoryService, type Config, type MemoryActivity } from '../src/index.ts'

const temporaryDirectories: string[] = []
const contexts: Context[] = []

function sessionFixture(ctx: Context, id: string, cwd: string): Session {
  return ctx.sessions.create(SessionId(id), { meta: { cwd } })
}

async function memoryService(overrides: {
  config?: Partial<Config>
  agents?: unknown
} = {}): Promise<{ ctx: Context; cwd: string; service: ProjectMemoryService }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-service-test-'))
  temporaryDirectories.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  new SessionStore(ctx)
  ctx.provide('tools', { register: () => () => {} } as unknown as Context['tools'])
  ctx.provide('agents', overrides.agents ?? { get: () => undefined } as unknown as Context['agents'])
  new SystemPrompt(ctx, {})
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

async function learningFixture(options: {
  parentIdle?: () => Promise<void>
  childIdle?: () => Promise<void>
  disposeChild?: () => Promise<void>
  maintenanceSignal?: AbortSignal
  config?: Partial<Config>
} = {}) {
  const started = Promise.withResolvers<void>()
  const followup = vi.fn((_message: UserMessage) => { started.resolve() })
  const dispose = vi.fn(options.disposeChild ?? (async () => {}))
  const create = vi.fn(async ({ sessionId }: CreateAgentOptions) => ({
    agent: {
      id: sessionId,
      followup,
      whenIdle: options.childIdle ?? (async () => {}),
    } as unknown as Agent,
    dispose,
  }))
  const fixture = await memoryService({
    config: { generateMemories: true, idleDelayMs: 0, ...options.config },
    agents: {
      get: () => agent,
      withInitiator: (_initiator: unknown, run: () => unknown) => run(),
      create,
    },
  })
  const session = sessionFixture(fixture.ctx, 'memory-learning', fixture.cwd)
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    options: {},
    whenIdle: options.parentIdle ?? (async () => {}),
    runMaintenance: async (run: (signal: AbortSignal) => Promise<void>) => run(options.maintenanceSignal ?? new AbortController().signal),
  } as unknown as Agent
  const turn = (number: number): void => {
    session.append('turn/start', { turn: number })
    session.append('user/message', createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: `记住：以后提交前必须先跑 lint。Turn ${number}.` }],
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: number, reason: { kind: 'completed' } })
  }
  return { ...fixture, session, agent, create, followup, dispose, started: started.promise, turn }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('ProjectMemoryService context projection', () => {
  it('publishes changed snapshots once and clears them when session use is disabled', async () => {
    const { ctx, cwd, service } = await memoryService()
    await service.write({ cwd, scope: 'project', summary: 'Use focused checks.' })
    const session = sessionFixture(ctx, 'memory-session', cwd)
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
      session.append('user/message', message, { surfaceOp: 'append' })
    }

    const initial = await preStep()
    if (initial.kind === 'reject') throw new Error('fixture unexpectedly rejected the step')
    expect(initial.messages).toHaveLength(1)
    expect(initial.messages[0]?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Use focused checks.') })
    append(initial)
    const unchanged = await preStep()
    if (unchanged.kind === 'reject') throw new Error('fixture unexpectedly rejected the step')
    expect(unchanged.messages).toHaveLength(0)

    await service.setPolicy(String(session.id), { useMemories: false })
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

    await service.setPolicy(String(session.id), { useMemories: true })
    const restored = await preStep()
    if (restored.kind === 'reject') throw new Error('fixture unexpectedly rejected the step')
    expect(restored.messages[0]?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Use focused checks.') })
  })
})

describe('ProjectMemoryService session policy', () => {
  it('persists concurrent partial updates across service recreation without changing new-session defaults', async () => {
    const first = await memoryService({ config: { generateMemories: true } })
    await Promise.all([
      first.service.setPolicy('session-one', { useMemories: false }),
      first.service.setPolicy('session-one', { generateMemories: false }),
    ])
    await first.ctx.fiber.dispose()
    const second = await memoryService({ config: { root: first.service.store.root, generateMemories: true } })

    expect(await second.service.policy('session-one')).toEqual({ useMemories: false, generateMemories: false })
    expect(await second.service.policy('session-two')).toEqual({ useMemories: true, generateMemories: true })
  })

  it('reports unreadable policy instead of silently enabling the deployment defaults', async () => {
    const { service } = await memoryService({ config: { generateMemories: true } })
    await service.setPolicy('session-one', { generateMemories: false })
    const directory = join(service.store.root, 'sessions')
    const [filename] = await readdir(directory)
    if (filename === undefined) throw new Error('fixture did not persist its policy')
    await writeFile(join(directory, filename), '{"generateMemories":"off"}')

    await expect(service.policy('session-one')).rejects.toThrow('invalid memory session policy')
  })
})

describe('ProjectMemoryService quiet learning', () => {
  it('instructs the maintenance agent to reconcile with existing memory before recording', async () => {
    const { service, session, followup, turn } = await learningFixture()
    turn(1)
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

  it('cancels waiting candidates without reviving them when learning is re-enabled', async () => {
    const idle = Promise.withResolvers<void>()
    const waiting = Promise.withResolvers<void>()
    const { service, session, create, turn } = await learningFixture({
      parentIdle: () => { waiting.resolve(); return idle.promise },
    })
    turn(1)
    turn(2)
    await waiting.promise
    await service.setPolicy(String(session.id), { generateMemories: false })
    await service.setPolicy(String(session.id), { generateMemories: true })
    idle.resolve()
    await service.settle(String(session.id))
    expect(create).not.toHaveBeenCalled()

    turn(3)
    await service.settle(String(session.id))
    expect(create).toHaveBeenCalledOnce()
  })

  it('stops and drains an active child before acknowledging disabled learning', async () => {
    const disposing = Promise.withResolvers<void>()
    const drained = Promise.withResolvers<void>()
    const { service, session, turn, started, dispose } = await learningFixture({
      childIdle: () => new Promise(() => {}),
      disposeChild: () => { disposing.resolve(); return drained.promise },
    })
    const activities: MemoryActivity[] = []
    service.onActivity(activity => { activities.push(activity) })
    turn(1)
    await started
    let acknowledged = false
    const disabled = service.setPolicy(String(session.id), { generateMemories: false }).then(() => { acknowledged = true })
    try {
      await disposing.promise
      expect(acknowledged).toBe(false)
    } finally {
      drained.resolve()
    }
    await disabled
    expect(dispose).toHaveBeenCalledOnce()
    expect(activities.at(-1)).toEqual({ state: 'idle' })
  })

  it('allows a session to enable learning when the deployment default is disabled', async () => {
    const { service, session, turn, create } = await learningFixture({ config: { generateMemories: false } })
    turn(1)
    await service.settle(String(session.id))
    expect(create).not.toHaveBeenCalled()

    await service.setPolicy(String(session.id), { generateMemories: true })
    turn(2)
    await service.settle(String(session.id))
    expect(create).toHaveBeenCalledOnce()
  })

  it('reports failed child disposal when disabling a queue with more waiting candidates', async () => {
    const failure = new Error('child disposal failed')
    const { service, session, turn, started } = await learningFixture({
      childIdle: () => new Promise(() => {}),
      disposeChild: async () => { throw failure },
    })
    const activities: MemoryActivity[] = []
    service.onActivity(activity => { activities.push(activity) })
    turn(1)
    turn(2)
    await started

    await expect(service.setPolicy(String(session.id), { generateMemories: false })).rejects.toBe(failure)
    expect(activities.at(-1)).toMatchObject({ state: 'error', message: 'child disposal failed' })
    expect((await service.policy(String(session.id))).generateMemories).toBe(false)
  })

  it('finishes quietly when the Host cancels active maintenance', async () => {
    const controller = new AbortController()
    const { service, session, turn, started, dispose } = await learningFixture({
      maintenanceSignal: controller.signal,
      childIdle: () => new Promise(() => {}),
    })
    const activities: MemoryActivity[] = []
    service.onActivity(activity => { activities.push(activity) })
    turn(1)
    await started
    controller.abort(new Error('parent canceled'))
    await service.settle(String(session.id))

    expect(dispose).toHaveBeenCalledOnce()
    expect(activities.at(-1)).toEqual({ state: 'idle' })
  })

  it.each(['waiting', 'running'] as const)('disposes the service while learning is %s without waiting for natural agent completion', async (phase) => {
    const waiting = Promise.withResolvers<void>()
    const fixture = await learningFixture(phase === 'waiting'
      ? { parentIdle: () => { waiting.resolve(); return new Promise(() => {}) } }
      : { childIdle: () => new Promise(() => {}) })
    fixture.turn(1)
    await (phase === 'waiting' ? waiting.promise : fixture.started)

    await fixture.ctx.fiber.dispose()
    await fixture.service.settle(String(fixture.session.id))
    expect(fixture.create).toHaveBeenCalledTimes(phase === 'running' ? 1 : 0)
    expect(fixture.dispose).toHaveBeenCalledTimes(phase === 'running' ? 1 : 0)
  })
})

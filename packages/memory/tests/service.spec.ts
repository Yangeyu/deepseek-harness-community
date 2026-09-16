import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, CreateAgentOptions, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore, type Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectMemoryService, type Config, type MemoryActivity } from '../src/index.ts'

const temporaryDirectories: string[] = []
const contexts: Context[] = []
const learningRoute = { extractionProvider: 'background', extractionModel: 'small-model' }

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
  ctx.provide('tools', { register: () => () => {}, presentAs: () => {}, restrict: () => {} } as unknown as Context['tools'])
  ctx.provide('agents', overrides.agents ?? { get: () => undefined } as unknown as Context['agents'])
  new SystemPrompt(ctx, {})
  return {
    ctx,
    cwd: root,
    service: new ProjectMemoryService(ctx, { root: join(root, 'memories'), ...overrides.config }),
  }
}

function nextMemoryStep(ctx: Context, agent: Agent, decision: PreStepDecision = { kind: 'enter', messages: [], startsRequestSeries: true }): Promise<PreStepDecision> {
  return ctx.waterfall('agent/pre-step', {
    agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal,
  }, () => Promise.resolve(decision))
}

async function learningFixture(options: {
  parentIdle?: () => Promise<void>
  childIdle?: () => Promise<void>
  disposeChild?: () => Promise<void>
  config?: Partial<Config>
} = {}) {
  const started = Promise.withResolvers<void>()
  const followup = vi.fn((_message: UserMessage) => { started.resolve() })
  const dispose = vi.fn(options.disposeChild ?? (async () => {}))
  const create = vi.fn(async ({ sessionId, setup }: CreateAgentOptions) => {
    const child = { id: sessionId, followup, whenIdle: options.childIdle ?? (async () => {}) } as unknown as Agent
    // The fake factory has no agent-scoped prompt registry; exercise the shared LLM hooks.
    await setup?.({
      on: fixture.ctx.on.bind(fixture.ctx),
      tools: fixture.ctx.tools,
      systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
    } as unknown as Context, child)
    return { agent: child, dispose }
  })
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
    id: session.id, session, status: 'idle', options: { provider: 'foreground', model: 'large-model' },
    whenIdle: options.parentIdle ?? (async () => {}),
  } as unknown as Agent
  const turn = (number: number, text = `这个回答可以更简洁一些。Turn ${number}.`, reply?: string): void => {
    session.append('turn/start', { turn: number })
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
    if (reply !== undefined) session.append('assistant/message', { turn: number, step: 1, stream: [], message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: reply }] }) }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: number, reason: { kind: 'completed' } })
  }
  const completion = (): Promise<void> => new Promise((resolve, reject) => {
    const remove = fixture.service.onActivity(activity => {
      if (activity.state === 'idle') { remove(); resolve() }
      if (activity.state === 'error') { remove(); reject(new Error(activity.message)) }
    })
  })
  return { ...fixture, session, agent, create, followup, dispose, started: started.promise, turn, completion }
}

function suppliedTurns(followup: ReturnType<typeof vi.fn<(message: UserMessage) => void>>): Array<{ turn: number; messages: Array<{ role: string; text: string }> }> {
  const block = followup.mock.calls[0]?.[0].content.find(item => item.type === 'text')
  if (block?.type !== 'text') throw new Error('fixture did not receive a learning prompt')
  return JSON.parse(block.text.split('Conversation JSON: ')[1]!) as Array<{ turn: number; messages: Array<{ role: string; text: string }> }>
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('ProjectMemoryService context projection', () => {
  it('keeps project guidance discoverable under a crowded global index without loading topic detail', async () => {
    const { ctx, cwd, service } = await memoryService({ config: { maxContextBytes: 512 } })
    await service.write({ cwd, scope: 'global', summary: 'Presentation preferences.' })
    const global = await service.read(cwd, 'global')
    const index = '# Global memory\n\n' + Array.from({ length: 40 }, (_, i) => `- Presentation preference ${String(i)}: use gray borders.`).join('\n')
    await writeFile(global.path, index)
    await service.write({ cwd, scope: 'project', summary: 'Import images with a preview first.', topic: 'decisions', details: 'Supplier collisions require manual review.' })
    const session = sessionFixture(ctx, 'memory-budget', cwd)
    const decision = await nextMemoryStep(ctx, { id: session.id, session } as unknown as Agent)
    if (decision.kind === 'reject') throw new Error('fixture unexpectedly rejected the step')
    const block = decision.messages[0]?.content[0]
    if (block?.type !== 'text') throw new Error('fixture did not receive a memory snapshot')

    expect(block.text).toContain('Import images with a preview first. ([decisions](decisions.md))')
    expect(block.text).toContain('memory_read({"scope":"global"})')
    expect(block.text).not.toContain('Supplier collisions')
    expect(Buffer.byteLength(block.text, 'utf8')).toBeLessThanOrEqual(512)
    expect((await service.read(cwd, 'global')).content).toBe(index)
    expect((await service.read(cwd, 'project', 'decisions')).content).toContain('Supplier collisions require manual review.')
  })

  it('publishes changed snapshots once and clears them when session use is disabled', async () => {
    const { ctx, cwd, service } = await memoryService()
    await service.write({ cwd, scope: 'project', summary: 'Use focused checks.' })
    const session = sessionFixture(ctx, 'memory-session', cwd)
    const agent = { id: session.id, session } as unknown as Agent
    const preStep = (): Promise<PreStepDecision> => nextMemoryStep(ctx, agent)
    const append = (decision: PreStepDecision): void => {
      if (decision.kind === 'reject') throw new Error('fixture unexpectedly rejected the step')
      const message = decision.messages.at(-1)
      if (message === undefined) throw new Error('fixture did not receive a memory message')
      session.append('user/message', message, { surfaceOp: 'append' })
    }
    const initial = await preStep()
    expect(initial).toMatchObject({ kind: 'enter', startsRequestSeries: true, messages: [{ content: [{ type: 'text', text: expect.stringContaining('Use focused checks.') }] }] })
    append(initial)
    expect(await preStep()).toMatchObject({ kind: 'enter', messages: [] })

    await service.setPolicy(String(session.id), { useMemories: false })
    const cleared = await preStep()
    expect(cleared).toMatchObject({ kind: 'enter', startsRequestSeries: true, messages: [{ content: [{ type: 'text', text: 'Project memory is disabled for this session. Earlier memory snapshots no longer apply.' }] }] })
    append(cleared)
    expect(await preStep()).toMatchObject({ kind: 'enter', messages: [] })
    await service.setPolicy(String(session.id), { useMemories: true })
    expect(await preStep()).toMatchObject({ kind: 'enter', messages: [{ content: [{ type: 'text', text: expect.stringContaining('Use focused checks.') }] }] })
  })

  it('continues the admitted conversation on index read failure and refreshes after recovery', async () => {
    const { ctx, cwd, service } = await memoryService()
    await service.write({ cwd, scope: 'project', summary: 'Keep answers concise.' })
    const session = sessionFixture(ctx, 'memory-unavailable', cwd)
    const agent = { id: session.id, session } as unknown as Agent
    const initial = await nextMemoryStep(ctx, agent)
    if (initial.kind !== 'enter') throw new Error('fixture unexpectedly rejected the step')
    session.append('user/message', initial.messages[0]!, { surfaceOp: 'append' })
    const admitted: PreStepDecision = { kind: 'enter', startsRequestSeries: true, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue working.' }] })] }
    vi.spyOn(service.store, 'read').mockRejectedValueOnce(new Error('index is unavailable'))

    expect(await nextMemoryStep(ctx, agent, admitted)).toBe(admitted)
    await service.write({ cwd, scope: 'project', summary: 'Explain important tradeoffs.' })
    expect(await nextMemoryStep(ctx, agent)).toMatchObject({ kind: 'enter', messages: [{ content: [{ type: 'text', text: expect.stringContaining('Explain important tradeoffs.') }] }] })
  })
})

describe('ProjectMemoryService session policy', () => {
  it('keeps learning opt-in and permits enabling it with the foreground route', async () => {
    const { service, cwd } = await memoryService()
    expect((await service.policy('session')).generateMemories).toBe(false)
    expect(await service.write({ cwd, scope: 'project', summary: 'Prefer concise answers.' })).toBe(true)
    expect((await service.overview(cwd, 'session')).learning).toEqual({ route: undefined, idleDelayMs: 300000, maxRequests: 3 })
    expect(await service.setPolicy('session', { generateMemories: true })).toEqual({ useMemories: true, generateMemories: true })
  })

  it('persists concurrent policy updates across route changes without changing new-session defaults', async () => {
    const first = await memoryService({ config: learningRoute })
    await Promise.all([
      first.service.setPolicy('session-one', { useMemories: false }),
      first.service.setPolicy('session-one', { generateMemories: true }),
    ])
    await first.ctx.fiber.dispose()
    const second = await memoryService({ config: { root: first.service.store.root } })
    expect(await second.service.policy('session-one')).toEqual({ useMemories: false, generateMemories: true })
    expect(await second.service.policy('session-two')).toEqual({ useMemories: true, generateMemories: false })
  })

  it('reports unreadable policy instead of silently enabling the deployment defaults', async () => {
    const { ctx, cwd, service } = await memoryService({ config: { ...learningRoute, generateMemories: true } })
    await service.setPolicy('session-one', { generateMemories: false })
    const [filename] = await readdir(join(service.store.root, 'sessions'))
    if (filename === undefined) throw new Error('fixture did not persist its policy')
    await writeFile(join(service.store.root, 'sessions', filename), '{"generateMemories":"off"}')
    const session = sessionFixture(ctx, 'session-one', cwd)
    await expect(nextMemoryStep(ctx, { id: session.id, session } as unknown as Agent)).rejects.toThrow('invalid memory session policy')
  })
})

describe('ProjectMemoryService quiet learning', () => {
  it.each([
    { name: 'foreground route', config: {}, route: { provider: 'foreground', model: 'large-model' } },
    { name: 'explicit override', config: learningRoute, route: { provider: 'background', model: 'small-model' } },
  ])('uses the $name for background learning', async ({ config, route }) => {
    const fixture = await learningFixture({ config })
    const done = fixture.completion()
    fixture.turn(1)
    await done
    expect(fixture.create.mock.calls[0]?.[0].agentOptions).toEqual({ ...route, maxTokens: 900 })
    expect((await fixture.service.overview(fixture.cwd, String(fixture.session.id))).learning.route)
      .toEqual('extractionProvider' in config ? route : undefined)
  })

  it('coalesces recent turns and restarts the idle wait on new work', async () => {
    const waiting = Promise.withResolvers<void>()
    const restarted = Promise.withResolvers<void>()
    let waits = 0
    const fixture = await learningFixture({
      config: { idleDelayMs: 20 },
      parentIdle: async () => { (waits === 0 ? waiting : restarted).resolve(); waits += 1 },
    })
    const done = fixture.completion()
    fixture.turn(1)
    await waiting.promise
    fixture.turn(2)
    await restarted.promise
    expect(fixture.create).not.toHaveBeenCalled()
    await done
    expect(fixture.create).toHaveBeenCalledOnce()
    expect(suppliedTurns(fixture.followup).map(item => item.turn)).toEqual([1, 2])
  })

  it('drops old whole turns when the pending batch is full', async () => {
    const fixture = await learningFixture({ config: { extractionMaxInputBytes: 220 } })
    const done = fixture.completion()
    for (let turn = 1; turn <= 3; turn++) fixture.turn(turn, 'x'.repeat(40))
    await done
    const turns = suppliedTurns(fixture.followup)
    expect(turns.map(item => item.turn)).toEqual([2, 3])
    expect(Buffer.byteLength(JSON.stringify(turns), 'utf8')).toBeLessThanOrEqual(220)
  })

  it.each(['one reply', 'combined replies'])('keeps complete user evidence when %s overflows the input budget', async mode => {
    const { turn, followup, completion } = await learningFixture({ config: { extractionMaxInputBytes: 512 } })
    const done = completion()
    const correction = '  以后先给结论再解释；但这次临时展开细节，不改变长期偏好。\n'
    const expected = []
    if (mode === 'combined replies') {
      turn(1, 'Preserve user changes.', 'Details. '.repeat(20))
      expected.push({ turn: 1, messages: [{ role: 'user', text: 'Preserve user changes.' }] })
    }
    const number = expected.length + 1
    turn(number, correction, mode === 'one reply' ? 'Detailed explanation. '.repeat(2_000) : 'Details. '.repeat(20))
    expected.push({ turn: number, messages: [{ role: 'user', text: correction }] })
    await done
    expect(suppliedTurns(followup)).toEqual(expected)
    expect(Buffer.byteLength(JSON.stringify(suppliedTurns(followup)))).toBeLessThanOrEqual(512)
  })

  it('cancels waiting work without reviving it when learning is re-enabled', async () => {
    const idle = Promise.withResolvers<void>()
    const waiting = Promise.withResolvers<void>()
    const fixture = await learningFixture({ parentIdle: () => { waiting.resolve(); return idle.promise } })
    fixture.turn(1)
    fixture.turn(2)
    await waiting.promise
    await fixture.service.setPolicy(String(fixture.session.id), { generateMemories: false })
    await fixture.service.setPolicy(String(fixture.session.id), { generateMemories: true })
    idle.resolve()
    expect(fixture.create).not.toHaveBeenCalled()
    const done = fixture.completion()
    fixture.turn(3)
    await done
    expect(fixture.create).toHaveBeenCalledOnce()
    expect(suppliedTurns(fixture.followup).map(item => item.turn)).toEqual([3])
  })

  it('stops and drains an active child before acknowledging disabled learning', async () => {
    const disposing = Promise.withResolvers<void>()
    const drained = Promise.withResolvers<void>()
    const fixture = await learningFixture({ childIdle: () => new Promise(() => {}), disposeChild: () => { disposing.resolve(); return drained.promise } })
    fixture.turn(1)
    await fixture.started
    let acknowledged = false
    const disabled = fixture.service.setPolicy(String(fixture.session.id), { generateMemories: false }).then(() => { acknowledged = true })
    try { await disposing.promise; expect(acknowledged).toBe(false) } finally { drained.resolve() }
    await disabled
    expect(fixture.dispose).toHaveBeenCalledOnce()
  })

  it('reports failed child disposal without reverting the disabled policy', async () => {
    const failure = new Error('child disposal failed')
    const fixture = await learningFixture({ childIdle: () => new Promise(() => {}), disposeChild: async () => { throw failure } })
    const activities: MemoryActivity[] = []
    fixture.service.onActivity(activity => { activities.push(activity) })
    fixture.turn(1)
    await fixture.started
    await expect(fixture.service.setPolicy(String(fixture.session.id), { generateMemories: false })).rejects.toBe(failure)
    expect(activities.at(-1)).toMatchObject({ state: 'error', message: 'child disposal failed' })
    expect((await fixture.service.policy(String(fixture.session.id))).generateMemories).toBe(false)
  })

  it('stops active learning when its source Agent is disposed', async () => {
    const fixture = await learningFixture({ childIdle: () => new Promise(() => {}) })
    const done = fixture.completion()
    fixture.turn(1)
    await fixture.started
    fixture.ctx.emit('agent/disposed', { agent: fixture.agent })
    await done
    expect(fixture.dispose).toHaveBeenCalledOnce()
  })

  it.each(['waiting', 'running'] as const)('disposes the service while learning is %s without waiting for natural completion', async phase => {
    const waiting = Promise.withResolvers<void>()
    const fixture = await learningFixture(phase === 'waiting'
      ? { parentIdle: () => { waiting.resolve(); return new Promise(() => {}) } }
      : { childIdle: () => new Promise(() => {}) })
    fixture.turn(1)
    await (phase === 'waiting' ? waiting.promise : fixture.started)
    await fixture.ctx.fiber.dispose()
    expect(fixture.create).toHaveBeenCalledTimes(phase === 'running' ? 1 : 0)
    expect(fixture.dispose).toHaveBeenCalledTimes(phase === 'running' ? 1 : 0)
  })
})

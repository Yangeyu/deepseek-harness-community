import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectMemoryService } from '../src/index.ts'

const temporaryDirectories: string[] = []
const contexts: Context[] = []

async function memoryService(): Promise<{ ctx: Context; cwd: string; service: ProjectMemoryService }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-service-test-'))
  temporaryDirectories.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('tools', { register: () => () => {} } as unknown as Context['tools'])
  ctx.provide('agents', { get: () => undefined } as unknown as Context['agents'])
  ctx.provide('systemPrompt', {} as Context['systemPrompt'])
  return {
    ctx,
    cwd: root,
    service: new ProjectMemoryService(ctx, {
      root: join(root, 'memories'),
      useMemories: true,
      generateMemories: false,
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

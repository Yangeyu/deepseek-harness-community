import { access, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionLogOffset, SessionStore } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import * as Browser from '../../../src/browser.ts'

// Replace only the external browser peer. Production configuration, Agent factory,
// Session persistence, scoped registration, execution and teardown remain real.
vi.mock('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp', async (original) => {
  const runtime = await original<typeof import('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp')>()
  const { fileURLToPath } = await import('node:url')
  return {
    ...runtime,
    mountSessionMcp(ctx: Context, options: Parameters<typeof runtime.mountSessionMcp>[1]) {
      runtime.mountSessionMcp(ctx, {
        ...options, args: [fileURLToPath(new URL('./fixtures/session-mcp.mjs', import.meta.url))],
      })
    },
  }
})

const require = createRequire(import.meta.url)
const base = createRequire(require.resolve('@deepseek-ai/dsh-base/package.json'))
const { AgentLoop } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-agent-loop')).href) as {
  AgentLoop: { new (ctx: Context, config: { agents: []; maxParallelToolCalls: { get(): number } }): unknown; Config(input: { agents: [] }): { agents: []; maxParallelToolCalls: { get(): number } } }
}
const { apply: installPersistence } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href) as {
  apply: (ctx: Context, config: { root: string }) => Promise<void>
}

it('keeps new, forked and resumed Sessions independent across cancellation and disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-sessions-'))
  const ctx = new Context()
  try {
    await installPersistence(ctx, { root })
    new AgentRegistry(ctx)
    new SessionStore(ctx)
    new SessionProjectionRegistry(ctx)
    new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
    new ToolRuntime(ctx)
    ctx.provide('workingDirectory', { ensure: async (agent: Agent) => agent.session.header.cwd ?? root } as never)
    ctx.provide('credentials', { resolve: async () => undefined } as never)
    ctx.provide('typert', { resources: { register() {} }, lookups: { configure() {} }, contexts: { configureHost() {} } } as never)
    new AgentLoop(ctx, AgentLoop.Config({ agents: [] }))
    await ctx.plugin(Browser)

    let callId = 0
    const call = (agent: Agent, args: Record<string, unknown> = {}, signal = AbortSignal.timeout(5000)) =>
      ctx.tools.execute({
        agent, name: 'mcp__playwright__browser_page', arguments: args, signal,
        callId: `browser-${++callId}` as ToolExecutionInput['callId'],
      })
    const page = async (agent: Agent, args: Record<string, unknown> = {}) => {
      const result = await call(agent, args)
      expect(result.isError).toBe(false)
      const text = result.content.find(block => block.type === 'text')
      if (text?.type !== 'text') throw new Error('missing page result')
      return JSON.parse(text.text) as { pid: number; page: string }
    }

    const source = await ctx.agents.create({ sessionId: SessionId('browser-source'), meta: { cwd: root } })
    source.agent.session.append('model/selection', { provider: 'fixture', model: 'no-network' })
    const original = await page(source.agent, { page: 'source-page' })
    source.agent.session.append('turn/start', { turn: 1 })
    source.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await new Promise(resolve => setImmediate(resolve))
    expect(await page(source.agent)).toEqual(original)
    const seed = source.agent.session.snapshotEvents()
    const fork = await ctx.agents.create({
      sessionId: SessionId('browser-fork'), seed, inheritedEventCount: SessionLogOffset(seed.length),
      meta: { cwd: root, parentSession: source.agent.id, isSeeded: true },
    })
    const branch = await page(fork.agent, { page: 'fork-page' })
    expect(branch.pid).not.toBe(original.pid)
    expect(await page(source.agent)).toEqual(original)

    const cancel = new AbortController()
    const started = join(root, 'call-started')
    const interrupted = call(source.agent, { started }, cancel.signal)
    await vi.waitFor(() => access(started))
    expect(await page(fork.agent)).toEqual(branch)
    cancel.abort()
    expect((await interrupted).isError).toBe(true)
    expect(await page(fork.agent)).toEqual(branch)
    expect(await page(source.agent)).toEqual(original)

    await source.dispose()
    expect(await page(fork.agent)).toEqual(branch)
    const resumed = await ctx.agents.resume({ resumeSessionId: SessionId('browser-source') })
    const fresh = await page(resumed.agent)
    expect(fresh.page).toBe('blank')
    expect(fresh.pid).not.toBe(original.pid)
    expect(fresh.pid).not.toBe(branch.pid)
    expect(await page(fork.agent)).toEqual(branch)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

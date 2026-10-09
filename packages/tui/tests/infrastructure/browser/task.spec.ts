import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineContentToolFixture, ToolRuntime, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { mountBrowserTasks } from '../../../src/infrastructure/browser/task.ts'
import type { CursorCommand } from '../../../src/infrastructure/browser/page-cursor.ts'

const require = createRequire(import.meta.url)
const base = createRequire(require.resolve('@deepseek-ai/dsh-base/package.json'))
const { AgentLoop } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-agent-loop')).href) as {
  AgentLoop: new (ctx: Context, config: { agents: []; maxParallelToolCalls: { get(): number } }) => unknown
}
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.useRealTimers()
})

async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new ToolRuntime(ctx)
  ctx.provide('typert', { lookups: { configure() {} }, contexts: { configureHost() {} } } as never)
  new AgentLoop(ctx, { agents: [], maxParallelToolCalls: { get: () => 10 } })
  const commands: CursorCommand[] = []
  const action = vi.fn(async () => [{ type: 'text' as const, text: 'Clicked' }])
  const disconnect = vi.fn(async () => {})
  let prepare: ((signal: AbortSignal) => Promise<void>) | undefined
  for (const name of ['list_user_tabs', 'click', 'take_screenshot', 'evaluate', 'run_code_unsafe', 'close']) {
    ctx.tools.register(defineContentToolFixture({
      name: `mcp__playwright__browser_${name}`, description: name,
      parameters: {
        target: { type: 'string' }, function: { type: 'string' }, code: { type: 'string' },
      },
      async execute(args, exec) {
        if (name === 'list_user_tabs') return []
        if (name === 'evaluate' || name === 'run_code_unsafe') {
          const command = JSON.parse((args.function ?? args.code)!.match(/\)\((\{"phase".*?\}), target\)/s)![1]!) as CursorCommand
          commands.push(command)
          if (command.phase === 'show') await prepare?.(exec.signal)
          return []
        }
        if (name === 'take_screenshot') {
          expect(commands.at(-1)?.phase).toBe('suspend')
          return [{ type: 'text', text: 'Screenshot result' }]
        }
        if (name === 'close') { await disconnect(); return [] }
        return action()
      },
    }))
  }
  mountBrowserTasks(ctx)
  const handle = await ctx.agents.create({ sessionId: SessionId('cursor') })
  let sequence = 0
  const call = (name = 'click', signal = AbortSignal.timeout(5000)) => ctx.tools.execute({
    name: `mcp__playwright__browser_${name}`, agent: handle.agent,
    arguments: { target: 'e2' }, signal,
    callId: `cursor-${++sequence}` as ToolExecutionInput['callId'],
  })
  return { ctx, handle, call, commands, action, disconnect, prepare: (fn: typeof prepare) => { prepare = fn } }
}

it('keeps feedback through thinking and screenshots, and releases it on the actual turn boundary', async () => {
  const f = await fixture()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  await f.call('list_user_tabs')
  expect(f.commands).toEqual([])
  expect((await f.call()).content).toEqual([{ type: 'text', text: 'Clicked' }])
  await vi.advanceTimersByTimeAsync(16000)
  expect(f.commands.filter(command => command.phase === 'pulse')).toHaveLength(3)
  expect(f.commands.some(command => command.phase === 'release')).toBe(false)
  expect((await f.call('take_screenshot')).content).toEqual([{ type: 'text', text: 'Screenshot result' }])
  expect(f.commands.at(-1)?.phase).toBe('resume')

  const owner = f.commands[0]!.owner
  f.handle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await vi.waitFor(() => expect(f.commands.at(-1)).toMatchObject({ phase: 'release', owner }))
  await vi.waitFor(() => expect(f.disconnect).toHaveBeenCalledTimes(1))
  const settled = f.commands.length
  await vi.advanceTimersByTimeAsync(16000)
  expect(f.commands).toHaveLength(settled)
  await f.call()
  expect(f.commands.at(-1)!.owner).not.toBe(owner)
  await f.handle.dispose()
  await vi.waitFor(() => expect(f.commands.at(-1)?.phase).toBe('release'))
})

it('preserves action errors when visuals fail and prevents a click cancelled during preparation', async () => {
  const f = await fixture()
  f.prepare(async () => { throw new Error('Page cannot render cursor') })
  f.action.mockRejectedValueOnce(new Error('Target detached'))
  const failed = await f.call()
  expect(failed.isError).toBe(true)
  expect(failed.content).toEqual([{ type: 'text', text: 'Error: Target detached' }])

  const started = Promise.withResolvers<void>()
  f.prepare(signal => new Promise<void>(resolve => {
    signal.addEventListener('abort', () => resolve(), { once: true })
    started.resolve()
  }))
  const cancel = new AbortController()
  const cancelled = f.call('click', cancel.signal)
  await started.promise
  cancel.abort()
  expect((await cancelled).isError).toBe(true)
  expect(f.action).toHaveBeenCalledTimes(1)
  expect(f.commands.at(-1)?.phase).toBe('release')
})

it('waits for the previous task to disconnect before admitting a new turn', async () => {
  const f = await fixture()
  await f.call()
  const closing = Promise.withResolvers<void>()
  f.disconnect.mockImplementationOnce(() => closing.promise)
  f.handle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await vi.waitFor(() => expect(f.disconnect).toHaveBeenCalledTimes(1))
  const next = f.call()
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(f.action).toHaveBeenCalledTimes(1)
  closing.resolve()
  expect((await next).isError).toBe(false)
  expect(f.action).toHaveBeenCalledTimes(2)
})

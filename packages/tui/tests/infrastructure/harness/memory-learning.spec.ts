import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk, type ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { ProjectMemoryService } from '@vascent/deepseek-harness-memory'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const baseRequire = createRequire(require.resolve('@deepseek-ai/dsh-base/package.json'))
const { AgentLoop } = await import(pathToFileURL(baseRequire.resolve('@deepseek-ai/dsh-agent-loop')).href) as {
  AgentLoop: new (ctx: Context, config: { agents: [] }) => unknown
}
const contexts: Context[] = []
const directories: string[] = []
const message = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

async function* answer(): AsyncGenerator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'Done.' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function* callTool(name: string, args: Record<string, unknown>, id: string): AsyncGenerator<StreamChunk> {
  const block: ToolCallBlock = { type: 'tool-call', id: id as ToolCallBlock['id'], name, arguments: JSON.stringify(args) }
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments }
  yield { type: 'block-end', index: 0, block }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

async function fixture(stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-memory-loop-'))
  directories.push(cwd)
  const ctx = new Context()
  contexts.push(ctx)
  // Only the transport registration and provider responses are stubs. Scheduling,
  // request limits, pre-step snapshots, tools and file mutations are production code.
  ctx.provide('typert', { lookups: { configure() {} }, contexts: { configureHost() {} } } as never)
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  new ToolRuntime(ctx)
  new LlmRuntime(ctx)
  class ScriptedAdapter extends LlmAdapter {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> { return stream(options) }
  }
  ctx.llm.registerAdapter(['fixture'], new ScriptedAdapter())
  new AgentLoop(ctx, { agents: [] })
  const memory = new ProjectMemoryService(ctx, {
    root: join(cwd, 'memories'), generateMemories: true, idleDelayMs: 0,
    extractionProvider: 'fixture', extractionModel: 'scripted', maxContextBytes: 256,
  })
  const source = await ctx.agents.create({
    sessionId: SessionId('source'), meta: { cwd }, agentOptions: { provider: 'fixture', model: 'scripted' },
  })
  return { ctx, cwd, memory, source }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Memory with the real Agent loop', () => {
  it('lets new foreground work finish while canceled learning is still draining', async () => {
    const release = Promise.withResolvers<void>()
    let backgroundSignal: AbortSignal | undefined
    let foregroundRequests = 0
    const { memory, source } = await fixture(async function* (options) {
      if (String(options.sessionId).startsWith('memory-')) {
        backgroundSignal = options.signal
        await release.promise
        options.signal?.throwIfAborted()
      } else foregroundRequests += 1
      yield* answer()
    })
    try {
      source.agent.followup(message('以后先给结论，再解释理由。'))
      await vi.waitFor(() => expect(backgroundSignal).toBeDefined())
      source.agent.followup(message('继续下一个任务。'))
      await vi.waitFor(() => {
        expect(foregroundRequests).toBe(2)
        expect(source.agent.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(2)
        expect(backgroundSignal?.aborted).toBe(true)
      })
    } finally {
      const disabled = memory.setPolicy('source', { generateMemories: false })
      release.resolve()
      await disabled
    }
  })

  it('replaces a memory within three requests and leaves foreground requests unrestricted', async () => {
    const oldSummary = '外部提交失败时自动重试两次。'
    const newSummary = '外部提交只尝试一次，失败由用户手动重试。'
    const childCalls: string[] = []
    const results: Array<{ name: string; isError: boolean }> = []
    let foregroundRequests = 0
    const { ctx, cwd, memory, source } = await fixture(async function* (options) {
      if (!String(options.sessionId).startsWith('memory-')) {
        foregroundRequests += 1
        yield* answer()
        return
      }
      const steps = [
        { name: 'memory_read', args: { scope: 'project' } },
        { name: 'memory_read', args: { scope: 'project', topic: 'decisions' } },
        { name: 'memory_write', args: { scope: 'project', topic: 'decisions', summary: newSummary, details: '不安排后台自动重试。', replaces: { summary: oldSummary, topic: 'decisions' } } },
      ]
      const step = steps[childCalls.length]
      childCalls.push(step?.name ?? 'unexpected-continuation')
      if (step !== undefined) yield* callTool(step.name, step.args, String(childCalls.length))
      else yield* answer()
    })
    ctx.on('tools/result', (exec, result) => { results.push({ name: exec.name, isError: result.isError }) })
    for (const summary of ['错误提示保留可复制的请求标识。', '同一页面的错误提示保持在输入框附近。', '提交中的按钮必须明显表示正在处理。']) {
      await memory.write({ cwd, scope: 'project', summary })
    }
    await memory.write({ cwd, scope: 'project', topic: 'decisions', summary: oldSummary, details: '旧设计需要更正。' })
    const done = Promise.withResolvers<void>()
    memory.onActivity(activity => {
      if (activity.state === 'idle') done.resolve()
      if (activity.state === 'error') done.reject(new Error(activity.message))
    })
    source.agent.followup(message('外部提交不要自动重试，失败就显示原因，让用户手动决定。'))
    await done.promise
    await memory.setPolicy('source', { generateMemories: false })
    expect(childCalls).toEqual(['memory_read', 'memory_read', 'memory_write'])
    expect(results).toEqual(childCalls.map(name => ({ name, isError: false })))
    for (const topic of [undefined, 'decisions'] as const) {
      const document = await memory.read(cwd, 'project', topic)
      expect(document.content).toContain(newSummary)
      expect(document.content).not.toContain(oldSummary)
    }
    for (let i = 0; i < 3; i++) {
      source.agent.followup(message('继续处理前台任务。'))
      await source.agent.whenIdle()
    }
    expect(foregroundRequests).toBe(4)
  })
})

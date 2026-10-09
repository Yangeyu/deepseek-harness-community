import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolDispatchExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { cursorScript, type CursorCommand } from './page-cursor.ts'

const prefix = 'mcp__playwright__'

/** Task lifetime over the upstream Session-owned MCP connection. */
class BrowserTask {
  private readonly owner = randomUUID()
  private readonly controller = new AbortController()
  private readonly pending = new Set<Promise<void>>()
  closing?: Promise<void>

  constructor(private readonly ctx: Context, private readonly exec: ToolDispatchExecution) {}

  show(signal: AbortSignal): Promise<void> {
    return this.visual('show', signal)
  }

  visual(phase: CursorCommand['phase'], signal?: AbortSignal): Promise<void> {
    const args = { function: cursorScript({ phase, owner: this.owner, expiresAt: Date.now() + 2000 }) }
    const combined = AbortSignal.any([
      this.controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(2000),
    ])
    const task = this.execute('browser_evaluate', args, combined).then(() => {}, () => {})
    this.pending.add(task)
    void task.finally(() => this.pending.delete(task))
    return task
  }

  private async execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const tool = this.ctx.tools.get(`${prefix}${name}`, this.exec.agent)
    if (!tool) return // Session disposal already unregistered and closed its MCP client.
    const run: ToolRunContext = {
      ...this.exec, name: `${prefix}${name}`, arguments: args, signal,
      deferContext() {}, concludeTurn() {},
    }
    // An accepted call already owns the Session lock. Internal presentation and cleanup
    // invoke the public body, rather than recursively dispatching another model tool.
    const value = await tool.execute(args, run)
    if (value && typeof value === 'object' && 'isError' in value && value.isError) {
      throw new Error(`Playwright ${name} failed`)
    }
  }

  finish(disconnect = true): Promise<void> {
    return this.closing ??= (async () => {
      this.controller.abort()
      await Promise.all(this.pending)
      if (disconnect) await this.execute('browser_close', {}, AbortSignal.timeout(5000))
    })()
  }
}

/** Installed after mountSessionMcp, inside its per-Session serialized tool call. */
export function mountBrowserTasks(ctx: Context): void {
  const tasks = new Map<Agent, BrowserTask>()
  const finish = async (agent: Agent, disconnect = true) => {
    const task = tasks.get(agent)
    try {
      await task?.finish(disconnect)
    } finally {
      if (tasks.get(agent) === task) tasks.delete(agent)
    }
  }
  const finishInBackground = (agent: Agent) => {
    void finish(agent).catch(() => ctx.logger.warn('Browser task could not release its Playwright connection.'))
  }
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const agent = ctx.agents.get(session.id)
    if (agent) finishInBackground(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => finishInBackground(agent))
  ctx.effect(() => async () => { await Promise.all([...tasks.keys()].map(agent => finish(agent))) })

  ctx.on('tools/execute', async (exec, next) => {
    if (!exec.agent || !exec.name.startsWith(`${prefix}browser_`)) return next()
    // A new turn may arrive while asynchronous turn/end cleanup is draining.
    await tasks.get(exec.agent)?.closing
    const name = exec.name.slice(prefix.length)
    if (name === 'browser_close') {
      await finish(exec.agent, false)
      return next()
    }
    let task = tasks.get(exec.agent)
    if (!task) {
      task = new BrowserTask(ctx, exec)
      tasks.set(exec.agent, task)
    }
    const args = exec.arguments as { action?: string }
    const pointer = name === 'browser_click' || name === 'browser_hover'
    const screenshot = name === 'browser_take_screenshot'
    const closeTab = name === 'browser_tabs' && args.action === 'close'
    const discovery = name === 'browser_list_user_tabs'
    try {
      if (pointer) await task.show(exec.signal)
      if (screenshot) await task.visual('suspend', exec.signal)
      exec.signal.throwIfAborted()
      const result = await next()
      if (!result.isError && !closeTab && !discovery) await task.show(exec.signal)
      return result
    } finally {
      if (exec.signal.aborted) await finish(exec.agent).catch(() => ctx.logger.warn('Browser task could not release its Playwright connection.'))
      else if (screenshot) await task.visual('resume')
    }
  })
}

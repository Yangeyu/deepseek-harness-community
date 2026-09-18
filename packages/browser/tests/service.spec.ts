import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserService, type Config } from '../src/index.ts'
import { BrowserError } from '../src/protocol.ts'
import { createBrowserWorker } from '../src/worker.ts'

vi.mock('../src/worker.ts', () => ({ createBrowserWorker: vi.fn() }))
const create = vi.mocked(createBrowserWorker)
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.clearAllMocks()
  vi.useRealTimers()
})

function agent(id = 'session-1'): Agent {
  return { id, session: { requestHeader: () => ({ config: { provider: 'main', model: 'model' } }) }, options: {} } as unknown as Agent
}

const attachment = { attachmentId: AttachmentId('sha256:test'), mediaType: 'image/jpeg' as const, width: 1120, height: 780, bytes: 4 }
const page = (sequence = 1) => ({
  observationId: `observation-${sequence}`, url: 'https://example.com/account', title: 'Account', text: 'Ready', omittedActions: 0,
  actions: [
    { id: 'e1', kind: 'fill', label: 'Search' }, { id: 'e2', kind: 'click', label: 'Save' },
    { id: 'e3', kind: 'select', label: 'Plan → Basic' }, { id: 'scroll_down', kind: 'scroll', label: 'Scroll' },
  ],
})

function setup(config: Config = {}, owner = agent()) {
  const ctx = new Context()
  contexts.push(ctx)
  const tools = new Map<string, ToolDefinition>()
  const approval = vi.fn(async (_request: Parameters<Context['approval']['request']>[0]): Promise<ApprovalOutcome> => 'allowed-once')
  const saveImage = vi.fn(async () => attachment)
  const resolveModelInfo = vi.fn(async () => ({ inputModalities: ['image'] }))
  let sequence = 0
  const request = vi.fn(async (command: { op: string; actionId?: string; screenshot?: boolean }, _signal: AbortSignal): Promise<unknown> => {
    if (command.op === 'open') return { status: 'opened', origin: 'https://example.com' }
    if (command.op === 'observe') return { ...page(++sequence), ...(command.screenshot ? { screenshot: '/9j/2Q==' } : {}) }
    if (command.op === 'act') return { status: 'executed', actionId: command.actionId }
    return { status: 'closed' }
  })
  const dispose = vi.fn(async () => {})
  create.mockReturnValue({ request, dispose })
  ctx.provide('tools', { register: (tool: ToolDefinition) => { tools.set(tool.name, tool) } } as unknown as Context['tools'])
  ctx.provide('settings', { register: () => ({ get: () => config }) } as unknown as Context['settings'])
  ctx.provide('approval', { request: approval } as unknown as Context['approval'])
  ctx.provide('attachments', { saveImage } as unknown as Context['attachments'])
  ctx.provide('llm', { resolveModelInfo } as unknown as Context['llm'])
  new BrowserService(ctx, config)
  const deferred = vi.fn()
  const call = async (name: string, args: Record<string, unknown>, overrides: Partial<ToolRunContext> = {}) => {
    const exec = { name, callId: `call-${name}`, signal: new AbortController().signal, agent: owner, deferContext: deferred, ...overrides } as unknown as ToolRunContext
    return await tools.get(name)!.execute(args, exec) as Record<string, unknown>
  }
  const open = async () => (await call('browser_open', { url: 'https://example.com/account' })).browserId as string
  return { ctx, tools, owner, call, open, approval, request, dispose, saveImage, resolveModelInfo, deferred }
}

describe('Agent-owned browser operations', () => {
  it('lets the Agent observe, approve one action, and verify in the same tab', async () => {
    const s = setup()
    const browserId = await s.open()
    const observation = await s.call('browser_observe', { browserId })
    await expect(s.call('browser_act', { browserId, observationId: observation.observationId, actionId: 'e1', text: '东京' }))
      .resolves.toEqual({ browserId, actionId: 'e1', status: 'executed' })
    expect(s.approval).toHaveBeenCalledTimes(2)
    expect(s.approval.mock.calls[1]?.[0]).toMatchObject({ toolName: 'browser_act', reason: expect.stringContaining('东京') })
    const verified = await s.call('browser_observe', { browserId })
    expect(verified.observationId).not.toBe(observation.observationId)
    await s.call('browser_close', { browserId })
    expect(create).toHaveBeenCalledTimes(1)
    expect(s.dispose).toHaveBeenCalled()
  })

  it('rejects denied or unavailable access before allocating a browser', async () => {
    const s = setup()
    for (const outcome of ['rejected', 'unavailable', 'cancelled'] as const) {
      s.approval.mockResolvedValueOnce(outcome)
      await expect(s.open()).rejects.toMatchObject({ code: 'denied' })
    }
    expect(create).not.toHaveBeenCalled()
  })

  it('does not infer browser access from file Full Access or bypass a rejected action', async () => {
    const s = setup()
    const browserId = await s.open()
    const observation = await s.call('browser_observe', { browserId })
    s.approval.mockResolvedValueOnce('rejected')
    await expect(s.call('browser_act', { browserId, observationId: observation.observationId, actionId: 'e2' })).rejects.toMatchObject({ code: 'denied' })
    expect(s.request.mock.calls.some(([command]) => command.op === 'act')).toBe(false)
    await expect(s.call('browser_act', { browserId, observationId: observation.observationId, actionId: 'e2' })).rejects.toMatchObject({ code: 'stale' })
  })

  it('binds a handle to the live Agent object, not a replayable session id', async () => {
    const s = setup()
    const browserId = await s.open()
    await expect(s.call('browser_observe', { browserId }, { agent: agent('session-1') })).rejects.toMatchObject({ code: 'owner' })
    await expect(s.open()).rejects.toMatchObject({ code: 'busy' })
  })

  it('rejects expired observations and unobserved actions before dispatch', async () => {
    const s = setup()
    const browserId = await s.open()
    const old = await s.call('browser_observe', { browserId })
    await s.call('browser_observe', { browserId })
    await expect(s.call('browser_act', { browserId, observationId: old.observationId, actionId: 'e2' })).rejects.toMatchObject({ code: 'stale' })
    const fresh = await s.call('browser_observe', { browserId })
    await expect(s.call('browser_act', { browserId, observationId: fresh.observationId, actionId: 'invented' })).rejects.toMatchObject({ code: 'invalid' })
    expect(s.request.mock.calls.some(([command]) => command.op === 'act')).toBe(false)
  })

  it('passes approval before executor freshness validation and never retries uncertainty', async () => {
    const s = setup()
    const browserId = await s.open()
    for (const code of ['stale', 'uncertain']) {
      const observation = await s.call('browser_observe', { browserId })
      s.request.mockRejectedValueOnce(new BrowserError(code, 'Inspect before continuing'))
      await expect(s.call('browser_act', { browserId, observationId: observation.observationId, actionId: 'e2' })).rejects.toMatchObject({ code })
      await expect(s.call('browser_act', { browserId, observationId: observation.observationId, actionId: 'e2' })).rejects.toMatchObject({ code: 'stale' })
    }
    expect(s.request.mock.calls.filter(([command]) => command.op === 'act')).toHaveLength(2)
  })

  it('reuses site approval for scrolling but still consumes the observation', async () => {
    const s = setup()
    const browserId = await s.open()
    const observation = await s.call('browser_observe', { browserId })
    await s.call('browser_act', { browserId, observationId: observation.observationId, actionId: 'scroll_down' })
    expect(s.approval).toHaveBeenCalledOnce()
    await expect(s.call('browser_act', { browserId, observationId: observation.observationId, actionId: 'scroll_down' })).rejects.toMatchObject({ code: 'stale' })
  })

  it('withdraws an action approval on cancellation and closes the owned executor', async () => {
    const s = setup()
    const browserId = await s.open()
    const observation = await s.call('browser_observe', { browserId })
    const controller = new AbortController()
    s.approval.mockImplementationOnce(async (...args: unknown[]) => {
      const request = args[0] as { signal: AbortSignal }
      controller.abort()
      expect(request.signal.aborted).toBe(true)
      return 'cancelled'
    })
    await expect(s.call('browser_act', { browserId, observationId: observation.observationId, actionId: 'e2' }, { signal: controller.signal })).rejects.toThrow()
    expect(s.dispose).toHaveBeenCalled()
    expect(s.request.mock.calls.some(([command]) => command.op === 'act')).toBe(false)
  })

  it('stores screenshot evidence and renders native images, including nested code calls', async () => {
    const s = setup()
    const browserId = await s.open()
    const value = await s.call('browser_observe', { browserId, screenshot: true }, { parent: Symbol('parent') as NonNullable<ToolRunContext['parent']> })
    expect(value.attachment_ref).toEqual(attachment)
    expect(s.saveImage).toHaveBeenCalledWith({ data: Buffer.from('/9j/2Q==', 'base64'), mediaType: 'image/jpeg', name: 'browser-screenshot.jpg' })
    const content = s.tools.get('browser_observe')!.output.render({}, value as never)
    expect(content).toContainEqual({ type: 'image', attachment })
    expect(s.deferred).toHaveBeenCalledOnce()
    expect(s.approval).toHaveBeenCalledTimes(2)
  })

  it('uses attachment references rather than binary images for a forced Vision proxy route', async () => {
    const s = setup()
    s.ctx.provide('vision', { resolveImageRoute: async () => ({ strategy: 'proxy' }) } as unknown as Context['vision'])
    const browserId = await s.open()
    const value = await s.call('browser_observe', { browserId, screenshot: true })
    expect(value.inlineImage).toBe(false)
    const content = s.tools.get('browser_observe')!.output.render({}, value as never)
    expect(content.every(block => block.type === 'text')).toBe(true)
    expect(JSON.stringify(content)).toContain('inspect_image')
    expect(s.resolveModelInfo).not.toHaveBeenCalled()
  })

  it('does not capture a screenshot when approval is denied', async () => {
    const s = setup()
    const browserId = await s.open()
    s.approval.mockResolvedValueOnce('rejected')
    await expect(s.call('browser_observe', { browserId, screenshot: true })).rejects.toMatchObject({ code: 'denied' })
    expect(s.request.mock.calls.some(([command]) => command.op === 'observe')).toBe(false)
    expect(s.saveImage).not.toHaveBeenCalled()
  })

  it('refuses cross-origin evidence before it enters a tool result or attachment store', async () => {
    const s = setup()
    const browserId = await s.open()
    s.request.mockResolvedValueOnce({ ...page(), url: 'https://other.test/private' })
    await expect(s.call('browser_observe', { browserId })).rejects.toMatchObject({ code: 'origin_changed' })
    expect(s.saveImage).not.toHaveBeenCalled()
  })

  it('expires idle handles and invalidates handles at turn completion', async () => {
    vi.useFakeTimers()
    const s = setup({ idleTimeoutMs: 1000 })
    const browserId = await s.open()
    await vi.advanceTimersByTimeAsync(1000)
    await expect(s.call('browser_observe', { browserId })).rejects.toMatchObject({ code: 'owner' })
    const nextId = await s.open()
    s.ctx.emit('agent/status', { agent: s.owner, status: 'idle' })
    await expect(s.call('browser_observe', { browserId: nextId })).rejects.toMatchObject({ code: 'owner' })
    expect(s.dispose).toHaveBeenCalledTimes(2)
  })

  it('drains active resources on plugin disposal', async () => {
    const s = setup()
    await s.open()
    await s.ctx.fiber.dispose()
    expect(s.dispose).toHaveBeenCalledOnce()
  })
})

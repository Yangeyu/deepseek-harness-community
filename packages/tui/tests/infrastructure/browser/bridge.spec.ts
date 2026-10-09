import { afterEach, expect, it, vi } from 'vitest'

const { BrowserBridge } = await import(new URL('../../../../../extensions/browser/bridge.js', import.meta.url).href)

const bridges: InstanceType<typeof BrowserBridge>[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(bridges.splice(0).map(bridge => bridge.stop()))
})

function fixture() {
  const detached: number[] = []
  const replies: any[] = []
  const chrome = {
    debugger: {
      onEvent: { addListener() {} }, onDetach: { addListener() {} },
      attach: vi.fn(async () => {}),
      detach: vi.fn(async ({ tabId }: { tabId: number }) => { detached.push(tabId) }),
      sendCommand: vi.fn(async ({ tabId }: { tabId: number }, _method: string, _params: any): Promise<any> => ({ targetInfo: { targetId: `target-${tabId}`, type: 'page' } })),
    },
    tabs: {
      onCreated: { addListener() {} },
      get: vi.fn(async (id: number) => ({ id, windowId: 1, url: 'https://example.com' })),
      create: vi.fn(async () => ({ id: 5 })),
      update: vi.fn(async () => {}),
    },
    windows: { getAll: vi.fn(async () => [{ id: 1 }]), update: vi.fn(async () => {}) },
  }
  const bridge = new BrowserBridge(chrome, (message: any) => replies.push(message))
  bridges.push(bridge)
  let id = 0
  const call = async (client: string, method: string, params = {}, sessionId?: string) => {
    const callId = ++id
    await bridge.receive({ client, message: { id: callId, method, params, sessionId } })
    return replies.find(value => value.message?.id === callId)?.message
  }
  return { chrome, bridge, call, detached }
}

it('keeps page selection in the background and exposes foreground presentation separately', async () => {
  const f = fixture()
  await f.call('a', 'Target.createTarget', { url: 'https://example.com' })
  expect(f.chrome.tabs.create).toHaveBeenCalledWith({ active: false, windowId: 1, url: 'https://example.com' })
  await f.call('a', 'Page.bringToFront', {}, 'dscode-tab-5')
  expect(f.chrome.tabs.update).not.toHaveBeenCalled()
  expect(f.chrome.windows.update).not.toHaveBeenCalled()
  await f.call('a', 'dscode.focusTab', { tabId: 5 })
  expect(f.chrome.windows.update).toHaveBeenCalledWith(1, { focused: true })
})

it('reserves a tab across concurrent claims and releases only the owning task', async () => {
  const f = fixture()
  let attached!: () => void
  f.chrome.debugger.attach.mockImplementationOnce(() => new Promise<void>(resolve => { attached = resolve }))
  const first = f.call('a', 'dscode.claimTab', { tabId: 1 })
  await vi.waitFor(() => expect(attached).toBeTypeOf('function'))
  expect((await f.call('b', 'dscode.claimTab', { tabId: 1 })).error.message).toContain('another browser task')
  await f.call('b', 'dscode.claimTab', { tabId: 2 })
  const release = f.bridge.close('a')
  attached()
  await Promise.all([first, release])
  expect(f.bridge.owners.has(1)).toBe(false)
  expect(f.bridge.owners.get(2)).toBe('b')
  expect(f.detached).not.toContain(2)
  await f.call('c', 'dscode.claimTab', { tabId: 1 })
  expect(f.bridge.owners.get(1)).toBe('c')
})

it('cleans up a debugger attachment when target initialization fails', async () => {
  const f = fixture()
  f.chrome.debugger.sendCommand.mockRejectedValueOnce(new Error('tab disappeared'))
  expect((await f.call('a', 'dscode.claimTab', { tabId: 1 })).error.message).toBe('tab disappeared')
  expect(f.bridge.owners.size).toBe(0)
  expect(f.detached).toContain(1)
})

it('waits for cursor arrival before forwarding concurrent move, press and release at the actual coordinates', async () => {
  const f = fixture()
  await f.call('a', 'dscode.claimTab', { tabId: 1 })
  const arrival = Promise.withResolvers<void>()
  const input: any[] = []
  f.chrome.debugger.sendCommand.mockImplementation(async (_target, method, params) => {
    if (method === 'Runtime.evaluate') await arrival.promise
    if (method === 'Input.dispatchMouseEvent') input.push(params)
    return {}
  })
  const events = ['mouseMoved', 'mousePressed', 'mouseReleased'].map(type => ({ type, x: 120, y: 240 }))
  const pending = events.map(params => f.call('a', 'Input.dispatchMouseEvent', params, 'dscode-tab-1'))
  await vi.waitFor(() => expect(f.chrome.debugger.sendCommand).toHaveBeenCalledWith(
    { tabId: 1 }, 'Runtime.evaluate', expect.objectContaining({ expression: expect.stringContaining('move(120,240,true)') }),
  ))
  expect(input).toEqual([])
  arrival.resolve()
  await Promise.all(pending)
  expect(input).toEqual(events)

  // A stop while the next visual is pending must not deliver the queued click.
  const waiting = Promise.withResolvers<void>()
  f.chrome.debugger.sendCommand.mockImplementationOnce(() => waiting.promise)
  const cancelled = f.call('a', 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 300, y: 200 }, 'dscode-tab-1')
  await new Promise(resolve => setImmediate(resolve))
  await f.bridge.close('a')
  waiting.resolve()
  expect((await cancelled).error.message).toBe('Browser task ended')
  expect(input).toEqual(events)
})

it('keeps browser input usable when rendering fails or the page stops scheduling animation', async () => {
  const f = fixture()
  await f.call('a', 'dscode.claimTab', { tabId: 1 })
  vi.useFakeTimers()
  try {
    const input: string[] = []
    f.chrome.debugger.sendCommand.mockImplementation(async (_target, method, params) => {
      if (method === 'Runtime.evaluate') await new Promise(() => {})
      else input.push(params.type)
      return {}
    })
    const pending = f.call('a', 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 20 }, 'dscode-tab-1')
    await vi.advanceTimersByTimeAsync(800)
    expect((await pending).error).toBeUndefined()
    expect(input).toEqual(['mouseMoved'])

    f.chrome.debugger.sendCommand.mockRejectedValueOnce(new Error('Execution context destroyed'))
    expect((await f.call('a', 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 20 }, 'dscode-tab-1')).error).toBeUndefined()
    expect(input).toEqual(['mouseMoved', 'mousePressed'])
  } finally {
    vi.useRealTimers()
  }
})

it('clears the cursor before detaching even when a background renewal is still pending', async () => {
  const f = fixture()
  vi.useFakeTimers()
  try {
    await f.call('a', 'dscode.claimTab', { tabId: 1 })
    const lifecycle: string[] = []
    f.chrome.debugger.sendCommand.mockImplementation(async (_target, _method, params) => {
      if (params.expression.includes('renew()')) {
        lifecycle.push('renew')
        await new Promise(() => {})
      } else lifecycle.push('clear')
      return {}
    })
    f.chrome.debugger.detach.mockImplementation(async () => { lifecycle.push('detach') })
    await vi.advanceTimersByTimeAsync(5000)
    await f.bridge.close('a')
    expect(lifecycle).toEqual(['renew', 'clear', 'detach'])
    expect(f.bridge.owners.size).toBe(0)
    await vi.advanceTimersByTimeAsync(16000)
    expect(lifecycle).toEqual(['renew', 'clear', 'detach'])
  } finally {
    vi.useRealTimers()
  }
})

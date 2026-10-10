import { afterEach, expect, it, vi } from 'vitest'

const { BrowserBridge } = await import(new URL('../../../../../extensions/browser/bridge.js', import.meta.url).href)

const bridges: InstanceType<typeof BrowserBridge>[] = []
afterEach(async () => {
  vi.useRealTimers()
  try {
    await Promise.all(bridges.splice(0).map(bridge => bridge.stop()))
  } finally {
    vi.unstubAllGlobals()
  }
})

function cursorCommand(params: any) {
  return JSON.parse(params.expression.slice(params.expression.lastIndexOf(')(') + 2, -1))
}

const rendered = { result: { value: true } }

function fixture() {
  let onEvent!: (source: any, method: string, params: any) => void
  const detached: number[] = []
  const replies: any[] = []
  const chrome = {
    runtime: { getURL: (path: string) => `chrome-extension://test${path}` },
    debugger: {
      onEvent: { addListener(fn: typeof onEvent) { onEvent = fn } }, onDetach: { addListener() {} },
      attach: vi.fn(async () => {}),
      detach: vi.fn(async ({ tabId }: { tabId: number }) => { detached.push(tabId) }),
      sendCommand: vi.fn(async ({ tabId }: { tabId: number }, method: string, _params: any): Promise<any> => method === 'Runtime.evaluate' ? rendered : { targetInfo: { targetId: `target-${tabId}`, type: 'page' } }),
    },
    tabs: {
      onCreated: { addListener() {} }, onUpdated: { addListener() {} },
      get: vi.fn(async (id: number) => ({ id, windowId: 1, url: 'https://example.com' })),
      create: vi.fn(async () => ({ id: 5 })),
      remove: vi.fn(async (_id: number) => {}),
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
  return { chrome, bridge, call, detached, event: (tabId: number, method: string, params = {}) => onEvent({ tabId }, method, params) }
}

it('recovers the tab indicator after a temporary favicon read failure without a navigation', async () => {
  const f = fixture()
  vi.useFakeTimers()
  f.chrome.tabs.get.mockImplementation(async id => ({ id, windowId: 1, url: 'https://example.com', favIconUrl: 'https://example.com/icon.png' }))
  vi.stubGlobal('fetch', vi.fn()
    .mockRejectedValueOnce(new Error('Chrome favicon cache temporarily unavailable'))
    .mockImplementation(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })))
  const indicators = () => f.chrome.debugger.sendCommand.mock.calls
    .filter(([, method]) => method === 'Runtime.evaluate')
    .map(([, , params]) => cursorCommand(params))
    .filter(command => command.documentUrl)

  await f.call('a', 'dscode.claimTab', { tabId: 1 })
  await vi.advanceTimersByTimeAsync(0)
  expect(indicators()).toEqual([])
  await vi.advanceTimersByTimeAsync(5000)
  expect(indicators()).toContainEqual(expect.objectContaining({
    type: 'sync', documentUrl: 'https://example.com', icon: 'data:image/png;base64,AQID',
  }))
})

it('does not publish an old favicon read after the tab is released and claimed by a new owner', async () => {
  const f = fixture()
  f.chrome.tabs.get.mockImplementation(async id => ({ id, windowId: 1, url: 'https://example.com', favIconUrl: 'https://example.com/icon.png' }))
  const started = Promise.withResolvers<void>()
  const oldRead = Promise.withResolvers<Response>()
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => {
    started.resolve()
    return oldRead.promise
  }).mockImplementation(async () => new Response(new Uint8Array([4, 5, 6]), { headers: { 'content-type': 'image/png' } })))
  const presentation = () => f.chrome.debugger.sendCommand.mock.calls
    .filter(([, method]) => method === 'Runtime.evaluate')
    .map(([, , params]) => cursorCommand(params))
  const indicators = () => presentation().filter(command => command.documentUrl)

  await f.call('a', 'dscode.claimTab', { tabId: 1 })
  await started.promise
  const oldOwner = presentation()[0].owner
  await f.bridge.close('a')
  expect(f.detached).toEqual([1])
  await f.call('b', 'dscode.claimTab', { tabId: 1 })
  await vi.waitFor(() => expect(indicators()).toContainEqual(expect.objectContaining({ icon: 'data:image/png;base64,BAUG' })))
  const newOwner = indicators()[0].owner
  expect(newOwner).not.toBe(oldOwner)

  oldRead.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }))
  await new Promise(resolve => setImmediate(resolve))
  expect(indicators().every(command => command.owner === newOwner && command.icon === 'data:image/png;base64,BAUG')).toBe(true)
  expect(f.bridge.owners.get(1)).toBe('b')
  expect(f.detached).toEqual([1])
})

it('keeps a controlled tab usable when Chrome cannot close it', async () => {
  const f = fixture()
  await f.call('a', 'dscode.claimTab', { tabId: 1 })
  f.chrome.tabs.remove.mockRejectedValueOnce(new Error('Tab cannot be edited right now'))
  expect((await f.call('a', 'Target.closeTarget', { targetId: 'target-1' })).error.message).toContain('cannot be edited')
  const input = { type: 'mouseMoved', x: 30, y: 40 }
  expect((await f.call('a', 'Input.dispatchMouseEvent', input, 'dscode-tab-1')).error).toBeUndefined()
  expect(f.chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Input.dispatchMouseEvent', input)
  expect((await f.call('a', 'Target.closeTarget', { targetId: 'target-1' })).result).toEqual({ success: true })
  expect(f.bridge.owners.has(1)).toBe(false)
})

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
  expect((await f.call('b', 'dscode.claimTab', { tabId: 1 })).error.message).toContain('another control connection')
  await f.call('b', 'dscode.claimTab', { tabId: 2 })
  // A cancelled initialization already detaches. If close starts a second cleanup,
  // hold its page evaluation so a new owner can claim before that stale detach.
  const secondCleanup = Promise.withResolvers<void>()
  const allowCleanup = Promise.withResolvers<void>()
  const sendCommand = f.chrome.debugger.sendCommand.getMockImplementation()!
  let disposals = 0
  f.chrome.debugger.sendCommand.mockImplementation(async (target, method, params) => {
    if (target.tabId === 1 && method === 'Runtime.evaluate' && cursorCommand(params).type === 'dispose' && ++disposals === 2) {
      secondCleanup.resolve()
      await allowCleanup.promise
    }
    return sendCommand(target, method, params)
  })
  const release = f.bridge.close('a')
  attached()
  await first
  await Promise.race([release, secondCleanup.promise])
  expect(f.bridge.owners.has(1)).toBe(false)
  expect(f.bridge.owners.get(2)).toBe('b')
  expect(f.detached).not.toContain(2)
  await f.call('c', 'dscode.claimTab', { tabId: 1 })
  allowCleanup.resolve()
  await release
  expect(f.bridge.owners.get(1)).toBe('c')
  expect(f.detached).toEqual([1])
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
    return rendered
  })
  const events = ['mouseMoved', 'mousePressed', 'mouseReleased'].map(type => ({ type, x: 120, y: 240 }))
  const pending = events.map(params => f.call('a', 'Input.dispatchMouseEvent', params, 'dscode-tab-1'))
  await vi.waitFor(() => expect(f.chrome.debugger.sendCommand).toHaveBeenCalledWith(
    { tabId: 1 }, 'Runtime.evaluate', expect.objectContaining({ expression: expect.stringContaining('"point":{"x":120,"y":240},"type":"move","animate":true') }),
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
  expect((await cancelled).error.message).toBe('Browser control ended')
  expect(input).toEqual(events)
})

it('keeps browser input usable when rendering fails or the page stops scheduling animation', async () => {
  const f = fixture()
  await f.call('a', 'dscode.claimTab', { tabId: 1 })
  vi.useFakeTimers()
  try {
    const input: string[] = []
    f.chrome.debugger.sendCommand.mockImplementation(async (_target, method, params) => {
      if (method === 'Runtime.evaluate' && cursorCommand(params).type === 'move') await new Promise(() => {})
      if (method === 'Input.dispatchMouseEvent') input.push(params.type)
      return rendered
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

it('restores the owned cursor after navigation and brackets failed screenshots without losing its position', async () => {
  const f = fixture()
  const commands: any[] = []
  f.chrome.debugger.sendCommand.mockImplementation(async ({ tabId }, method, params) => {
    if (method === 'Runtime.evaluate') { commands.push(cursorCommand(params)); return rendered }
    if (method === 'Page.captureScreenshot') {
      expect(commands.at(-1)).toMatchObject({ type: 'visibility', hidden: true })
      throw new Error('Screenshot failed')
    }
    return { targetInfo: { targetId: `target-${tabId}`, type: 'page' } }
  })
  await f.call('a', 'dscode.claimTab', { tabId: 1 })
  const owner = commands[0].owner
  await f.call('a', 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 250 }, 'dscode-tab-1')
  f.event(1, 'Page.domContentEventFired')
  await vi.waitFor(() => expect(commands.at(-1)).toMatchObject({ type: 'sync', point: { x: 150, y: 250 }, owner }))
  expect((await f.call('a', 'Page.captureScreenshot', {}, 'dscode-tab-1')).error.message).toBe('Screenshot failed')
  expect(commands.at(-1)).toMatchObject({ type: 'visibility', hidden: false, point: { x: 150, y: 250 }, owner })
  await f.bridge.close('a')
  expect(commands.at(-1).type).toBe('dispose')
  const count = commands.length
  f.event(1, 'Page.domContentEventFired')
  await new Promise(resolve => setImmediate(resolve))
  expect(commands).toHaveLength(count)
})

it('clears the cursor before detaching even when a background renewal is still pending', async () => {
  const f = fixture()
  vi.useFakeTimers()
  try {
    await f.call('a', 'dscode.claimTab', { tabId: 1 })
    const lifecycle: string[] = []
    f.chrome.debugger.sendCommand.mockImplementation(async (_target, _method, params) => {
      if (cursorCommand(params).type === 'sync') {
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

import { expect, it, vi } from 'vitest'

const { BrowserBridge } = await import(new URL('../../../../../extensions/browser/bridge.js', import.meta.url).href)

function fixture() {
  const detached: number[] = []
  const replies: any[] = []
  const chrome = {
    debugger: {
      onEvent: { addListener() {} }, onDetach: { addListener() {} },
      attach: vi.fn(async () => {}),
      detach: vi.fn(async ({ tabId }: { tabId: number }) => { detached.push(tabId) }),
      sendCommand: vi.fn(async ({ tabId }: { tabId: number }) => ({ targetInfo: { targetId: `target-${tabId}`, type: 'page' } })),
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

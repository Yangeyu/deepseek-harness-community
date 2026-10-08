import { describe, expect, it } from 'vitest'
import { CursorRelay, type RpcMessage } from '../../../src/infrastructure/browser/cursor-relay.ts'

function fixture() {
  const chrome: RpcMessage[] = []
  const runtime: RpcMessage[] = []
  const relay = new CursorRelay(message => chrome.push(message), message => runtime.push(message))
  const reply = (request: RpcMessage, result: RpcMessage['result'] = {}) => {
    relay.fromChrome({ jsonrpc: '2.0', id: request.id!, result })
  }
  const call = (id: number, name: string): RpcMessage => ({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { pageId: 1, uid: '1_2' } },
  })
  const tick = () => new Promise<void>(resolve => setImmediate(resolve))
  return { relay, chrome, runtime, reply, call, tick }
}

describe('browser cursor execution', () => {
  it('finishes the target feedback before returning the action and clears it before a screenshot', async () => {
    const f = fixture()
    const click = f.relay.fromRuntime(f.call(1, 'click'))
    expect(f.chrome[0]!.params?.name).toBe('evaluate_script')
    f.reply(f.chrome[0]!)
    await f.tick()
    const content = { content: [{ type: 'text', text: 'Clicked' }], structuredContent: { clicked: true } }
    f.reply(f.chrome[1]!, content)
    await f.tick()
    expect(JSON.stringify(f.chrome[2])).toContain('\\"phase\\":\\"click\\"')
    f.reply(f.chrome[2]!)
    await click
    expect(f.runtime).toEqual([{ jsonrpc: '2.0', id: 1, result: content }])

    const screenshot = f.relay.fromRuntime(f.call(2, 'take_screenshot'))
    expect(JSON.stringify(f.chrome[3])).toContain('\\"phase\\":\\"hide\\"')
    f.reply(f.chrome[3]!)
    await f.tick()
    const image = { content: [{ type: 'image', data: 'image-bytes', mimeType: 'image/png' }] }
    f.reply(f.chrome[4]!, image)
    await screenshot
    expect(f.runtime.at(-1)!.result).toEqual(image)
    f.relay.close()
  })

  it('preserves the real action error when cursor injection fails', async () => {
    const f = fixture()
    const action = f.relay.fromRuntime(f.call(1, 'click'))
    f.reply(f.chrome[0]!, { isError: true, content: [{ type: 'text', text: 'Script unavailable' }] })
    await f.tick()
    const failure = { isError: true, content: [{ type: 'text', text: 'Target detached' }] }
    f.reply(f.chrome[1]!, failure)
    await f.tick()
    expect(JSON.stringify(f.chrome[2])).toContain('\\"phase\\":\\"hide\\"')
    f.reply(f.chrome[2]!)
    await action
    expect(f.runtime.at(-1)!.result).toEqual(failure)
    f.relay.close()
  })

  it('does not dispatch a click cancelled while the visual is being prepared', async () => {
    const f = fixture()
    const action = f.relay.fromRuntime(f.call(1, 'click'))
    const prepare = f.chrome[0]!
    await f.relay.fromRuntime({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })
    await f.tick()
    f.reply(f.chrome.at(-1)!)
    await action
    f.reply(prepare) // Late internal responses must not enter the model's tool stream.
    expect(f.chrome.some(message => message.params?.name === 'click')).toBe(false)
    expect(f.runtime).toEqual([{ jsonrpc: '2.0', id: 1, error: { code: -32800, message: 'Browser action cancelled' } }])
    f.relay.close()
  })
})

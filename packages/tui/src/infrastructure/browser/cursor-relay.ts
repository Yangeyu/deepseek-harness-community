import { randomUUID } from 'node:crypto'
import { cursorScript, type CursorCommand } from './page-cursor.ts'

type RequestId = string | number
export interface RpcMessage {
  jsonrpc: '2.0'
  id?: RequestId
  method?: string
  params?: Record<string, unknown>
  result?: { isError?: boolean; [key: string]: unknown }
  error?: { code: number; message: string; [key: string]: unknown }
}

/** Add visual feedback inside one runtime-owned call; all other MCP traffic passes through. */
export class CursorRelay {
  private readonly prefix = `dsh-cursor:${randomUUID()}:`
  private sequence = 0
  private readonly pending = new Map<RequestId, { resolve(message: RpcMessage): void; reject(error: Error): void }>()
  private readonly actions = new Map<RequestId, AbortController>()
  private closed = false

  constructor(
    private readonly toChrome: (message: RpcMessage) => void,
    private readonly toRuntime: (message: RpcMessage) => void,
  ) {}

  fromChrome(message: RpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id)
      if (pending) return pending.resolve(message)
      // A timed-out visual request can finish late; it is never a model tool result.
      if (typeof message.id === 'string' && message.id.startsWith(this.prefix)) return
    }
    this.toRuntime(message)
  }

  async fromRuntime(message: RpcMessage): Promise<void> {
    if (message.method === 'notifications/cancelled') {
      this.actions.get(message.params?.requestId as RequestId)?.abort()
      this.toChrome(message)
      return
    }
    const name = message.params?.name
    const args = message.params?.arguments as Record<string, unknown> | undefined
    const pointer = (name === 'click' || name === 'hover') && typeof args?.uid === 'string'
    if (message.method !== 'tools/call' || message.id === undefined
      || typeof args?.pageId !== 'number' || (!pointer && name !== 'take_screenshot')) {
      this.toChrome(message)
      return
    }

    const controller = new AbortController()
    this.actions.set(message.id, controller)
    const token = `${this.prefix}${++this.sequence}`
    const pageId = args.pageId
    try {
      await this.visual(pageId, pointer
        ? { phase: 'show', token, expiresAt: Date.now() + 1000 }
        : { phase: 'hide' }, controller.signal, pointer ? args.uid as string : undefined)
      controller.signal.throwIfAborted()
      const result = await this.request(message, controller.signal)
      if (pointer) {
        await this.visual(pageId, {
          phase: result.error || result.result?.isError ? 'hide' : name === 'click' ? 'click' : 'finish',
          token,
        }, controller.signal)
      }
      controller.signal.throwIfAborted()
      this.toRuntime(result)
    } catch (error) {
      if (!controller.signal.aborted) throw error
      if (!this.closed) {
        await this.visual(pageId, { phase: 'hide', token }, AbortSignal.timeout(1000))
        this.toRuntime({ jsonrpc: '2.0', id: message.id, error: { code: -32800, message: 'Browser action cancelled' } })
      }
    } finally {
      this.actions.delete(message.id)
    }
  }

  close(): void {
    this.closed = true
    for (const controller of this.actions.values()) controller.abort()
    for (const pending of this.pending.values()) pending.reject(new Error('Browser connection closed'))
  }

  private async visual(pageId: number, command: CursorCommand, signal: AbortSignal, uid?: string): Promise<void> {
    if (this.closed || signal.aborted) return
    try {
      await this.request({
        jsonrpc: '2.0', id: `${this.prefix}${++this.sequence}`, method: 'tools/call',
        params: {
          name: 'evaluate_script',
          arguments: { pageId, function: cursorScript(command), args: uid ? [uid] : [], waitForStableDom: false },
        },
      }, AbortSignal.any([signal, AbortSignal.timeout(1000)]))
    } catch {
      // Visual feedback is optional. A failed injection must not replace the action's result.
    }
  }

  private request(message: RpcMessage, signal: AbortSignal): Promise<RpcMessage> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const id = message.id!
      const finish = () => {
        this.pending.delete(id)
        signal.removeEventListener('abort', abort)
      }
      const abort = () => {
        finish()
        if (!this.closed) this.toChrome({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } })
        reject(signal.reason)
      }
      this.pending.set(id, {
        resolve: result => { finish(); resolve(result) },
        reject: error => { finish(); reject(error) },
      })
      signal.addEventListener('abort', abort, { once: true })
      this.toChrome(message)
    })
  }
}

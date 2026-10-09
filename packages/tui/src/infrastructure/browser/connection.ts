import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import type { ConnectOverCDPTransport } from 'playwright'
import { readMessages, writeMessage } from './native-protocol.ts'

export class BrowserConnection implements ConnectOverCDPTransport {
  onmessage?: (message: object) => void
  onclose?: (reason?: string) => void
  private sequence = 0
  private readonly pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>()

  private constructor(private readonly socket: Socket) {
    readMessages(socket, message => {
      const pending = this.pending.get(message.id)
      if (!pending) { this.onmessage?.(message); return }
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    socket.on('error', () => {})
    socket.once('close', () => {
      for (const call of this.pending.values()) call.reject(new Error('Browser extension disconnected'))
      this.pending.clear()
      this.onclose?.('Browser extension disconnected')
    })
  }

  static async connect(home = process.env.DSH_HOME || join(homedir(), '.dsh')): Promise<BrowserConnection> {
    const directory = join(home, 'browser', 'connections')
    const paths = (await readdir(directory).catch(() => [] as string[])).filter(name => name.endsWith('.sock'))
    const sockets = (await Promise.all(paths.map(name => new Promise<Socket | undefined>(resolve => {
      const socket = createConnection(join(directory, name))
      socket.once('connect', () => { socket.setTimeout(0); resolve(socket) })
      socket.once('error', () => { socket.destroy(); resolve(undefined) })
      socket.setTimeout(1000, () => { socket.destroy(); resolve(undefined) })
    })))).filter((socket): socket is Socket => !!socket)
    if (sockets.length !== 1) {
      for (const socket of sockets) socket.destroy()
      throw new Error(sockets.length ? 'Enable dscode Browser in only one Chrome profile.' : 'dscode Browser is not connected. Run dscode browser install, then load the extension in Chrome.')
    }
    return new BrowserConnection(sockets[0]!)
  }

  send(message: object): void { writeMessage(this.socket, message) }
  close(): void { this.socket.destroy() }

  request(method: string, params: object = {}): Promise<any> {
    const id = `dscode-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Browser extension timed out: ${method}`))
      }, 5000)
      this.pending.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value) },
        reject(error) { clearTimeout(timer); reject(error) },
      })
      this.send({ id, method, params })
    })
  }
}

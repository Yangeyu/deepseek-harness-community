import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { readMessages, writeMessage } from './native-protocol.ts'

// Chrome owns this process. It routes independent clients, never owns page state.
const directory = join(process.argv[2]!, 'browser', 'connections')
await mkdir(directory, { recursive: true, mode: 0o700 })
await chmod(directory, 0o700)
const path = join(directory, `${process.pid}.sock`)
const clients = new Map<string, Socket>()
const server = createServer(socket => {
  const client = randomUUID()
  clients.set(client, socket)
  readMessages(socket, message => {
    const envelope = { client, message }
    if (Buffer.byteLength(JSON.stringify(envelope)) > 1024 * 1024) {
      writeMessage(socket, { id: message.id, error: { message: 'Browser request exceeds Native Messaging 1 MiB limit' } })
    } else writeMessage(process.stdout, envelope)
  })
  socket.on('error', () => {})
  socket.once('close', () => {
    clients.delete(client)
    writeMessage(process.stdout, { client, close: true })
  })
})
readMessages(process.stdin, ({ client, message, close }) => {
  const socket = clients.get(client)
  if (close) socket?.destroy()
  else if (socket) writeMessage(socket, message)
})
let stopping = false
async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  for (const socket of clients.values()) socket.destroy()
  server.close()
  await rm(path, { force: true })
  process.exit(0)
}
process.stdin.on('end', () => void stop())
process.stdin.on('error', () => void stop())
process.stdout.on('error', () => void stop())
process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())
server.listen(path, () => void chmod(path, 0o600))

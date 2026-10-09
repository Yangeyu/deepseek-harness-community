import type { Readable, Writable } from 'node:stream'

/** Chrome Native Messaging framing, also used on the private local socket. */
export function readMessages(stream: Readable, receive: (message: any) => void): void {
  let buffer = Buffer.alloc(0)
  stream.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0)
      if (size > 64 * 1024 * 1024) { stream.destroy(new Error('Browser message exceeds 64 MiB')); return }
      if (buffer.length < size + 4) return
      const body = buffer.subarray(4, size + 4)
      buffer = buffer.subarray(size + 4)
      try { receive(JSON.parse(body.toString('utf8'))) }
      catch { stream.destroy(new Error('Invalid browser message')); return }
    }
  })
}

export function writeMessage(stream: Writable, message: object): void {
  const body = Buffer.from(JSON.stringify(message))
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  stream.write(Buffer.concat([header, body]))
}

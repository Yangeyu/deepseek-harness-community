import { createInterface } from 'node:readline'
import { writeFile } from 'node:fs/promises'

// Stateful stdio peer: connection identity and selected page belong to this process.
let page = 'blank'
const pending = new Map()
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (request.method === 'notifications/cancelled') {
    clearTimeout(pending.get(request.params.requestId))
    pending.delete(request.params.requestId)
  }
  if (request.id === undefined) continue
  if (request.method === 'initialize') {
    reply(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'session-fixture', version: '1' },
    })
  } else if (request.method === 'tools/list') {
    reply(request.id, { tools: [{
      name: 'page', description: 'Select or inspect this connection page',
      inputSchema: { type: 'object', properties: { page: { type: 'string' }, started: { type: 'string' } } },
    }] })
  } else if (request.method === 'tools/call') {
    const args = request.params.arguments
    if (args.page !== undefined) page = args.page
    const finish = () => {
      pending.delete(request.id)
      reply(request.id, { content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, page }) }] })
    }
    if (args.started) {
      pending.set(request.id, setTimeout(finish, 10000))
      await writeFile(args.started, '')
    }
    else finish()
  } else reply(request.id, {})
}
for (const timer of pending.values()) clearTimeout(timer)

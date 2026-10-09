import { createConnection } from '@playwright/mcp'
import { chromium, type BrowserContext } from 'playwright'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { BrowserConnection } from './connection.ts'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

/** Keep upstream tool schemas/actions; add only extension tab discovery and ownership. */
export async function createBrowserServer(connect = () => BrowserConnection.connect()): Promise<Server> {
  let connection: BrowserConnection | undefined
  let context: BrowserContext | undefined
  let stopped = false
  let generation = 0
  async function getContext(): Promise<BrowserContext> {
    if (stopped) throw new Error('Browser control was stopped. Start a new task to use the browser again.')
    if (context) return context
    const startingGeneration = generation
    const current = connection ?? await connect()
    if (generation !== startingGeneration) { current.close(); throw new Error('Browser task ended') }
    connection = current
    try {
      const browser = await chromium.connectOverCDP(current, { timeout: 10000, noDefaults: true })
      if (generation !== startingGeneration) { current.close(); throw new Error('Browser task ended') }
      context = browser.contexts()[0]!
      const attached = connection
      browser.once('disconnected', () => {
        if (connection === attached) { context = undefined; connection = undefined; stopped = true }
      })
      return context
    } catch (error) {
      current.close()
      if (connection === current) connection = undefined
      throw error
    }
  }
  async function release(): Promise<void> {
    generation++
    stopped = false
    const current = connection
    connection = undefined
    context = undefined
    if (!current) return
    try { await current.request('dscode.release') }
    finally { current.close() }
  }
  const upstream = await createConnection({
    browser: { contextOptions: { viewport: null } },
    outputDir: join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'browser', 'artifacts', randomUUID()),
  }, getContext)
  const client = new Client({ name: 'dscode-browser', version: '1.0.0' })
  const [local, remote] = InMemoryTransport.createLinkedPair()
  await upstream.connect(remote)
  await client.connect(local)
  const server = new Server({ name: 'dscode-browser', version: '1.0.0' }, { capabilities: { tools: {} } })
  const extra = [
    { name: 'browser_list_user_tabs', description: 'List existing Chrome tabs without claiming or focusing them. Use browser_claim_tab to work with an existing signed-in tab.', inputSchema: { type: 'object' as const, properties: {} } },
    ...[
      ['browser_claim_tab', 'Claim an existing Chrome tab for this task without focusing it. Then use browser_tabs to select it. Another task cannot claim the same tab.'],
      ['browser_focus_tab', 'Explicitly show an owned tab and focus Chrome. Use only when the user asks to see the page. Ordinary browser actions work in the background.'],
    ].map(([name, description]) => ({ name: name!, description, inputSchema: { type: 'object' as const, properties: { tabId: { type: 'integer' } }, required: ['tabId'] } })),
  ]
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...(await client.listTools()).tools, ...extra] }))
  server.setRequestHandler(CallToolRequestSchema, async (request, run) => {
    const { name, arguments: args = {} } = request.params
    let cancellation: Promise<void> | undefined
    const abort = () => { cancellation ??= release(); void cancellation.catch(() => {}) }
    run.signal.addEventListener('abort', abort, { once: true })
    try {
      run.signal.throwIfAborted()
      if (name === 'browser_close' && stopped) {
        // The upstream backend is already disconnected. Closing remains idempotent.
        return { content: [{ type: 'text', text: 'Browser control released.' }] }
      }
      if (extra.some(tool => tool.name === name)) {
        if (name !== 'browser_list_user_tabs' && (!Number.isSafeInteger(args.tabId) || Number(args.tabId) <= 0)) throw new Error('tabId must be a positive integer')
        await getContext()
        const method = name === 'browser_list_user_tabs' ? 'listTabs' : name === 'browser_claim_tab' ? 'claimTab' : 'focusTab'
        const result = await connection!.request(`dscode.${method}`, args)
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      }
      const result = await client.callTool(request.params, undefined, { signal: run.signal })
      if (stopped && name !== 'browser_close') throw new Error('Browser control was stopped. Start a new task to use the browser again.')
      return result
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
    } finally {
      run.signal.removeEventListener('abort', abort)
      if (cancellation) await cancellation
      else if (name === 'browser_close' || run.signal.aborted) await release()
    }
  })
  server.onclose = () => { void release().finally(() => client.close()) }
  return server
}

export async function runBrowserMcp(): Promise<void> {
  const server = await createBrowserServer()
  await server.connect(new StdioServerTransport())
}

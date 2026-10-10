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
  const stoppedMessage = 'Browser control was stopped. Do not reconnect automatically. If the user asks to resume control, call browser_close to reset, then claim an existing tab or explicitly create a new one.'
  const noTabMessage = 'No tab is controlled. Use browser_list_user_tabs and browser_claim_tab to reuse an existing tab, or browser_tabs action new when a new tab is needed.'
  const noTabs = { content: [{ type: 'text' as const, text: noTabMessage }] }
  async function getContext(): Promise<BrowserContext> {
    if (stopped) throw new Error(stoppedMessage)
    if (context) return context
    const startingGeneration = generation
    const current = connection ?? await connect()
    if (generation !== startingGeneration) { current.close(); throw new Error('Browser control ended') }
    connection = current
    try {
      const browser = await chromium.connectOverCDP(current, { timeout: 10000, noDefaults: true })
      if (generation !== startingGeneration) { current.close(); throw new Error('Browser control ended') }
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
  async function claimTab(current: BrowserContext, tabId: number, signal: AbortSignal): Promise<{ targetId: string }> {
    let arrived!: () => void
    let aborted!: () => void
    let timer: ReturnType<typeof setTimeout> | undefined
    const pageReady = new Promise<void>(resolve => { arrived = resolve })
    current.on('page', arrived)
    try {
      const tabs = await connection!.request('dscode.listTabs') as { tabId: number; claimed: boolean }[]
      const claimed = tabs.find(tab => tab.tabId === tabId)?.claimed
      const result = await connection!.request('dscode.claimTab', { tabId })
      signal.throwIfAborted()
      if (!claimed) {
        // Chrome attachment precedes Playwright's public page event. Admit the
        // next tool only after its page is registered, without a timing guess.
        const deadline = new Promise<never>((_, reject) => {
          aborted = () => reject(signal.reason)
          signal.addEventListener('abort', aborted, { once: true })
          timer = setTimeout(() => reject(new Error('Claimed browser page did not become ready')), 10000)
        })
        await Promise.race([pageReady, deadline])
      }
      // The MCP backend lazily builds its own tab list from the public context.
      // Listing an already registered page initializes it without opening a tab.
      const indexed = await client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }, undefined, { signal })
      if (indexed.isError) throw new Error('Playwright could not register the claimed browser tab')
      return { targetId: result.targetId }
    } finally {
      current.off('page', arrived)
      if (aborted) signal.removeEventListener('abort', aborted)
      clearTimeout(timer)
    }
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
    { name: 'browser_list_user_tabs', description: 'Discover existing Chrome tabs without claiming or focusing them. Reuse a relevant existing tab with browser_claim_tab before considering a new tab.', inputSchema: { type: 'object' as const, properties: {} } },
    ...[
      ['browser_claim_tab', 'Claim an existing Chrome tab for this session without focusing it. Then use browser_tabs to select it. Another control connection cannot claim the same tab.'],
      ['browser_focus_tab', 'Explicitly show an owned tab and focus Chrome. Use only when the user asks to see the page. Ordinary browser actions work in the background.'],
    ].map(([name, description]) => ({ name: name!, description, inputSchema: { type: 'object' as const, properties: { tabId: { type: 'integer' } }, required: ['tabId'] } })),
  ]
  const descriptions: Record<string, string> = {
    browser_close: 'Disconnect browser control for this session and clear AI cursors and restore tab icons without closing user tabs. Control persists across turns; use this when the user wants to disconnect.',
    browser_navigate: 'Navigate the currently claimed tab. Reuse it across turns. With no claimed tab, discover and claim an existing relevant user tab first; explicitly create a new tab only when needed.',
    browser_tabs: 'List, select, close, or explicitly create a controlled tab. Reuse existing tabs across turns and reclaim them after disconnecting. Use action new only when a new tab is needed. Selecting a tab does not bring it to the foreground.',
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...(await client.listTools()).tools.map(tool => ({ ...tool, description: descriptions[tool.name] ?? tool.description })),
      ...extra,
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request, run) => {
    const { name, arguments: args = {} } = request.params
    let cancellation: Promise<void> | undefined
    const abort = () => { cancellation ??= release(); void cancellation.catch(() => {}) }
    run.signal.addEventListener('abort', abort, { once: true })
    try {
      run.signal.throwIfAborted()
      if (name === 'browser_close' && stopped) {
        // The upstream backend is already disconnected. Closing remains idempotent.
        return noTabs
      }
      if (extra.some(tool => tool.name === name)) {
        if (name !== 'browser_list_user_tabs' && (!Number.isSafeInteger(args.tabId) || Number(args.tabId) <= 0)) throw new Error('tabId must be a positive integer')
        const current = await getContext()
        const result = name === 'browser_claim_tab'
          ? await claimTab(current, Number(args.tabId), run.signal)
          : await connection!.request(name === 'browser_list_user_tabs' ? 'dscode.listTabs' : 'dscode.focusTab', args)
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      }
      const creatingTab = name === 'browser_tabs' && args.action === 'new'
      if (name !== 'browser_close' && !creatingTab && !(await getContext()).pages().length) throw new Error(noTabMessage)
      const result = await client.callTool(request.params, undefined, { signal: run.signal })
      if (stopped && name !== 'browser_close') throw new Error(stoppedMessage)
      if (!result.isError && (name === 'browser_close' || !context?.pages().length)) return noTabs
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

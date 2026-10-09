// Real extension + Native Messaging + MCP in disposable, headless Chrome for Testing.
// Requires: pnpm build && pnpm exec playwright install chromium
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

if (process.platform !== 'darwin') throw new Error('This isolated native-host smoke currently targets macOS Chrome for Testing.')
const directory = await mkdtemp(join(tmpdir(), 'dscode-background-'))
const bundle = resolve(process.argv[2] || 'packages/tui/dist')
const extension = join(directory, 'extension')
const nativeName = `com.dscode.smoke_${process.pid}`
const nativeManifests = [join(directory, 'profile', 'NativeMessagingHosts', `${nativeName}.json`)]
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html')
  response.end(request.url === '/b' ? '<p>session B</p>' : `<button onclick="this.textContent='clicked'">click me</button>`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`
const clients = []
let context
const waitFor = async predicate => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for browser lifecycle')
}
async function client() {
  const instance = new Client({ name: 'background-smoke', version: '1' })
  await instance.connect(new StdioClientTransport({ command: process.execPath, args: [join(bundle, 'browser-mcp.js')], env: { ...process.env, DSH_HOME: directory }, stderr: 'inherit' }))
  clients.push(instance)
  return instance
}
const call = (client, name, args = {}) => client.callTool({ name: `browser_${name}`, arguments: args })
const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
async function ok(client, name, args) {
  const result = await call(client, name, args)
  assert.ok(!result.isError, text(result))
  return text(result)
}
try {
  await cp(join(bundle, 'browser-extension'), extension, { recursive: true })
  const background = join(extension, 'background.js')
  await writeFile(background, (await readFile(background, 'utf8')).replace('com.dscode.browser', nativeName) + '\nglobalThis.stopDscodeTest = () => bridge.stop()\n')
  const host = join(directory, 'native-host')
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  await writeFile(host, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(bundle, 'browser-native-host.js'))} ${quote(directory)} "$@"\n`)
  await chmod(host, 0o700)
  for (const path of nativeManifests) {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, JSON.stringify({ name: nativeName, description: 'Isolated dscode test', path: host, type: 'stdio', allowed_origins: ['chrome-extension://mnbkfhlhmgefehfiddpodldlbiemdfba/'] }))
  }
  context = await chromium.launchPersistentContext(join(directory, 'profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
  try {
    await waitFor(async () => (await readdir(join(directory, 'browser/connections')).catch(() => [])).length > 0)
  } catch {
    const error = await worker.evaluate(name => new Promise(resolve => {
      const port = chrome.runtime.connectNative(name)
      port.onDisconnect.addListener(() => resolve(chrome.runtime.lastError?.message || 'disconnected'))
      setTimeout(() => { port.disconnect(); resolve('Native host connected but no socket') }, 1000)
    }), nativeName)
    throw new Error(String(error))
  }
  const activeTabs = () => worker.evaluate(async () => (await chrome.tabs.query({ active: true })).map(tab => tab.id))
  const originalActive = await activeTabs()
  const attached = tabId => worker.evaluate(async id => {
    try { await chrome.debugger.sendCommand({ tabId: id }, 'Runtime.evaluate', { expression: '0' }); return true }
    catch { return false }
  }, tabId)
  const a = await client()
  const b = await client()
  const initialTabs = await worker.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id))
  await ok(a, 'list_user_tabs')
  assert.deepEqual(await worker.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id)), initialTabs)
  await ok(a, 'navigate', { url: `${url}/a` })
  await ok(a, 'click', { target: 'button' })
  assert.match(await ok(a, 'snapshot'), /clicked/)
  await ok(a, 'tabs', { action: 'select', index: 0 })
  const screenshot = await a.callTool({ name: 'browser_take_screenshot', arguments: { type: 'png' } })
  assert.ok(!screenshot.isError, text(screenshot))
  assert.ok(screenshot.content.some(block => block.type === 'image'))
  assert.deepEqual(await activeTabs(), originalActive, 'agent actions must preserve the active tab')
  console.log('PASS packaged extension + native host + MCP: navigation, click, screenshot and selection preserve active tab')
  const userTabId = await worker.evaluate(async () => (await chrome.tabs.create({ active: false, url: 'about:blank' })).id)
  await ok(a, 'claim_tab', { tabId: userTabId })
  assert.equal((await call(b, 'claim_tab', { tabId: userTabId })).isError, true)
  await ok(b, 'navigate', { url: `${url}/b` })
  await ok(a, 'close')
  assert.equal(await attached(userTabId), false)
  assert.match(await ok(b, 'snapshot'), /session B/)
  await ok(a, 'claim_tab', { tabId: userTabId })
  await ok(a, 'snapshot')
  await worker.evaluate(() => globalThis.stopDscodeTest())
  // The native disconnect notification crosses another process before reaching MCP.
  await waitFor(async () => /stopped/.test(text(await call(a, 'snapshot'))))
  assert.equal(await attached(userTabId), false)
  await ok(a, 'close')
  await ok(b, 'close')
  await ok(b, 'navigate', { url: `${url}/b` })
  await ok(a, 'claim_tab', { tabId: userTabId })
  const controller = new AbortController()
  const waiting = a.callTool({ name: 'browser_wait_for', arguments: { time: 30 } }, undefined, { signal: controller.signal }).catch(() => {})
  const timer = setTimeout(() => controller.abort(), 100)
  await waiting
  clearTimeout(timer)
  await waitFor(async () => !await attached(userTabId))
  assert.match(await ok(b, 'snapshot'), /session B/)
  await ok(b, 'close')
  assert.deepEqual(await activeTabs(), originalActive)
  console.log('PASS concurrent sessions, exclusive claims, detach on finish/cancel, preserved user tabs, reconnect and manual stop')
} finally {
  await Promise.all(clients.map(client => client.close()))
  await context?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await Promise.all(nativeManifests.map(path => rm(path, { force: true })))
  await rm(directory, { recursive: true, force: true })
}

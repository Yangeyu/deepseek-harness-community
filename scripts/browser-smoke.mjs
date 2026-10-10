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
  if (request.url.startsWith('/badge-icon.svg')) {
    response.setHeader('content-type', 'image/svg+xml')
    response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="${request.url.includes('second') ? '#c05030' : '#28a745'}"/></svg>`)
    return
  }
  if (request.url.startsWith('/badge')) {
    response.setHeader('content-security-policy', `default-src 'none'; img-src 'self'${request.url === '/badge-strict' ? '' : ' data:'}; require-trusted-types-for 'script'`)
    response.end('<title>Favicon lease</title><link id="site-icon" rel="icon" sizes="32x32" type="image/svg+xml" href="/badge-icon.svg?first"><p>Controlled favicon</p>')
    return
  }
  if (request.url === '/cursor') {
    response.setHeader('content-security-policy', "default-src 'none'; style-src 'nonce-dscode'; script-src 'nonce-dscode'; require-trusted-types-for 'script'")
    response.end(`<style nonce="dscode">body{margin:0;height:2200px}button{position:absolute;width:80px;height:40px}
      #near{left:calc(58vw + 60px);top:55vh}#far{left:20px;top:50px}#below{left:300px;top:1800px}
      dialog{width:200px;height:120px}#modal{left:20px;top:20px}</style>
      <button id="near">near</button><button id="far">far</button><button id="below">below</button>
      <dialog id="dialog"><button id="modal" autofocus>modal</button></dialog>
      <script nonce="dscode">
        window.trace=[];window.clicks=[];
        window.cursorPoint=()=>{const host=document.querySelector('[data-dsh-ai-cursor]');if(!host)return null;
          const m=new DOMMatrix(host.style.transform);return {x:m.m41,y:m.m42}};
        document.addEventListener('click',e=>clicks.push({id:e.target.id,x:e.clientX,y:e.clientY,cursor:cursorPoint()}));
        function sample(){const p=cursorPoint();if(p)trace.push(p);requestAnimationFrame(sample)}requestAnimationFrame(sample);
      </script>`)
    return
  }
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
  const unclaimed = await call(a, 'navigate', { url: `${url}/a` })
  assert.ok(unclaimed.isError && /browser_claim_tab/.test(text(unclaimed)))
  assert.deepEqual(await worker.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id)), initialTabs, 'ordinary tools must not create an unrequested tab')
  await ok(a, 'tabs', { action: 'new', url: `${url}/a` })
  await ok(a, 'click', { target: 'button' })
  assert.match(await ok(a, 'snapshot'), /clicked/)
  await ok(a, 'tabs', { action: 'select', index: 0 })
  const screenshot = await a.callTool({ name: 'browser_take_screenshot', arguments: { type: 'png' } })
  assert.ok(!screenshot.isError, text(screenshot))
  assert.ok(screenshot.content.some(block => block.type === 'image'))
  assert.deepEqual(await activeTabs(), originalActive, 'agent actions must preserve the active tab')
  console.log('PASS packaged extension + native host + MCP: navigation, click, screenshot and selection preserve active tab')
  const userPageReady = context.waitForEvent('page')
  const userTabId = await worker.evaluate(async () => (await chrome.tabs.create({ active: false, url: 'about:blank' })).id)
  const userPage = await userPageReady
  await ok(b, 'tabs', { action: 'new', url: `${url}/b` })
  const bTabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, `${url}/b`)
  // The observer's Playwright launch also emulates focus. Clear that default so
  // this test measures the extension's lease and Chrome's actual detached state.
  const focusObserver = await context.newCDPSession(userPage)
  await focusObserver.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  const realFocus = await userPage.evaluate(() => ({ focused: document.hasFocus(), hidden: document.hidden }))
  await ok(a, 'claim_tab', { tabId: userTabId })
  assert.deepEqual(await userPage.evaluate(() => ({ focused: document.hasFocus(), hidden: document.hidden })), { focused: true, hidden: false }, 'claimed pages run background actionability checks')
  assert.equal((await call(b, 'claim_tab', { tabId: userTabId })).isError, true)
  const leasedTabs = await worker.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id))
  await ok(a, 'close')
  assert.equal(await attached(userTabId), false)
  assert.deepEqual(await userPage.evaluate(() => ({ focused: document.hasFocus(), hidden: document.hidden })), realFocus, 'disconnect restores actual page focus and visibility')
  await focusObserver.detach()
  assert.match(await ok(b, 'snapshot'), /session B/)
  await ok(a, 'claim_tab', { tabId: userTabId })
  assert.match(await ok(a, 'tabs', { action: 'select', index: 0 }), /about:blank/, 'claimed pages are selectable before the next tool')
  await worker.evaluate(() => globalThis.stopDscodeTest())
  // The native disconnect notification crosses another process before reaching MCP.
  await waitFor(async () => /stopped/.test(text(await call(a, 'snapshot'))))
  assert.equal(await attached(userTabId), false)
  await ok(a, 'close')
  await ok(b, 'close')
  await ok(b, 'claim_tab', { tabId: bTabId })
  assert.match(await ok(b, 'snapshot'), /session B/)
  assert.deepEqual(await worker.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id)), leasedTabs, 'reclaim reuses original tabs without duplicates')
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
  console.log('PASS concurrent sessions, exclusive claims, detach on close/cancel, preserved user tabs, reconnect and manual stop')

  // Use the production extension's injection, not a test-created overlay.
  // Observe actual rendering on a visible tab in this isolated headless browser.
  await ok(a, 'claim_tab', { tabId: userTabId })
  await ok(a, 'navigate', { url: `${url}/cursor` })
  const page = context.pages().find(page => page.url() === `${url}/cursor`)
  assert.ok(page)
  await page.bringToFront()
  assert.equal(await page.evaluate(() => document.hidden), false)
  await page.locator('[data-dsh-ai-cursor]').waitFor({ state: 'attached' })
  const inspector = await context.newCDPSession(page)
  async function arrowHotspot() {
    // CDP pierces the closed shadow root; verify the rendered asset, not just
    // the logical translate stored on the host (which missed the old offset).
    const { root } = await inspector.send('DOM.getDocument', { depth: -1, pierce: true })
    const visit = (node, predicate) => predicate(node) ? node : [...(node.children ?? []), ...(node.shadowRoots ?? [])]
      .map(child => visit(child, predicate)).find(Boolean)
    const host = visit(root, node => node.attributes?.includes('data-dsh-ai-cursor'))
    const arrow = visit(host, node => node.nodeName.toUpperCase() === 'CANVAS')
    const { model } = await inspector.send('DOM.getBoxModel', { backendNodeId: arrow.backendNodeId })
    assert.equal(model.width, 23, 'strict CSP must not suppress cursor styling')
    assert.equal(model.height, 24)
    const q = model.content
    return {
      x: q[0] + (q[2] - q[0]) * 4 / 23 + (q[6] - q[0]) * 3 / 24,
      y: q[1] + (q[3] - q[1]) * 4 / 23 + (q[7] - q[1]) * 3 / 24,
    }
  }
  async function clickWithTrace(target) {
    const start = await page.evaluate(() => { window.trace = []; return window.cursorPoint() })
    await ok(a, 'click', { target })
    const { trace, click } = await page.evaluate(() => ({ trace: window.trace, click: window.clicks.at(-1) }))
    assert.ok(Math.hypot(click.x - click.cursor.x, click.y - click.cursor.y) < 1, 'cursor must arrive at the actual click point before input')
    const tip = await arrowHotspot()
    assert.ok(Math.hypot(tip.x - click.x, tip.y - click.y) < 1, `rendered arrow hotspot must match input: ${JSON.stringify({ tip, click })}`)
    return { start, trace, click }
  }
  const short = await clickWithTrace('#near')
  assert.ok(short.trace.some(p => Math.hypot(p.x - short.start.x, p.y - short.start.y) > 2 && Math.hypot(p.x - short.click.x, p.y - short.click.y) > 2), 'short motion must render intermediate positions')
  const long = await clickWithTrace('#far')
  const dx = long.click.x - long.start.x
  const dy = long.click.y - long.start.y
  assert.ok(long.trace.some(p => Math.abs(dx * (p.y - long.start.y) - dy * (p.x - long.start.x)) / Math.hypot(dx, dy) > 5), 'long motion must follow an arc')
  await clickWithTrace('#below')
  assert.ok(await page.evaluate(() => scrollY > 0), 'offscreen action should scroll before the cursor moves to its click point')
  await page.evaluate(() => {
    document.documentElement.style.transform = 'translate(50px,30px)'
    scrollTo(0, 0)
  })
  await clickWithTrace('#far')
  await page.evaluate(() => document.querySelector('#dialog').showModal())
  await clickWithTrace('#modal')
  // This fixture is grayscale except for the pointer's blue glow. Inspect pixels
  // rather than comparing screenshots from clients with different viewport caches.
  const bluePixels = data => page.evaluate(async data => {
    const image = await createImageBitmap(new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(image.width, image.height)
    const drawing = canvas.getContext('2d')
    drawing.drawImage(image, 0, 0)
    const pixels = drawing.getImageData(0, 0, image.width, image.height).data
    image.close()
    let blue = 0
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 2] > pixels[i] + 30 && pixels[i + 2] > pixels[i + 1] + 15) blue++
    return blue
  }, data)
  assert.ok(await bluePixels((await page.screenshot()).toString('base64')) > 10, 'the cursor must paint above the modal')
  const cleanShot = await call(a, 'take_screenshot', { type: 'png' })
  assert.ok(!cleanShot.isError, text(cleanShot))
  assert.equal(await bluePixels(cleanShot.content.find(block => block.type === 'image').data), 0, 'MCP screenshots exclude the cursor')
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-dsh-ai-cursor]')).visibility), 'visible', 'screenshots restore the cursor')
  assert.equal(await page.evaluate(() => document.activeElement.id), 'modal', 'the cursor must not steal modal focus')
  assert.equal(await page.evaluate(() => document.querySelector('[data-dsh-ai-cursor]').matches(':popover-open')), true)
  await page.evaluate(() => {
    document.querySelector('#dialog').close()
    document.documentElement.style.transform = ''
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const began = Date.now()
  await page.evaluate(() => document.querySelector('[data-dsh-ai-cursor]').cursor.move(100, 100))
  assert.ok(Date.now() - began < 300, 'reduced motion should not wait for animation')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  // Headless Chrome reports these tabs as visible; simulate only the visibility signal.
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }))
  assert.deepEqual(await page.evaluate(async () => {
    const moving = document.querySelector('[data-dsh-ai-cursor]').cursor.move(200, 200)
    const point = window.cursorPoint()
    await moving
    return point
  }), { x: 200, y: 200 }, 'hidden pages should update immediately without waiting for frames')
  await page.evaluate(() => { delete document.hidden })
  const retargeted = await page.evaluate(async () => {
    const cursor = document.querySelector('[data-dsh-ai-cursor]').cursor
    const first = cursor.move(600, 300)
    await new Promise(resolve => setTimeout(resolve, 50))
    const before = window.cursorPoint()
    const second = cursor.move(100, 400)
    const after = window.cursorPoint()
    await Promise.all([first, second])
    return { before, after, end: window.cursorPoint() }
  })
  assert.deepEqual(retargeted.before, retargeted.after, 'retargeting should continue from the currently rendered position')
  assert.deepEqual(retargeted.end, { x: 100, y: 400 })
  // Disposing while moving settles the visual and leaves no orphan overlay.
  await page.evaluate(() => {
    const cursor = document.querySelector('[data-dsh-ai-cursor]').cursor
    const moving = cursor.move(600, 300)
    cursor.dispose()
    return moving
  })
  assert.equal(await page.locator('[data-dsh-ai-cursor]').count(), 0)
  const lastClick = await page.evaluate(() => { const { x, y } = window.clicks.at(-1); return { x, y } })
  await page.reload()
  await page.locator('[data-dsh-ai-cursor]').waitFor({ state: 'attached' })
  assert.deepEqual(await page.evaluate(() => window.cursorPoint()), lastClick, 'navigation restores the last actual input position without a model tool call')
  await new Promise(resolve => setTimeout(resolve, 16000))
  assert.equal(await page.locator('[data-dsh-ai-cursor]').count(), 1, 'extension renews the cursor without Host tool calls')
  await ok(a, 'close')
  assert.equal(await page.locator('[data-dsh-ai-cursor]').count(), 0, 'release clears the cursor before detaching')
  console.log('PASS cursor short/curved motion, exact click arrival after scrolling, simulated hidden/reduced motion, retargeting, renewal and release')

  await ok(a, 'claim_tab', { tabId: userTabId })
  await ok(a, 'navigate', { url: `${url}/badge` })
  const tabIcon = () => worker.evaluate(async id => (await chrome.tabs.get(id)).favIconUrl, userTabId)
  const isBadge = href => href?.startsWith('data:image/svg+xml,') && href.includes('data-dsh-tab-icon')
  await waitFor(async () => isBadge(await tabIcon()))
  const badge = await tabIcon()
  const cornerAlpha = await page.evaluate(async href => {
    const image = new Image()
    image.src = href
    await image.decode()
    const canvas = new OffscreenCanvas(32, 32)
    const drawing = canvas.getContext('2d')
    drawing.drawImage(image, 0, 0)
    return drawing.getImageData(31, 31, 1, 1).data[3]
  }, badge)
  assert.ok(cornerAlpha >= 75 && cornerAlpha <= 78, 'controlled tab dims the actual original favicon to 30%')
  assert.match(decodeURIComponent(badge), /stroke="white".*scale\(2\.1\)/)
  await ok(a, 'take_screenshot', { type: 'png' })
  assert.equal(await tabIcon(), badge, 'screenshots hide only the page cursor, not the tab ownership indicator')
  await page.evaluate(() => document.querySelector('#site-icon').setAttribute('href', '/badge-icon.svg?second'))
  await waitFor(async () => isBadge(await tabIcon()) && await tabIcon() !== badge)
  await ok(a, 'close')
  await waitFor(async () => (await tabIcon())?.endsWith('/badge-icon.svg?second'))
  assert.deepEqual(await page.locator('#site-icon').evaluate(link => ({ href: link.getAttribute('href'), rel: link.rel, sizes: link.sizes.value })), { href: '/badge-icon.svg?second', rel: 'icon', sizes: '32x32' })
  assert.equal(await page.locator('[data-dsh-tab-indicator]').count(), 0)

  await ok(a, 'claim_tab', { tabId: userTabId })
  await waitFor(async () => isBadge(await tabIcon()))
  await page.reload()
  await waitFor(async () => isBadge(await tabIcon()))
  const blockedIcon = page.waitForEvent('console', { predicate: message => message.text().includes('data:image/svg+xml') && message.text().includes('Content Security Policy'), timeout: 10000 })
  await ok(a, 'navigate', { url: `${url}/badge-strict` })
  await blockedIcon
  await waitFor(async () => (await tabIcon())?.endsWith('/badge-icon.svg?first'))
  // Wait for the CSP preflight to settle: original link remains intact and page
  // control still works, rather than bypassing CSP to force an indicator.
  await waitFor(async () => await page.locator('[data-dsh-tab-indicator]').count() === 1)
  assert.equal(await page.locator('#site-icon').getAttribute('href'), '/badge-icon.svg?first')
  assert.equal(await page.locator('[data-dsh-ai-cursor]').count(), 1)
  await ok(a, 'close')
  assert.equal(await page.locator('[data-dsh-tab-indicator]').count(), 0)
  await ok(a, 'claim_tab', { tabId: userTabId })
  await ok(a, 'navigate', { url: `${url}/badge` })
  await waitFor(async () => isBadge(await tabIcon()))
  await worker.evaluate(id => chrome.debugger.detach({ tabId: id }), userTabId)
  await page.waitForFunction(() => !document.querySelector('[data-dsh-tab-indicator]'), undefined, { timeout: 20000 })
  await waitFor(async () => (await tabIcon())?.endsWith('/badge-icon.svg?first'))
  console.log('PASS native tab favicon badge, site updates, navigation, screenshots, restoration, CSP fallback and abnormal-detach expiry')
} finally {
  await Promise.all(clients.map(client => client.close()))
  await context?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await Promise.all(nativeManifests.map(path => rm(path, { force: true })))
  await rm(directory, { recursive: true, force: true })
}

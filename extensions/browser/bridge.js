import { cursorScript } from './page-cursor.js'
import { indicatorScript } from './tab-indicator.js'

const isIndicatorIcon = url => typeof url === 'string' && url.startsWith('data:image/svg+xml,') && url.includes('data-dsh-tab-icon')

/** A CDP view containing only pages leased by this client. Never activates a window. */
export class BrowserBridge {
  sessions = new Map()
  owners = new Map()

  constructor(chrome, send) {
    this.chrome = chrome
    this.send = send
    chrome.debugger.onEvent.addListener((source, method, params) => {
      const session = this.sessions.get(this.owners.get(source.tabId))
      const target = session?.tabs.get(source.tabId)
      if (!target || session.closed) return
      if (!source.sessionId && method === 'Page.domContentEventFired') {
        this.refreshCursor(session, target)
        this.refreshIndicator(session, target)
      }
      if (method === 'Target.attachedToTarget') session.children.set(params.sessionId, source.tabId)
      if (method === 'Target.detachedFromTarget') session.children.delete(params.sessionId)
      this.event(session, method, params, source.sessionId || target.sessionId)
    })
    chrome.debugger.onDetach.addListener((source, reason) => {
      const session = this.sessions.get(this.owners.get(source.tabId))
      if (!session || session.closed) return
      if (reason === 'target_closed') {
        const target = session.tabs.get(source.tabId)
        clearInterval(target?.timer)
        session.tabs.delete(source.tabId)
        this.owners.delete(source.tabId)
        if (target) this.event(session, 'Target.detachedFromTarget', { sessionId: target.sessionId, targetId: target.targetId })
      } else void this.close(session.client)
    })
    chrome.tabs.onCreated.addListener(tab => {
      const session = this.sessions.get(this.owners.get(tab.openerTabId))
      if (session && !session.closed) void this.attach(session, tab.id).catch(() => this.close(session.client))
    })
    chrome.tabs.onUpdated.addListener((tabId, change) => {
      const session = this.sessions.get(this.owners.get(tabId))
      const target = session?.tabs.get(tabId)
      if (!target) return
      const siteIconChanged = 'favIconUrl' in change && !isIndicatorIcon(change.favIconUrl)
      if (change.url || siteIconChanged) target.favicon = undefined
      if (change.url || siteIconChanged || change.status === 'complete') this.refreshIndicator(session, target)
    })
  }

  event(session, method, params, sessionId) {
    this.send({ client: session.client, message: { method, params, ...(sessionId ? { sessionId } : {}) } })
  }

  async receive({ client, message, close }) {
    if (close) { await this.close(client); return }
    let session = this.sessions.get(client)
    if (!session) {
      session = { client, tabs: new Map(), children: new Map(), closed: false }
      this.sessions.set(client, session)
    }
    try {
      const result = await this.command(session, message)
      this.send({ client, message: { id: message.id, sessionId: message.sessionId, result: result ?? {} } })
    } catch (error) {
      this.send({ client, message: { id: message.id, sessionId: message.sessionId, error: { code: -32000, message: String(error.message) } } })
    }
  }

  async attach(session, tabId) {
    if (session.closed) throw new Error('Browser control ended')
    if (this.owners.has(tabId) && this.owners.get(tabId) !== session.client) throw new Error('This tab belongs to another control connection')
    const current = session.tabs.get(tabId)
    if (current) { await current.ready; return current }
    // Reserve before awaiting Chrome: two dscode processes cannot both claim this tab.
    this.owners.set(tabId, session.client)
    const target = { tabId, sessionId: `dscode-tab-${tabId}`, targetId: '', owner: crypto.randomUUID(), ready: undefined }
    session.tabs.set(tabId, target)
    target.ready = (async () => {
      let attached = false
      try {
        await this.chrome.debugger.attach({ tabId }, '1.3')
        attached = true
        if (session.closed) throw new Error('Browser control ended')
        const { targetInfo } = await this.chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
        if (session.closed) throw new Error('Browser control ended')
        target.targetId = targetInfo.targetId
        await this.chrome.debugger.sendCommand({ tabId }, 'Page.enable')
        // Keep background actionability checks running without activating the tab.
        // Chrome restores the real focus/visibility state when this debugger detaches.
        await this.chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true })
        if (session.closed) throw new Error('Browser control ended')
        await this.cursor(target, { type: 'sync' })
        if (session.closed) throw new Error('Browser control ended')
        this.refreshIndicator(session, target)
        target.timer = setInterval(() => {
          this.refreshCursor(session, target)
          this.refreshIndicator(session, target)
        }, 5000)
        this.event(session, 'Target.attachedToTarget', {
          sessionId: target.sessionId, targetInfo: { ...targetInfo, attached: true }, waitingForDebugger: false,
        })
      } catch (error) {
        clearInterval(target.timer)
        if (attached) {
          await this.clearPresentation(target)
          await this.chrome.debugger.detach({ tabId }).catch(() => {})
        }
        session.tabs.delete(tabId)
        if (this.owners.get(tabId) === session.client) this.owners.delete(tabId)
        throw error
      }
    })()
    await target.ready
    return target
  }

  target(session, targetId) {
    const target = [...session.tabs.values()].find(tab => tab.targetId === targetId)
    if (!target) throw new Error('Tab is not owned by this control connection')
    return target
  }

  cursor(target, command) {
    return this.evaluatePresentation(target, cursorScript({ owner: target.owner, point: target.point, ...command, expiresAt: Date.now() + 800 }))
  }

  indicator(target, command) {
    return this.evaluatePresentation(target, indicatorScript({ owner: target.owner, ...command, expiresAt: Date.now() + 800 }))
  }

  async clearPresentation(target) {
    await Promise.all([
      this.cursor(target, { type: 'dispose' }),
      target.indicatorAttempted && this.indicator(target, { type: 'dispose' }),
    ])
  }

  async evaluatePresentation(target, expression) {
    let timer
    try {
      const result = await Promise.race([
        this.chrome.debugger.sendCommand({ tabId: target.tabId }, 'Runtime.evaluate', {
          expression, awaitPromise: true, returnByValue: true,
        }),
        new Promise(resolve => { timer = setTimeout(resolve, 800) }),
      ])
      return result?.result?.value === true
    } catch { return false } // Presentation must not replace Playwright's action result.
    finally { clearTimeout(timer) }
  }

  ownsTarget(session, target) {
    return !session.closed && !target.closing && session.tabs.get(target.tabId) === target
  }

  // Input, screenshots and document restoration share one presentation queue.
  // Release deliberately bypasses it so a stalled page cannot hold control open.
  onPage(session, target, action) {
    const pending = (target.input ?? Promise.resolve()).then(() => {
      if (!this.ownsTarget(session, target)) throw new Error('Browser control ended')
      return action()
    })
    target.input = pending.catch(() => {})
    return pending
  }

  refreshCursor(session, target) {
    if (target.refreshing || !this.ownsTarget(session, target)) return
    target.refreshing = true
    void this.onPage(session, target, () => this.cursor(target, { type: 'sync' }))
      .catch(() => {}).finally(() => { target.refreshing = false })
  }

  // Favicon reads do not hold up page input or screenshots. Coalesce browser
  // updates, but recheck the lease and document after every asynchronous read.
  refreshIndicator(session, target) {
    if (!this.ownsTarget(session, target)) return
    if (target.indicatorPending) { target.indicatorAgain = true; return }
    target.indicatorPending = true
    void this.syncIndicator(session, target).catch(() => {}).finally(() => {
      target.indicatorPending = false
      if (!target.indicatorAgain) return
      target.indicatorAgain = false
      this.refreshIndicator(session, target)
    })
  }

  async syncIndicator(session, target) {
    const tab = await this.chrome.tabs.get(target.tabId)
    if (!this.ownsTarget(session, target)) return
    let favicon = target.favicon
    if (favicon?.url !== tab.url || (!isIndicatorIcon(tab.favIconUrl) && favicon?.source !== tab.favIconUrl)) favicon = undefined
    if (!favicon && tab.favIconUrl && !isIndicatorIcon(tab.favIconUrl)) {
      const image = await readFavicon(this.chrome, tab.url)
      const current = await this.chrome.tabs.get(target.tabId)
      if (!this.ownsTarget(session, target) || current.url !== tab.url || current.favIconUrl !== tab.favIconUrl) return
      favicon = target.favicon = image ? { url: tab.url, source: tab.favIconUrl, image } : undefined
    }
    if (!this.ownsTarget(session, target)) return
    if (!favicon?.image && !target.indicatorAttempted && !isIndicatorIcon(tab.favIconUrl)) return
    target.indicatorAttempted = true
    await this.indicator(target, { type: 'sync', documentUrl: tab.url, icon: favicon?.image ?? null })
  }

  async moveCursor(session, target, params) {
    if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) return
    target.point = { x: params.x, y: params.y }
    const arrived = await this.cursor(target, {
      type: 'move', animate: params.type === 'mouseMoved' && !params.buttons,
    })
    if (!this.ownsTarget(session, target)) throw new Error('Browser control ended')
    if (arrived) return
    console.warn(`dscode cursor unavailable in tab ${target.tabId}; clearing stale feedback before input`)
    await this.cursor(target, { type: 'dispose' })
  }

  async pointerInput(session, target, params) {
    return this.onPage(session, target, async () => {
      await this.moveCursor(session, target, params)
      if (!this.ownsTarget(session, target)) throw new Error('Browser control ended')
      return this.chrome.debugger.sendCommand({ tabId: target.tabId }, 'Input.dispatchMouseEvent', params)
    })
  }

  async screenshot(session, target, params) {
    return this.onPage(session, target, async () => {
      await this.cursor(target, { type: 'visibility', hidden: true })
      try {
        if (!this.ownsTarget(session, target)) throw new Error('Browser control ended')
        return await this.chrome.debugger.sendCommand({ tabId: target.tabId }, 'Page.captureScreenshot', params)
      } finally {
        if (this.ownsTarget(session, target)) await this.cursor(target, { type: 'visibility', hidden: false })
      }
    })
  }

  async command(session, { method, params = {}, sessionId }) {
    if (session.closed) throw new Error('Browser control ended')
    if (method === 'dscode.listTabs') {
      return (await this.chrome.tabs.query({})).filter(tab => /^(https?:|file:|about:blank)/.test(tab.pendingUrl || tab.url || '')).map(tab => ({
        tabId: tab.id, title: tab.title, url: tab.pendingUrl || tab.url, claimed: this.owners.has(tab.id),
      }))
    }
    if (method === 'dscode.claimTab') {
      const tab = await this.chrome.tabs.get(params.tabId)
      if (!/^(https?:|file:|about:blank)/.test(tab.pendingUrl || tab.url || '')) throw new Error('This page cannot be controlled')
      const target = await this.attach(session, params.tabId)
      return { targetId: target.targetId }
    }
    if (method === 'dscode.focusTab') {
      if (!session.tabs.has(params.tabId)) throw new Error('Tab is not owned by this control connection')
      const tab = await this.chrome.tabs.get(params.tabId)
      await this.chrome.tabs.update(tab.id, { active: true })
      await this.chrome.windows.update(tab.windowId, { focused: true })
      return {}
    }
    if (method === 'dscode.release') { await this.close(session.client, false); return {} }
    // Playwright's tab selection is logical. Presentation is the explicit focusTab operation.
    if (method === 'Page.bringToFront' || method === 'Target.activateTarget') return {}
    if (sessionId) {
      const root = [...session.tabs.values()].find(tab => tab.sessionId === sessionId)
      const tabId = root?.tabId ?? session.children.get(sessionId)
      if (tabId === undefined || this.owners.get(tabId) !== session.client) throw new Error('Unknown browser target session')
      const target = { tabId, ...(!root ? { sessionId } : {}) }
      if (method === 'Input.dispatchMouseEvent' && root) return this.pointerInput(session, root, params)
      if (method === 'Page.captureScreenshot' && root) return this.screenshot(session, root, params)
      if (method === 'Page.close' && root) {
        return this.command(session, { method: 'Target.closeTarget', params: { targetId: root.targetId } })
      }
      return this.chrome.debugger.sendCommand(target, method, params)
    }
    switch (method) {
      case 'Browser.getVersion': return { protocolVersion: '1.3', product: `Chrome/${navigator.userAgent.match(/(?:Headless)?Chrome\/([\d.]+)/)?.[1] || 'Extension'}`, revision: '', userAgent: navigator.userAgent, jsVersion: '' }
      case 'Target.getBrowserContexts': return { browserContextIds: [] }
      case 'Target.setAutoAttach':
      case 'Target.setDiscoverTargets': return {}
      case 'Target.getTargetInfo': {
        if (!params.targetId) return { targetInfo: { targetId: 'browser', type: 'browser', title: '', url: '', attached: true } }
        const target = this.target(session, params.targetId)
        return this.chrome.debugger.sendCommand({ tabId: target.tabId }, method, {})
      }
      case 'Target.createTarget': {
        const windows = await this.chrome.windows.getAll({ windowTypes: ['normal'] })
        let tab
        if (windows.length) tab = await this.chrome.tabs.create({ windowId: windows[0].id, active: false, url: params.url || 'about:blank' })
        else tab = (await this.chrome.windows.create({ focused: false, type: 'normal', url: params.url || 'about:blank' })).tabs[0]
        const target = await this.attach(session, tab.id)
        return { targetId: target.targetId }
      }
      case 'Target.attachToTarget': return { sessionId: this.target(session, params.targetId).sessionId }
      case 'Target.closeTarget': {
        const target = this.target(session, params.targetId)
        target.closing = true
        try {
          await this.clearPresentation(target)
          await this.chrome.tabs.remove(target.tabId)
        } catch (error) {
          target.closing = false
          this.refreshCursor(session, target)
          this.refreshIndicator(session, target)
          throw error
        }
        if (session.tabs.delete(target.tabId)) {
          clearInterval(target.timer)
          this.owners.delete(target.tabId)
          this.event(session, 'Target.detachedFromTarget', { sessionId: target.sessionId, targetId: target.targetId })
        }
        return { success: true }
      }
      case 'Browser.getWindowForTarget': {
        const tab = await this.chrome.tabs.get(this.target(session, params.targetId).tabId)
        return { windowId: tab.windowId, bounds: {} }
      }
      default: throw new Error(`Browser extension does not support ${method}`)
    }
  }

  async close(client, notify = true) {
    const session = this.sessions.get(client)
    if (!session || session.closed) return
    session.closed = true
    await Promise.all([...session.tabs.values()].map(async target => {
      clearInterval(target.timer)
      await target.ready?.catch(() => {})
      // A failed attach already cleaned up and may have released this tab to a new owner.
      if (session.tabs.get(target.tabId) !== target || this.owners.get(target.tabId) !== client) return
      await this.clearPresentation(target)
      await this.chrome.debugger.detach({ tabId: target.tabId }).catch(() => {})
      if (this.owners.get(target.tabId) === client) this.owners.delete(target.tabId)
    }))
    session.tabs.clear()
    this.sessions.delete(client)
    if (notify) this.send({ client, close: true })
  }

  async stop() { await Promise.all([...this.sessions.keys()].map(client => this.close(client))) }
}

/** Read Chrome's existing 32px cache, without fetching a site's URL or credentials. */
async function readFavicon(chrome, pageUrl) {
  try {
    const url = new URL(chrome.runtime.getURL('/_favicon/'))
    url.searchParams.set('pageUrl', pageUrl)
    url.searchParams.set('size', '32')
    const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(2000) })
    // Chrome's internal PNG response can omit HTTP-style content headers.
    const type = response.headers.get('content-type')?.split(';')[0] || 'image/png'
    if (!response.ok || !type.startsWith('image/')) return null
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (!bytes.length || bytes.length > 65536) return null
    return `data:${type};base64,${btoa(String.fromCharCode(...bytes))}`
  } catch { return null }
}

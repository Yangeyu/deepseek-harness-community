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
      if (!target) return
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
    if (session.closed) throw new Error('Browser task ended')
    if (this.owners.has(tabId) && this.owners.get(tabId) !== session.client) throw new Error('This tab belongs to another browser task')
    const current = session.tabs.get(tabId)
    if (current) { await current.ready; return current }
    // Reserve before awaiting Chrome: two dscode processes cannot both claim this tab.
    this.owners.set(tabId, session.client)
    const target = { tabId, sessionId: `dscode-tab-${tabId}`, targetId: '', ready: undefined }
    session.tabs.set(tabId, target)
    target.ready = (async () => {
      let attached = false
      try {
        await this.chrome.debugger.attach({ tabId }, '1.3')
        attached = true
        if (session.closed) {
          await this.chrome.debugger.detach({ tabId }).catch(() => {})
          throw new Error('Browser task ended')
        }
        const { targetInfo } = await this.chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
        if (session.closed) throw new Error('Browser task ended')
        target.targetId = targetInfo.targetId
        target.timer = setInterval(() => { void this.cursor(target, 'renew()') }, 5000)
        this.event(session, 'Target.attachedToTarget', {
          sessionId: target.sessionId, targetInfo: { ...targetInfo, attached: true }, waitingForDebugger: false,
        })
      } catch (error) {
        session.tabs.delete(tabId)
        if (this.owners.get(tabId) === session.client) this.owners.delete(tabId)
        if (attached) await this.chrome.debugger.detach({ tabId }).catch(() => {})
        throw error
      }
    })()
    await target.ready
    return target
  }

  target(session, targetId) {
    const target = [...session.tabs.values()].find(tab => tab.targetId === targetId)
    if (!target) throw new Error('Tab is not owned by this browser task')
    return target
  }

  async cursor(target, expression) {
    let timer
    try {
      await Promise.race([
        this.chrome.debugger.sendCommand({ tabId: target.tabId }, 'Runtime.evaluate', {
          expression: `document.querySelector('[data-dsh-ai-cursor]')?.cursor?.${expression}`,
          awaitPromise: true, returnByValue: true,
        }),
        new Promise(resolve => { timer = setTimeout(resolve, 800) }),
      ])
    } catch { /* Visual failure must not replace Playwright's action result. */ }
    finally { clearTimeout(timer) }
  }

  async pointerInput(session, target, params) {
    // Playwright can send move/down/up concurrently. Keep the actual input behind
    // its visual arrival, using the exact viewport coordinates chosen by Playwright.
    const input = (target.input ?? Promise.resolve()).then(async () => {
      const ownsTarget = () => !session.closed && session.tabs.get(target.tabId) === target
      if (!ownsTarget()) throw new Error('Browser task ended')
      if ((params.type === 'mouseMoved' || params.type === 'mousePressed') && Number.isFinite(params.x) && Number.isFinite(params.y)) {
        await this.cursor(target, `move(${params.x},${params.y},${!params.buttons})`)
      }
      if (!ownsTarget()) throw new Error('Browser task ended')
      return this.chrome.debugger.sendCommand({ tabId: target.tabId }, 'Input.dispatchMouseEvent', params)
    })
    target.input = input.catch(() => {})
    return input
  }

  async command(session, { method, params = {}, sessionId }) {
    if (session.closed) throw new Error('Browser task ended')
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
      if (!session.tabs.has(params.tabId)) throw new Error('Tab is not owned by this browser task')
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
        await this.chrome.tabs.remove(target.tabId)
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
      await this.cursor(target, 'dispose()')
      await this.chrome.debugger.detach({ tabId: target.tabId }).catch(() => {})
      if (this.owners.get(target.tabId) === client) this.owners.delete(target.tabId)
    }))
    session.tabs.clear()
    this.sessions.delete(client)
    if (notify) this.send({ client, close: true })
  }

  async stop() { await Promise.all([...this.sessions.keys()].map(client => this.close(client))) }
}

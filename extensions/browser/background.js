import { BrowserBridge } from './bridge.js'

let port
const bridge = new BrowserBridge(chrome, message => {
  try { port?.postMessage(message) } catch { /* Native host has disconnected. */ }
})
function connect() {
  if (port) return
  const current = chrome.runtime.connectNative('com.dscode.browser')
  port = current
  current.onMessage.addListener(message => void bridge.receive(message))
  current.onDisconnect.addListener(() => {
    void chrome.runtime.lastError
    port = undefined
    void bridge.stop()
    chrome.action.setBadgeText({ text: '!' })
  })
  chrome.action.setBadgeText({ text: '' })
}
// Native port keeps this worker alive. Reconnect after host upgrades without opening UI.
chrome.alarms.create('connect', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(connect)
chrome.action.onClicked.addListener(() => void bridge.stop())
connect()

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { CursorRelay, type RpcMessage } from './cursor-relay.ts'

// Preserve MCP initialization, capabilities, resource traffic and tool schemas verbatim.
const chrome = spawn(process.execPath, process.argv.slice(2), { stdio: ['pipe', 'pipe', 'inherit'] })
const runtimeInput = createInterface({ input: process.stdin })
const chromeOutput = createInterface({ input: chrome.stdout })
const relay = new CursorRelay(
  message => { chrome.stdin.write(JSON.stringify(message) + '\n') },
  message => { process.stdout.write(JSON.stringify(message) + '\n') },
)
let stopping = false
let killTimer: NodeJS.Timeout | undefined

function stop(): void {
  if (stopping) return
  stopping = true
  relay.close()
  runtimeInput.close()
  process.stdin.destroy()
  chrome.stdin.end()
  chrome.kill('SIGTERM')
  killTimer = setTimeout(() => chrome.kill('SIGKILL'), 1000).unref()
}

function fail(error: Error): void {
  console.error(`[browser-cursor] ${error.message}`)
  process.exitCode = 1
  stop()
}

runtimeInput.on('line', line => {
  try { void relay.fromRuntime(JSON.parse(line) as RpcMessage).catch(fail) } catch (error) { fail(error as Error) }
})
chromeOutput.on('line', line => {
  try { relay.fromChrome(JSON.parse(line) as RpcMessage) } catch (error) { fail(error as Error) }
})
runtimeInput.on('close', stop)
chrome.on('error', fail)
chrome.stdin.on('error', fail)
process.stdout.on('error', fail)
chrome.on('exit', code => {
  if (!stopping) process.exitCode = code ?? 1
  stop()
  clearTimeout(killTimer)
})
process.on('SIGTERM', stop)
process.on('SIGINT', stop)

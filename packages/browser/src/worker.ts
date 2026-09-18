import { spawn } from 'node:child_process'
import { addAbortListener } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { BrowserError, type BrowserCommand } from './protocol.ts'

export interface BrowserWorker {
  request(command: BrowserCommand, signal: AbortSignal): Promise<unknown>
  dispose(): Promise<void>
}

export interface WorkerOptions {
  python: string
  workerPath?: string
}

// No model credentials or Python import-path overrides are passed into the executor.
function workerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' }
  for (const key of [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR',
    'LOCALAPPDATA', 'APPDATA', 'DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME',
    'BH_HOME', 'BROWSER_HARNESS_HOME', 'BH_CONFIG_DIR', 'BH_RUNTIME_DIR', 'BH_TMP_DIR',
    'BH_RUNTIME_DIR_SHARED', 'BH_TMP_DIR_SHARED', 'BH_AGENT_WORKSPACE',
    'BU_NAME', 'BU_CDP_URL', 'BU_CDP_WS', 'BH_CHROME_PATH', 'CHROME_PATH',
    'BH_RECORD', 'BH_TELEMETRY', 'BH_UPDATE_CHECK',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

async function* messages(stream: AsyncIterable<Buffer>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const maxLine = 18 * 1024 * 1024
  for await (const chunk of stream) {
    pending += decoder.write(chunk)
    let end: number
    while ((end = pending.indexOf('\n')) !== -1) {
      if (end > maxLine) throw new BrowserError('protocol', 'Browser worker message exceeds 18 MiB.')
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      if (line.trim() === '') continue
      let value: unknown
      try { value = JSON.parse(line) } catch { throw new BrowserError('protocol', 'Invalid browser worker JSON.') }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new BrowserError('protocol', 'Invalid browser worker message.')
      yield value as Record<string, unknown>
    }
    if (pending.length > maxLine) throw new BrowserError('protocol', 'Browser worker message exceeds 18 MiB.')
  }
  pending += decoder.end()
  if (pending.trim() !== '') throw new BrowserError('protocol', 'Browser worker ended with an incomplete message.')
}

/** One persistent executor, one outstanding command. Cancellation drains the process, never retries input. */
export function createBrowserWorker(options: WorkerOptions): BrowserWorker {
  const child = spawn(options.python, ['-u', options.workerPath ?? fileURLToPath(new URL('./python/worker.py', import.meta.url))], {
    stdio: ['pipe', 'pipe', 'pipe'], env: workerEnvironment(), windowsHide: true,
  })
  let sequence = 0
  let stopped = false
  let spawned = false
  let exited = false
  let exitCode: number | null = null
  let failure: Error | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let pending: { id: number; resolve(value: unknown): void; reject(error: Error): void } | undefined
  // Drain diagnostics, but don't publish arbitrary dependency stderr (may contain account/page data).
  child.stderr.resume()
  child.once('spawn', () => { spawned = true })
  const rejectPending = (error: Error) => {
    const current = pending
    pending = undefined
    current?.reject(error)
  }
  const stop = () => {
    stopped = true
    if (exited || killTimer !== undefined) return
    child.stdin.end()
    // Windows SIGTERM is immediate TerminateProcess; allow stdin EOF to clean up first.
    if (process.platform !== 'win32') child.kill('SIGTERM')
    // browser-harness CDP calls can spend 5s connecting + 5s awaiting a reply.
    // Allow an in-flight target allocation AND its close RPC to settle before hard kill.
    killTimer = setTimeout(() => { child.kill('SIGKILL') }, 22000)
    killTimer.unref()
  }
  const closed = new Promise<void>(resolve => {
    child.once('error', () => {
      failure = new BrowserError('transport', `Cannot start browser Python (${options.python}); check the executable and browser dependencies.`)
      rejectPending(failure)
    })
    child.once('close', code => {
      exited = true
      exitCode = code
      if (killTimer !== undefined) clearTimeout(killTimer)
      rejectPending(failure ?? new BrowserError('transport', 'Browser worker exited before replying. Check Python >=3.12, browser-harness==0.1.13 and the configured Chrome connection. Action outcome may be uncertain; do not retry blindly.'))
      resolve()
    })
  })
  child.stdin.on('error', () => {
    failure ??= new BrowserError('transport', 'Browser worker input closed. Action outcome may be uncertain; do not retry blindly.')
    rejectPending(failure)
    stop()
  })
  const reader = (async () => {
    try {
      for await (const message of messages(child.stdout)) {
        const current = pending
        if (!current || message.id !== current.id || typeof message.ok !== 'boolean') {
          throw new BrowserError('protocol', 'Browser worker sent an unexpected reply.')
        }
        pending = undefined
        if (message.ok) {
          if (!('value' in message)) {
            current.reject(new BrowserError('protocol', 'Browser worker reply has no value.'))
            throw new BrowserError('protocol', 'Browser worker reply has no value.')
          }
          current.resolve(message.value)
        } else {
          const error = message.error as { code?: unknown; message?: unknown } | undefined
          if (error === null || typeof error !== 'object' || typeof error.code !== 'string' || typeof error.message !== 'string') {
            current.reject(new BrowserError('protocol', 'Browser worker returned an invalid error.'))
            throw new BrowserError('protocol', 'Browser worker returned an invalid error.')
          }
          current.reject(new BrowserError(error.code, error.message))
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error : new BrowserError('protocol', 'Browser worker reader failed.')
      rejectPending(failure)
      stop()
    }
  })()
  let disposal: Promise<void> | undefined
  const dispose = () => disposal ??= (async () => {
    stop()
    rejectPending(new BrowserError('closed', 'Browser session closed. An in-flight action may have executed.'))
    await closed
    await reader
    if (exitCode !== 0 && spawned) {
      throw new BrowserError('cleanup', 'Browser executor was terminated or cleanup failed; its tab may remain open. Check the browser manually.')
    }
  })()
  return {
    async request(command, signal) {
      signal.throwIfAborted()
      if (stopped || exited || failure) throw failure ?? new BrowserError('closed', 'Browser executor is closed; open a new browser session.')
      if (pending) throw new BrowserError('busy', 'Browser executor already has an outstanding command.')
      const id = ++sequence
      const response = new Promise<unknown>((resolve, reject) => { pending = { id, resolve, reject } })
      const aborted = addAbortListener(signal, () => {
        rejectPending(new BrowserError('cancelled', 'Browser operation cancelled; an in-flight action may have executed.'))
        stop()
      })
      try {
        signal.throwIfAborted()
        child.stdin.write(JSON.stringify({ id, ...command }) + '\n')
        const value = await response
        signal.throwIfAborted()
        if (command.op === 'close') {
          stopped = true
          child.stdin.end()
          // Keep the caller's deadline active until cleanup and process exit finish.
          await closed
          await reader
          signal.throwIfAborted()
          if (exitCode !== 0) throw new BrowserError('cleanup', 'Browser cleanup failed; check for a remaining tab.')
        }
        return value
      } catch (error) {
        if (signal.aborted || stopped || failure) await dispose().catch(() => {})
        throw error
      } finally { aborted[Symbol.dispose]() }
    },
    dispose,
  }
}

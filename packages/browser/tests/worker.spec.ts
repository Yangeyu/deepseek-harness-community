import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createBrowserWorker } from '../src/worker.ts'

const workerPath = fileURLToPath(new URL('./fixtures/worker.py', import.meta.url))
const signal = () => AbortSignal.timeout(10000)

describe('persistent Python browser transport', () => {
  it('keeps one executor across Unicode observations and waits for explicit close', async () => {
    const worker = createBrowserWorker({ python: 'python3', workerPath })
    try {
      await expect(worker.request({ op: 'open', url: 'https://example.com/' }, signal())).resolves.toEqual({ status: 'opened', origin: 'https://example.com' })
      await expect(worker.request({ op: 'observe', screenshot: false }, signal())).resolves.toMatchObject({ observationId: '1', title: '测试' })
      await expect(worker.request({ op: 'observe', screenshot: false }, signal())).resolves.toMatchObject({ observationId: '2' })
      await expect(worker.request({ op: 'close' }, signal())).resolves.toEqual({ status: 'closed' })
      await expect(worker.request({ op: 'observe', screenshot: false }, signal())).rejects.toMatchObject({ code: 'closed' })
    } finally { await worker.dispose() }
  })

  it('allows bounded CDP cleanup to drain after cancelling a pending operation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'browser-cancel-'))
    const marker = join(directory, 'closed')
    const worker = createBrowserWorker({ python: 'python3', workerPath })
    const controller = new AbortController()
    try {
      await worker.request({ op: 'open', url: `https://example.com/?mode=pending&marker=${encodeURIComponent(marker)}` }, signal())
      const task = worker.request({ op: 'observe', screenshot: false }, controller.signal)
      const rejected = expect(task).rejects.toMatchObject({ code: 'cancelled' })
      controller.abort(new Error('user cancelled'))
      await rejected
      expect(await readFile(marker, 'utf8')).toBe('closed')
    } finally {
      await worker.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  }, 10000)

  it('retains uncertain errors without replaying the action or restarting the executor', async () => {
    const worker = createBrowserWorker({ python: 'python3', workerPath })
    try {
      await worker.request({ op: 'open', url: 'https://example.com/' }, signal())
      await expect(worker.request({ op: 'act', observationId: '1', actionId: 'e1' }, signal())).rejects.toMatchObject({ code: 'uncertain' })
      await expect(worker.request({ op: 'observe', screenshot: false }, signal())).resolves.toMatchObject({ observationId: '1' })
      await worker.request({ op: 'close' }, signal())
    } finally { await worker.dispose() }
  })

  it('reports a missing executable without hanging', async () => {
    const worker = createBrowserWorker({ python: '/nonexistent-browser-test-python', workerPath })
    try {
      await expect(worker.request({ op: 'open', url: 'https://example.com/' }, signal())).rejects.toThrow('Cannot start browser Python')
    } finally { await worker.dispose() }
  })

  it('does not expose dependency stderr after an executor crash', async () => {
    const worker = createBrowserWorker({ python: 'python3', workerPath })
    try {
      await worker.request({ op: 'open', url: 'https://example.com/?mode=crash' }, signal())
      await expect(worker.request({ op: 'observe', screenshot: false }, signal())).rejects.toThrow('exited before replying')
    } finally { await worker.dispose().catch(() => {}) }
  })
})

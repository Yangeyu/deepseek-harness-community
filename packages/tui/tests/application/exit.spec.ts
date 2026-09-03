import { describe, expect, it, vi } from 'vitest'
import { ApplicationExit } from '../../src/application/exit.ts'
import type { TuiRuntime } from '../../src/application/contracts.ts'
import type { RuntimeSessionSnapshot } from '../../src/runtime/session/snapshot.ts'

describe('ApplicationExit', () => {
  it('prints a copyable resume command only after terminal cleanup', async () => {
    const write = vi.fn(() => true)
    const exit = vi.fn()
    const dispose = vi.fn(async () => {})
    const runtime: TuiRuntime = {
      stdin: process.stdin,
      stdout: { write } as unknown as NodeJS.WriteStream,
      stderr: process.stderr,
      exit,
    }
    const processExit = new ApplicationExit(
      runtime,
      () => ({ sessionId: 'session-123' }) as RuntimeSessionSnapshot,
      dispose,
    )

    await processExit.request(0)

    expect(dispose).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledWith('\nResume this session with:\n  dscode resume session-123\n\n')
    expect(exit).toHaveBeenCalledWith(0)
    expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0] ?? 0)
    expect(write.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0] ?? 0)
  })
})

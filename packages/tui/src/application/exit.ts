import type { TuiRuntime } from './contracts.ts'
import type { RuntimeSessionSnapshot } from '../runtime/session/snapshot.ts'

function shellArgument(value: string): string {
  if (/^[A-Za-z0-9._:-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

function resumeHint(sessionId: RuntimeSessionSnapshot['sessionId']): string | undefined {
  if (sessionId === undefined) return undefined
  return `\nResume this session with:\n  dscode resume ${shellArgument(String(sessionId))}\n\n`
}

/** Serializes terminal exit and emits a resumable Session hint after cleanup. */
export class ApplicationExit {
  private exiting = false

  constructor(
    private readonly runtime: TuiRuntime,
    private readonly currentSession: () => Readonly<RuntimeSessionSnapshot>,
    private readonly dispose: () => Promise<void>,
  ) {}

  async request(code: number): Promise<void> {
    if (this.exiting) return
    this.exiting = true
    const hint = code === 0 ? resumeHint(this.currentSession().sessionId) : undefined
    await this.dispose()
    if (hint !== undefined) this.runtime.stdout.write(hint)
    this.runtime.exit(code)
  }
}

import type { TerminalCommandDefinition } from '../contracts.ts'
import type { RuntimeSessionSnapshot } from '../../../runtime/session/snapshot.ts'

export function createStatusCommand(session: {
  readonly current: Pick<RuntimeSessionSnapshot, 'sessionId' | 'cwd' | 'runState' | 'connection' | 'queue'>
  notice(message: string): void
}): TerminalCommandDefinition {
  return {
    name: 'status',
    description: 'Show current session status',
    handler() {
      const state = session.current
      session.notice([
        `Session: ${state.sessionId === undefined ? 'none' : String(state.sessionId)}`,
        `Directory: ${state.cwd}`,
        `State: ${state.runState}`,
        `Event stream: ${state.connection.events}`,
        `Control stream: ${state.connection.control}`,
        `Queued: ${state.queue.length}`,
      ].join('\n'))
    },
  }
}

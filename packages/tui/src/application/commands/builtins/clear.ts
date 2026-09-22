import type { TerminalCommandDefinition } from '../contracts.ts'

export function createClearCommand(
  session: { clearSession(): Promise<void> },
  layout: { followTranscript(): void },
): TerminalCommandDefinition {
  return {
    name: 'clear',
    description: 'Clear the conversation and start a new session',
    async handler() {
      layout.followTranscript()
      await session.clearSession()
    },
  }
}

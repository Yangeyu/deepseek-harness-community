import type { TerminalCommandDefinition } from '../contracts.ts'

export function createNewCommand(session: { newSession(): Promise<void> }): TerminalCommandDefinition {
  return {
    name: 'new',
    description: 'Create a new session',
    handler: () => session.newSession(),
  }
}

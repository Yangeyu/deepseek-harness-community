import type { TerminalCommandDefinition } from '../contracts.ts'

export function createHelpCommand(
  session: { notice(message: string): void },
  help: { helpText(): string },
): TerminalCommandDefinition {
  return {
    name: 'help',
    description: 'Show terminal and Harness commands',
    handler: () => { session.notice(help.helpText()) },
  }
}

import type { TerminalCommandDefinition } from '../contracts.ts'

export function createExitCommand(exit: { request(code: number): Promise<void> }): TerminalCommandDefinition {
  return {
    name: 'exit',
    aliases: ['quit'],
    description: 'Exit the terminal client',
    handler: () => exit.request(0),
  }
}

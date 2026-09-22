import type { TerminalCommandDefinition } from '../contracts.ts'

export function createMemoriesCommand(memory: { open(): Promise<void> }): TerminalCommandDefinition {
  return {
    name: 'memories',
    aliases: ['memory'],
    description: 'Manage project memory and session learning',
    handler: () => memory.open(),
  }
}

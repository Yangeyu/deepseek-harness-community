import type { TerminalCommandDefinition } from '../contracts.ts'

export function createRewindCommand(rewind: { request(): void }): TerminalCommandDefinition {
  return {
    name: 'rewind',
    description: 'Open source-attributed Rewind history',
    handler: () => { rewind.request() },
  }
}

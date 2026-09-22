import type { TerminalCommandDefinition } from '../contracts.ts'

export function createDetailsCommand(configuration: {
  readonly details: boolean
  setDetails(expanded: boolean): void
}): TerminalCommandDefinition {
  return {
    name: 'details',
    description: 'Toggle all Activity details',
    handler: () => { configuration.setDetails(!configuration.details) },
  }
}

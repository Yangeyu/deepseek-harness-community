import type { TerminalCommandDefinition } from '../contracts.ts'

export function createVisionCommand(configuration: { openRoute(route: string): void | Promise<void> }): TerminalCommandDefinition {
  return {
    name: 'vision',
    description: 'Configure image routing and the Vision proxy',
    handler: () => configuration.openRoute('vision'),
  }
}

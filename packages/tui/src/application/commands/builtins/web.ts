import type { TerminalCommandDefinition } from '../contracts.ts'

export function createWebCommand(configuration: { openRoute(route: string): void | Promise<void> }): TerminalCommandDefinition {
  return {
    name: 'web',
    description: 'Inspect Web search and page-reading providers',
    handler: () => configuration.openRoute('web'),
  }
}

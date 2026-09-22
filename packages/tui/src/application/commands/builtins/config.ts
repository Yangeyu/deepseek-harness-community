import type { TerminalCommandDefinition } from '../contracts.ts'

export function createConfigCommand(configuration: { openRoute(route: string): void | Promise<void> }): TerminalCommandDefinition {
  return {
    name: 'config',
    description: 'Configure model, policy, and terminal preferences',
    argumentHint: '[model|reasoning|permission|plan|vision|web|interface]',
    handler: route => configuration.openRoute(route),
  }
}

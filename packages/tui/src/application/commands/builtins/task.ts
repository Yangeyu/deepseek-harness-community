import type { TerminalCommandDefinition } from '../contracts.ts'

export function createTaskCommand(task: { open(): void }): TerminalCommandDefinition {
  return {
    name: 'task',
    requiresSession: true,
    description: 'Inspect and control the current task',
    handler: () => { task.open() },
  }
}

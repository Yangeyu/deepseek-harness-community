import type { TerminalCommandDefinition } from '../contracts.ts'

export function createTaskCommand(task: { open(): void }): TerminalCommandDefinition {
  return {
    name: 'task',
    description: 'Inspect and control the current task',
    handler: () => { task.open() },
  }
}

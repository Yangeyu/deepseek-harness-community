import type { TerminalCommandDefinition } from '../contracts.ts'

export function createTrajectoryCommand(trajectory: { open(): void }): TerminalCommandDefinition {
  return {
    name: 'trajectory',
    aliases: ['trace'],
    description: 'Inspect the session execution chain',
    handler: () => { trajectory.open() },
  }
}

import type { TerminalCommandDefinition } from '../contracts.ts'

export function createResumeCommand(
  sessionCenter: { open(): Promise<void>; resume(sessionId: string): Promise<void> },
): TerminalCommandDefinition {
  return {
    name: 'resume',
    description: 'Switch to another session',
    argumentHint: '[session-id]',
    handler: argument => argument === '' ? sessionCenter.open() : sessionCenter.resume(argument),
  }
}

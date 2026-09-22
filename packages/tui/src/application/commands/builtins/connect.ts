import type { TerminalCommandDefinition } from '../contracts.ts'

export function createConnectCommand(
  authentication: { connect(provider?: string): Promise<boolean> },
  session: { notice(message: string): void },
  signal: AbortSignal,
): TerminalCommandDefinition {
  return {
    name: 'connect',
    description: 'Sign in to a model provider with a subscription account',
    argumentHint: '[provider]',
    async handler(argument) {
      const connected = await authentication.connect(argument === '' ? undefined : argument)
      if (!signal.aborted) {
        session.notice(connected ? 'Provider connected. Use /model to select a model.' : 'Sign-in cancelled.')
      }
    },
  }
}

import type { TerminalCommandDefinition } from '../contracts.ts'
import { selectedModel } from '../../../runtime/session/model-selection.ts'
import type { RuntimeSessionSnapshot } from '../../../runtime/session/snapshot.ts'
import type { ProviderUsagePort } from '../../../modules/usage/contracts.ts'
import { formatUsage } from '../../../modules/usage/format.ts'

export interface UsageCommandSession {
  readonly current: Pick<RuntimeSessionSnapshot, 'modelCatalog' | 'projections'>
  captureSession(): { readonly active: boolean }
  notice(message: string): void
}

/** Query the footer's shared quota reader; feedback belongs to the invoking Session. */
export function createUsageCommand(
  session: UsageCommandSession,
  usage: ProviderUsagePort,
  signal: AbortSignal,
): TerminalCommandDefinition {
  return {
    name: 'usage',
    description: 'Show subscription quota and reset times for the current provider',
    activityLabel: 'Checking subscription usage',
    async handler() {
      const captured = session.captureSession()
      const provider = selectedModel(session.current.modelCatalog, session.current.projections)?.provider
      if (provider === undefined) throw new Error('Select a model with /model before checking usage.')
      let message: string
      try {
        const result = await usage.read(provider, signal)
        message = result === undefined ? `Subscription usage is not available for ${provider}.` : formatUsage(result)
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      if (!signal.aborted && captured.active) session.notice(message)
    },
  }
}

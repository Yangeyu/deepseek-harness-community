import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import type { ProviderUsage, ProviderUsagePort } from './contracts.ts'
import { formatUsageSummary } from './format.ts'

const REFRESH_MS = 60_000

interface Observation {
  provider: string
  controller: AbortController
  revision: number
}

/** One quota snapshot shared by the model footer and explicit /usage queries. */
export class ProviderUsageProcess implements ProviderUsagePort {
  private observation: Observation | undefined
  private snapshot: ProviderUsage | undefined
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly source: ProviderUsagePort,
    private readonly scope: LifecycleScope,
    private readonly onChange: () => void,
  ) {
    scope.onDispose(() => { this.stop() })
  }

  get summary(): string { return formatUsageSummary(this.snapshot) }

  observe(provider: string | undefined): void {
    if (this.observation?.provider === provider) return
    this.stop()
    if (provider === undefined || !this.scope.active) return
    const observation: Observation = { provider, controller: new AbortController(), revision: 0 }
    this.observation = observation
    const refresh = async (): Promise<void> => {
      try {
        const result = await this.read(provider, observation.controller.signal)
        if (result === undefined) return
      } catch {
        // Background failures hide the quota; /usage retains explicit error reporting.
      }
      if (this.observation === observation && this.scope.active) {
        this.timer = setTimeout(() => { void refresh() }, REFRESH_MS)
      }
    }
    void refresh()
  }

  async read(provider: string, signal: AbortSignal): Promise<ProviderUsage | undefined> {
    const observation = this.observation?.provider === provider ? this.observation : undefined
    const revision = observation === undefined ? 0 : ++observation.revision
    const publish = (usage: ProviderUsage | undefined): void => {
      if (observation === undefined || this.observation !== observation
        || observation.revision !== revision || !this.scope.active) return
      this.snapshot = usage
      this.onChange()
    }
    try {
      const usage = await this.source.read(provider, observation === undefined
        ? signal : AbortSignal.any([signal, observation.controller.signal]))
      publish(usage)
      return usage
    } catch (error) {
      publish(undefined)
      throw error
    }
  }

  private stop(): void {
    this.observation?.controller.abort()
    this.observation = undefined
    this.snapshot = undefined
    clearTimeout(this.timer)
    this.timer = undefined
  }
}

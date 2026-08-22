import type { Context } from '@deepseek-ai/cordis'
import { WebError } from '@deepseek-ai/dsh-web'

export interface WebCapabilityProvider {
  readonly id: string
  available(): boolean
}

export interface CommunityWebProviderReadiness {
  endpointHost?: string
  credentialRef?: string
  credentialConfigured?: boolean
  credentialSource?: string
  credentialWritable?: boolean
  available: boolean
}

export interface CommunityWebProviderStatus extends CommunityWebProviderReadiness {
  id: string
  label: string
  description: string
}

export interface CommunityWebProviderRegistration<Provider extends WebCapabilityProvider> {
  provider: Provider
  label: string
  description: string
  autoPriority: number
  /** Cheap local readiness inspection; it must not call the provider's remote API. */
  status(signal?: AbortSignal): Promise<CommunityWebProviderReadiness>
}

/** Capability-local provider registry shared by execution policy and configuration status. */
export class ProviderCatalog<Provider extends WebCapabilityProvider> {
  private readonly registrations = new Map<string, CommunityWebProviderRegistration<Provider>>()

  constructor(private readonly ctx: Context) {}

  register(registration: CommunityWebProviderRegistration<Provider>): () => void {
    const id = registration.provider.id
    if (id.length === 0) throw new TypeError('web provider id must not be empty')
    if (!Number.isFinite(registration.autoPriority)) {
      throw new TypeError(`web provider "${id}" autoPriority must be finite`)
    }
    if (this.registrations.has(id)) {
      throw new WebError(`web provider "${id}" is already registered`, 'WEB_DUPLICATE_PROVIDER')
    }
    const registrations = this.registrations
    const dispose = this.ctx.effect(function* registerWebProvider() {
      registrations.set(id, registration)
      yield () => {
        registrations.delete(id)
      }
    }, 'communityWeb.registerProvider()')
    return () => { void dispose() }
  }

  get(id: string): Provider | undefined {
    return this.registrations.get(id)?.provider
  }

  has(id: string): boolean {
    return this.registrations.has(id)
  }

  someAvailable(): boolean {
    return [...this.registrations.values()].some(registration => registration.provider.available())
  }

  async statuses(signal?: AbortSignal): Promise<CommunityWebProviderStatus[]> {
    const registrations = [...this.registrations.values()]
      .sort((left, right) => right.autoPriority - left.autoPriority || left.provider.id.localeCompare(right.provider.id))
    const statuses = await Promise.all(registrations.map(async registration => ({
      ...await registration.status(signal),
      id: registration.provider.id,
      label: registration.label,
      description: registration.description,
    })))
    signal?.throwIfAborted()
    return statuses
  }
}

import type { AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization/types'

export interface ProviderConnection {
  provider: string
  label: string
}

/** Available connections and authorization interaction; credentials remain Host-owned. */
export interface ProviderAuthenticationPort {
  list(): Promise<readonly ProviderConnection[]>
  authorize(provider: string, interaction: {
    notify(notice: AuthorizationNotice): void
    prompt(prompt: AuthorizationPrompt): Promise<string>
  }, signal: AbortSignal): Promise<boolean>
}

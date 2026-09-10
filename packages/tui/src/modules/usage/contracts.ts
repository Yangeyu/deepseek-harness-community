/** Server-reported account quota; independent of a session's token usage. */
export interface UsageWindow {
  durationSeconds: number
  usedPercent: number
  resetsAt?: number
}

export interface ProviderUsage {
  provider: string
  plan?: string
  checkedAt: number
  groups: readonly { label: string; windows: readonly UsageWindow[] }[]
}

export interface ProviderUsagePort {
  /** Undefined means this provider does not offer an account quota reader. */
  read(provider: string, signal: AbortSignal): Promise<ProviderUsage | undefined>
}

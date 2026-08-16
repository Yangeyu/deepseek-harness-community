import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy'

declare const lifecycleKeyBrand: unique symbol

export type LifecycleKey = string & { readonly [lifecycleKeyBrand]: true }

export type LifecycleKind =
  | 'turn'
  | 'step'
  | 'thought'
  | 'tool'
  | 'command'
  | 'vision'

export type LifecycleOutcome = 'completed' | 'failed' | 'interrupted'
export type ExecutionStatus = 'pending' | 'running' | LifecycleOutcome

export interface LifecycleBoundary {
  readonly seq?: number
  readonly time?: number
  readonly source: 'event' | 'parent' | 'snapshot-tail' | 'runtime'
}

export interface LifecycleError {
  readonly code?: string
  readonly message: string
}

export type LifecycleState =
  | { readonly phase: 'pending'; readonly declared?: LifecycleBoundary }
  | { readonly phase: 'running'; readonly started: LifecycleBoundary }
  | {
    readonly phase: 'settled'
    readonly outcome: LifecycleOutcome
    readonly started?: LifecycleBoundary
    readonly ended: LifecycleBoundary
    readonly error?: LifecycleError
  }

export interface LifecycleNode {
  readonly key: LifecycleKey
  readonly kind: LifecycleKind
  readonly parentKey?: LifecycleKey
  readonly state: LifecycleState
  readonly durability: 'durable' | 'ephemeral'
}

export type LifecycleDiagnosticCode =
  | 'conflicting-outcome'
  | 'identity-conflict'
  | 'missing-parent'
  | 'missing-start'
  | 'open-node-idle-tail'
  | 'terminal-reopened'
  | 'tool-result-missing'
  | 'unknown-turn-reason'

export interface LifecycleDiagnostic {
  readonly code: LifecycleDiagnosticCode
  readonly message: string
  readonly key?: LifecycleKey
  readonly seq?: number
}

export interface LifecycleAggregate {
  readonly status: ExecutionStatus
  readonly startedAt?: number
  readonly endedAt?: number
}

export interface LifecycleSnapshot {
  readonly sessionId: string | undefined
  readonly generation: number
  ordered(): readonly LifecycleNode[]
  get(key: LifecycleKey | string): LifecycleNode | undefined
  childrenOf(key: LifecycleKey | string): readonly LifecycleNode[]
  active(): readonly LifecycleNode[]
  diagnostics(): readonly LifecycleDiagnostic[]
  entry(seq: number | undefined): HistoryEntry | undefined
}

export interface RuntimeVisionActivity {
  readonly kind: 'vision'
  readonly analysisId: string
  readonly startedAt: number
}

export type RuntimeLifecycleActivity = RuntimeVisionActivity

export interface LifecycleBuildInput {
  readonly sessionId: string | undefined
  readonly generation: number
  readonly entries: readonly HistoryEntry[]
  readonly sessionRunning: boolean
  readonly runtimeActivities?: readonly RuntimeLifecycleActivity[]
}

import type { AssistantPresentation } from '../../session/assistant-stream.ts'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { HistoryEntry } from '../../session/contracts.ts'
import type { ModelRequest, StepModelCall } from './model-call.ts'

declare const executionKeyBrand: unique symbol

export type ExecutionKey = string & { readonly [executionKeyBrand]: true }

export type ExecutionKind =
  | 'turn'
  | 'prompt'
  | 'step'
  | 'thought'
  | 'tool'
  | 'command'
  | 'vision'

export type ExecutionOutcome = 'completed' | 'failed' | 'interrupted'
export type ExecutionStatus = 'pending' | 'running' | ExecutionOutcome

export interface ExecutionBoundary {
  readonly seq?: number
  readonly time?: number
  readonly source: 'event' | 'parent' | 'snapshot-tail' | 'runtime'
}

export interface ExecutionError {
  readonly code?: string
  readonly message: string
}

export type ExecutionState =
  | { readonly phase: 'pending'; readonly declared?: ExecutionBoundary }
  | { readonly phase: 'running'; readonly started: ExecutionBoundary }
  | {
    readonly phase: 'settled'
    readonly outcome: ExecutionOutcome
    readonly started?: ExecutionBoundary
    readonly ended: ExecutionBoundary
    readonly error?: ExecutionError
  }

export interface ExecutionNode {
  readonly key: ExecutionKey
  readonly kind: ExecutionKind
  readonly parentKey?: ExecutionKey
  readonly state: ExecutionState
  readonly durability: 'durable' | 'ephemeral'
}

export type ExecutionDiagnosticCode =
  | 'conflicting-outcome'
  | 'identity-conflict'
  | 'missing-parent'
  | 'missing-start'
  | 'open-node-idle-tail'
  | 'terminal-reopened'
  | 'tool-result-missing'
  | 'unknown-turn-reason'

export interface ExecutionDiagnostic {
  readonly code: ExecutionDiagnosticCode
  readonly message: string
  readonly key?: ExecutionKey
  readonly seq?: number
}

export interface ExecutionAggregate {
  readonly status: ExecutionStatus
  readonly startedAt?: number
  readonly endedAt?: number
}

export interface ExecutionSnapshot {
  readonly sessionId: string | undefined
  readonly epoch: number
  ordered(): readonly ExecutionNode[]
  get(key: ExecutionKey | string): ExecutionNode | undefined
  childrenOf(key: ExecutionKey | string): readonly ExecutionNode[]
  active(): readonly ExecutionNode[]
  diagnostics(): readonly ExecutionDiagnostic[]
  entry(seq: number | undefined): HistoryEntry | undefined
  modelCall(key: ExecutionKey | string): StepModelCall | undefined
  modelRequest(key: ExecutionKey | string): ModelRequest | undefined
}

export interface RuntimeVisionActivity {
  readonly kind: 'vision'
  readonly analysisId: string
  readonly startedAt: number
}

export type RuntimeExecutionActivity = RuntimeVisionActivity

export interface ExecutionBuildInput {
  readonly assistant?: AssistantPresentation | undefined
  readonly sessionId: string | undefined
  readonly epoch: number
  readonly entries: readonly HistoryEntry[]
  readonly sessionRunning: boolean
  readonly runtimeActivities?: readonly RuntimeExecutionActivity[]
}

/** Durable user-authored boundary projected from the canonical Session log. */
export interface PromptNode {
  readonly promptId: string
  readonly sessionId: string
  readonly turn: number
  readonly workspaceRoot: string
  readonly input: {
    readonly text: string
    readonly attachments: readonly ImageAttachmentRef[]
  }
  /** Placement within the enclosing Turn; only the entry Prompt is a conversation fork boundary. */
  readonly position: 'turn-entry' | 'in-turn'
  readonly admittedSeq: number
  readonly admittedAt: number
  readonly previousTurnEndSeq?: number
}

/** Consumer boundary for independently owned features such as Rewind. */
export interface PromptNodeSink {
  upsertPrompt(node: PromptNode): void
}

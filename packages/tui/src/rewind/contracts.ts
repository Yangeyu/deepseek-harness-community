import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** Whether a prepared rewind can be applied without losing unowned state. */
export type RewindPlanState = 'safe' | 'mergeable' | 'conflict' | 'unsupported'

export type RewindApplicableState = Extract<RewindPlanState, 'safe' | 'mergeable'>
export type RewindBlockedState = Extract<RewindPlanState, 'conflict' | 'unsupported'>

/** Direction along the retained editing timeline. */
export type RewindDirection = 'backward' | 'forward'

interface WorkspaceMutationSource {
  readonly sessionId: string
  readonly turn: number
  readonly callId: string
  readonly rootCallId: string
  readonly order: number
  readonly workspaceRoot: string
  readonly path: string
}

/** Canonical filesystem outcome accepted from a Host adapter. */
export type WorkspaceMutationInput =
  | WorkspaceMutationSource & {
    readonly kind: 'reversible'
    readonly before: string | null
    readonly after: string
  }
  | WorkspaceMutationSource & {
    readonly kind: 'unsupported'
    readonly reason: string
  }

interface AttributedWorkspaceMutation {
  readonly id: string
  readonly sourceSessionId: string
  readonly sourceTurn: number
  readonly callId: string
  readonly rootCallId: string
  readonly order: number
  readonly path: string
  readonly createdAt: number
}

/** One normalized workspace effect retained by the Rewind journal. */
export type WorkspaceMutation =
  | AttributedWorkspaceMutation & {
    readonly kind: 'reversible'
    readonly before: string | null
    readonly after: string
    readonly bytes: number
  }
  | AttributedWorkspaceMutation & {
    readonly kind: 'unsupported'
    readonly reason: string
  }

/** Backend-normalized mutation without journal identity fields. */
export type CanonicalWorkspaceMutation =
  | {
    readonly kind: 'reversible'
    readonly path: string
    readonly before: string | null
    readonly after: string
    readonly bytes: number
  }
  | {
    readonly kind: 'unsupported'
    readonly path: string
    readonly reason: string
  }

/** Complete, durable user input restored after a successful Rewind. */
export interface RewindPromptInput {
  readonly text: string
  readonly attachments: readonly ImageAttachmentRef[]
}

/** One accepted user prompt projected into the Rewind timeline. */
export interface RewindPointInput {
  readonly pointId: string
  readonly sessionId: string
  readonly turn: number
  readonly workspaceRoot: string
  readonly input: RewindPromptInput
  readonly promptSeq: number
  readonly createdAt: number
  readonly previousTurnEndSeq?: number
}

/** Opaque participant effect attributed to one user turn. */
export interface RewindEffectInput {
  readonly participantId: string
  readonly effectId: string
  readonly sourceSessionId: string
  readonly sourceTurn: number
}

export interface RewindEffectReference extends RewindEffectInput {}

/** JSON-compatible participant payload kept opaque outside its adapter. */
export interface RewindEffectPayload {
  readonly effectId: string
  readonly payload: unknown
}

/** Summary of one non-workspace participant in a point or plan. */
export type RewindParticipantImpact =
  | {
    readonly id: string
    readonly label: string
    readonly changes: number
    readonly state: RewindApplicableState
  }
  | {
    readonly id: string
    readonly label: string
    readonly changes: number
    readonly state: RewindBlockedState
    readonly reason: string
  }

/** Lightweight row for one user-turn rewind boundary. */
export interface RewindPointSummary {
  readonly pointId: string
  readonly sessionId: string
  readonly turn: number
  readonly prompt: string
  readonly imageCount: number
  readonly createdAt: number
  readonly workspaceFiles: number
  readonly unsupportedFiles: number
  readonly participants: readonly RewindParticipantImpact[]
}

/** Planned effect on one source-attributed workspace file. */
export type RewindFilePlan =
  | {
    readonly path: string
    readonly state: RewindApplicableState
    readonly added?: number
    readonly removed?: number
  }
  | {
    readonly path: string
    readonly state: RewindBlockedState
    readonly reason: string
  }

/** Immutable confirmation payload for one selected rewind boundary. */
export interface RewindPlan {
  readonly planId: string
  readonly pointId: string
  readonly sessionId: string
  readonly turn: number
  readonly input: RewindPromptInput
  readonly createdAt: number
  readonly previousTurnEndSeq?: number
  readonly state: RewindPlanState
  readonly files: readonly RewindFilePlan[]
  readonly participants: readonly RewindParticipantImpact[]
}

export type RewindCompensation = () => Promise<void>

/** Read and command surface consumed by an application. */
export interface RewindPort {
  activate(sessionId: string, workspaceRoot: string): Promise<void>
  settle(sessionId: string): Promise<void>
  list(sessionId: string): RewindPointSummary[]
  plan(sessionId: string, pointId: string): Promise<RewindPlan>
  restore(plan: RewindPlan): Promise<RewindCompensation>
  continueFrom(plan: RewindPlan, targetSessionId: string): Promise<void>
  close(): Promise<void>
}

/** Prompt-boundary intake owned by the Rewind application service. */
export interface RewindPointSink {
  recordPoint(input: RewindPointInput): Promise<void>
}

/** Workspace-effect intake consumed by the filesystem Host adapter. */
export interface RewindWorkspaceSink {
  recordWorkspaceMutation(input: WorkspaceMutationInput): void
}

/** Intake used by an explicit non-workspace participant adapter. */
export interface RewindEffectSink {
  recordEffect(input: RewindEffectInput): void
}

export interface PreparedWorkspaceRewind {
  readonly state: RewindPlanState
  readonly files: readonly RewindFilePlan[]
  /** A rejection must compensate any writes completed by this call. */
  apply(): Promise<RewindCompensation>
}

/** Filesystem-specific behavior injected into the transport-neutral service. */
export interface WorkspaceRewindBackend {
  canonicalizeRoot(root: string): string
  canonicalizeMutation(pointRoot: string, input: WorkspaceMutationInput): CanonicalWorkspaceMutation
  prepare(workspaceRoot: string, mutations: readonly WorkspaceMutation[]): Promise<PreparedWorkspaceRewind>
}

export interface PreparedRewindParticipant {
  readonly impact: RewindParticipantImpact
  /** A rejection must leave the participant in its pre-call state. */
  apply(): Promise<RewindCompensation>
}

/** Explicit side-effect participant; this is an internal contract, not a plugin registry. */
export interface RewindParticipant {
  readonly id: string
  readonly label: string
  settle(sessionId: string): Promise<void>
  prepare(effectIds: readonly string[], direction: RewindDirection): Promise<PreparedRewindParticipant>
  snapshot(effectIds: readonly string[]): readonly RewindEffectPayload[]
  /** Validate the complete batch before changing adapter state. */
  hydrate(payloads: readonly RewindEffectPayload[]): void
  release(effectIds: readonly string[]): void
}

/** Conversation commit boundary used by the application transaction. */
export interface RewindConversationPort {
  rewind(plan: RewindPlan, onPhase?: (phase: 'forking' | 'opening') => void): Promise<string>
}

import type { AssistantPresentation } from './assistant-stream.ts'
import type {
  HistoryEntry,
  ModelCatalog,
  QueuedInboxItem,
  SessionSummary,
} from './contracts.ts'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { ExecutionSnapshot } from '../execution/projection/index.ts'
import type { PendingSubmission } from './submission.ts'
import type { SessionBindingState } from '../lifecycle/session-machine.ts'

export type SessionId = SessionSummary['sessionId']

export type ConnectionPhase = 'connecting' | 'online' | 'reconnecting' | 'offline'

export interface SessionConnectionState {
  readonly events: ConnectionPhase
  readonly control: ConnectionPhase
}

export type SessionRunState = 'idle' | 'running' | 'interrupting'

/** One atomic renderer-facing value for the visible Session workspace. */
export interface RuntimeSessionSnapshot {
  readonly assistant?: AssistantPresentation | undefined
  readonly binding: SessionBindingState<SessionId>
  readonly sessionId: SessionId | undefined
  readonly cwd: string
  readonly runState: SessionRunState
  readonly connection: SessionConnectionState
  readonly events: readonly HistoryEntry[]
  readonly historyHasMore: boolean
  readonly queue: readonly QueuedInboxItem[]
  readonly pendingSubmissions: readonly PendingSubmission[]
  readonly execution: ExecutionSnapshot
  readonly modelCatalog: ModelCatalog | undefined
  readonly projections: Readonly<Partial<SessionProjectionMap>>
  readonly notice: string | undefined
  readonly error: string | undefined
}

export type RuntimeSessionData = Omit<RuntimeSessionSnapshot, 'execution'>

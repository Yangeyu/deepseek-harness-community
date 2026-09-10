import type {
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
  ModelCatalog,
  SessionProjectionValue,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  HistoryEntry,
  ModelSelection,
  PromptContentPart,
  QueuedInboxItem,
  SessionRequestId,
  SessionSummary,
} from './contracts.ts'
import type { SessionHistoryPage, SessionProjectionBaseline } from './history-page.ts'
import type { SessionId } from './snapshot.ts'

export type SessionFollowFrame =
  | { readonly type: 'assistant-stream'; readonly frame: SessionAssistantStreamFrame }
  | {
      readonly type: 'snapshot'
      readonly assistantStream?: SessionAssistantStreamBaseline | undefined
      readonly cursor: number
      readonly page: SessionHistoryPage
    }
  | {
      readonly type: 'event'
      readonly entry: HistoryEntry
    }

export type SessionControlFrame =
  | {
      readonly type: 'baseline'
      readonly queues: Readonly<Record<string, readonly QueuedInboxItem[]>>
      readonly projections: Readonly<Record<string, SessionProjectionBaseline>>
    }
  | {
      readonly type: 'queue'
      readonly sessionId: SessionId
      readonly items: readonly QueuedInboxItem[]
    }
  | {
      readonly type: 'projection'
      readonly sessionId: SessionId
      readonly key: string
      readonly value: SessionProjectionValue
      readonly seq: number
    }

export interface SessionPromptReceipt {
  readonly requestId: SessionRequestId
}

/** Consumer-owned Host boundary required by the Session lifecycle kernel. */
export interface SessionTransport {
  describeHost(): Promise<{ readonly cwd: string }>
  listSessions(signal?: AbortSignal): Promise<readonly SessionSummary[]>
  createSession(request: { readonly cwd: string; readonly sessionId?: SessionId }): Promise<{ readonly sessionId: SessionId }>
  forkSession(request: { readonly sessionId: SessionId; readonly atSeq: number }): Promise<{ readonly sessionId: SessionId }>
  page(request: {
    readonly sessionId: SessionId
    readonly throughSeq: number
    readonly maxMessages: number
    readonly beforeSeq?: number
  }, signal: AbortSignal): Promise<SessionHistoryPage>
  modelCatalog(): Promise<ModelCatalog>
  selectModel(sessionId: SessionId, selection: ModelSelection): Promise<void>
  prompt(request: {
    readonly requestId: SessionRequestId
    readonly sessionId: SessionId
    readonly mode: 'queue' | 'steer'
    readonly content: readonly PromptContentPart[]
    readonly clientTimeZone?: string
  }, signal: AbortSignal): Promise<SessionPromptReceipt>
  cancel(sessionId: SessionId): Promise<void>
  openPath(path: string, signal: AbortSignal): Promise<void>
  follow(sessionId: SessionId, maxMessages: number, signal: AbortSignal): AsyncIterable<SessionFollowFrame>
  control(signal: AbortSignal): AsyncIterable<SessionControlFrame>
  onStatus(listener: (sessionId: SessionId, running: boolean) => void): () => void
  onError(listener: (sessionId: SessionId, message: string) => void): () => void
}

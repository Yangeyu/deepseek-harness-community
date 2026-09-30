import type {
  ModelCatalog,
  ModelCatalogFailure,
  ModelCatalogModel,
  ModelProviderGroup,
  ModelReasoningEffort,
  ModelSelection,
  PromptContentPart,
  SessionRequestId,
  SessionSummary,
  SkillEntry,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'

export type {
  ModelCatalog,
  ModelCatalogFailure,
  ModelCatalogModel,
  ModelProviderGroup,
  ModelReasoningEffort,
  ModelSelection,
  PromptContentPart,
  SessionId,
  SessionRequestId,
  SessionSummary,
  SkillEntry,
  ToolCallView,
  ToolResultView,
}

/** Pure presentation intent derived from a durable Tool event. */
export type ToolEventView =
  | { readonly for: 'call'; readonly view: ToolCallView }
  | { readonly for: 'result'; readonly view: ToolResultView }

/** One durable event plus an optional, replayable presentation projection. */
export interface HistoryEntry {
  readonly event: SessionEvent
  readonly view?: ToolEventView
}

/** Pending Agent inbox face plus local presentation ownership, not execution state. */
export interface QueuedInboxItem {
  readonly id: UserMessage['id']
  readonly placement: 'queued' | 'steering' | 'context'
  readonly rpcId?: SessionRequestId
  readonly message: Pick<UserMessage, 'id' | 'content'>
  /** This prompt already appeared inline as an idle local submission. */
  readonly localEcho?: true
}

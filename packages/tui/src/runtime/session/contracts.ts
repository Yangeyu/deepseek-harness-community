import type {
  ModelCatalog,
  ModelCatalogFailure,
  ModelCatalogModel,
  ModelProviderGroup,
  ModelReasoningEffort,
  ModelSelection,
  PromptContentPart,
  SessionRequestId,
  SessionQueuedItem,
  SessionSummary,
  SkillEntry,
} from '@deepseek-ai/dsh-api-session-controller/types'
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
  SessionQueuedItem,
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

/** Exact pending Agent inbox face published by the Session Controller. */
export type QueuedInboxItem = SessionQueuedItem

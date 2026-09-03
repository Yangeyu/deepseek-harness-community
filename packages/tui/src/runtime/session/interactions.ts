import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions/types'
import type { SessionId } from './contracts.ts'

export interface ApprovalPrompt {
  readonly requestId: string
  readonly sessionId: SessionId
  readonly toolName: string
  readonly callId?: ToolCallId
  readonly reason?: string
  readonly signal?: AbortSignal
}

export interface QuestionPrompt {
  readonly requestId: string
  readonly sessionId: SessionId
  readonly questions: readonly AskUserQuestionItem[]
  readonly signal?: AbortSignal
}

/** Local lifecycle edge emitted when the Host request is answered or withdrawn. */
export type InteractionResolution =
  | {
      readonly type: 'approval/resolved'
      readonly sessionId: SessionId
      readonly requestId: string
      readonly outcome: ApprovalOutcome
    }
  | {
      readonly type: 'question/resolved'
      readonly sessionId: SessionId
      readonly requestId: string
      readonly outcome: 'answered' | 'cancelled'
    }

export type SessionInteractionEvent =
  | { readonly type: 'approval'; readonly prompt: ApprovalPrompt }
  | { readonly type: 'questions'; readonly prompt: QuestionPrompt }
  | { readonly type: 'resolved'; readonly resolution: InteractionResolution }

export type SessionInteractionListener = (event: SessionInteractionEvent) => void

export interface SessionInteractionHandler {
  approval(prompt: ApprovalPrompt): Promise<ApprovalOutcome | undefined>
  questions(prompt: QuestionPrompt): Promise<AskUserQuestionAnswer | undefined>
}

/** Host-owned waterfall adapter; undefined delegates to the next answerer. */
export interface SessionInteractionSource {
  connect(handler: SessionInteractionHandler): () => void
}

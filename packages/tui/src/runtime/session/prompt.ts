import type { PromptContentPart, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type { SubmissionActivityUpdate } from './submission.ts'

/** Progress channel retained from local preparation through durable event handoff. */
export interface PromptPreparationContext {
  setActivity(activity: SubmissionActivityUpdate): void
}

export interface PreparedPromptCommitContext {
  rpcId: RpcId
  clientTimeZone?: string
}

export type PreparedPrompt =
  | { kind: 'content'; content: PromptContentPart[] }
  | { kind: 'admission'; commit(context: PreparedPromptCommitContext): Promise<void> }

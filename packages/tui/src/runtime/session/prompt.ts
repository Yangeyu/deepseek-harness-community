import type { PromptContentPart } from './contracts.ts'
import type { SubmissionActivityUpdate } from './submission.ts'

/** Progress channel retained from local preparation through durable event handoff. */
export interface PromptPreparationContext {
  setActivity(activity: SubmissionActivityUpdate): void
}

export interface PreparedPrompt {
  readonly content: PromptContentPart[]
}

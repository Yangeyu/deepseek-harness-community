import type { Context } from '@deepseek-ai/cordis'
import {
  installPromptLifecycle,
  type PromptNode,
} from '../../runtime/lifecycle/index.ts'
import type { RewindPointInput, RewindPointSink } from '../contracts.ts'

export function rewindPointFromPrompt(prompt: PromptNode): RewindPointInput | undefined {
  if (prompt.position !== 'turn-entry') return undefined
  return {
    pointId: prompt.promptId,
    sessionId: prompt.sessionId,
    turn: prompt.turn,
    workspaceRoot: prompt.workspaceRoot,
    input: prompt.input,
    promptSeq: prompt.admittedSeq,
    createdAt: prompt.admittedAt,
    ...prompt.previousTurnEndSeq === undefined
      ? {}
      : { previousTurnEndSeq: prompt.previousTurnEndSeq },
  }
}

/** Connect the canonical Prompt lifecycle to Rewind without leaking either domain into the other. */
export function installRewindPromptAdapter(
  ctx: Context,
  sink: RewindPointSink,
  onError: (error: unknown) => void,
): void {
  installPromptLifecycle(ctx, {
    upsertPrompt: (prompt) => {
      const point = rewindPointFromPrompt(prompt)
      if (point !== undefined) void sink.recordPoint(point).catch(onError)
    },
  })
}

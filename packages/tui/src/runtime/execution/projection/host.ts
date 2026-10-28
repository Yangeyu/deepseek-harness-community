import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { promptImagesFromContent } from '../../session/input.ts'
import { promptTextFromContent } from '../prompt-text.ts'
import type { PromptNode, PromptNodeSink } from './types.ts'

const attachmentSchema = z.object({
  attachmentId: z.string().transform(AttachmentId),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: z.number(), width: z.number(), height: z.number(), name: z.string().optional(),
}).transform(({ name, ...attachment }) => ({ ...attachment, ...name === undefined ? {} : { name } }))

const promptSchema: z.ZodType<PromptNode> = z.object({
  promptId: z.string(), sessionId: z.string(), turn: z.number(), workspaceRoot: z.string(),
  input: z.object({
    text: z.string(),
    attachments: z.array(z.object({ reference: z.string(), attachment: attachmentSchema })),
  }),
  position: z.enum(['turn-entry', 'in-turn']), admittedSeq: z.number(), admittedAt: z.number(),
  previousTurnEndSeq: z.number().optional(),
}).transform(({ previousTurnEndSeq, ...prompt }) => ({
  ...prompt, ...previousTurnEndSeq === undefined ? {} : { previousTurnEndSeq },
}))

const stateSchema: z.ZodType<PromptHistoryState> = z.object({
  sessionId: z.string(), cwd: z.string(), turn: z.number().nullable(),
  previousTurnEndSeq: z.number().nullable(), hasPrompt: z.boolean(),
  latest: promptSchema.nullable(), checkpoints: z.array(promptSchema),
})

export interface PromptHistoryState {
  sessionId: string
  cwd: string
  turn: number | null
  previousTurnEndSeq: number | null
  hasPrompt: boolean
  latest: PromptNode | null
  checkpoints: readonly PromptNode[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { communityPrompts: PromptHistoryState }
}

export function isAcceptedPromptEvent(event: SessionEvent): event is Extract<SessionEvent, { type: 'user/message' }> {
  return event.type === 'user/message' && event.surfaceOp === 'append' && event.data.source.kind === 'user'
}

/** Fold admission once; resumed sessions use the same registered Host projection. */
export function foldPromptHistory(state: PromptHistoryState, event: SessionEvent, limit: number): PromptHistoryState {
  if (event.type === 'turn/start') return { ...state, turn: event.data.turn, hasPrompt: false }
  if (event.type === 'turn/end') return { ...state, turn: null, previousTurnEndSeq: event.seq }
  if (!isAcceptedPromptEvent(event) || state.turn === null) return state
  const text = promptTextFromContent(event.data.content)
  const prompt: PromptNode = {
    promptId: String(event.data.id), sessionId: state.sessionId, turn: state.turn,
    workspaceRoot: state.cwd,
    input: { text: text.trim() === '' ? '[Message]' : text, attachments: promptImagesFromContent(event.data.content) },
    position: state.hasPrompt ? 'in-turn' : 'turn-entry', admittedSeq: event.seq, admittedAt: event.time,
    ...state.previousTurnEndSeq === null ? {} : { previousTurnEndSeq: state.previousTurnEndSeq },
  }
  return {
    ...state, hasPrompt: true, latest: prompt,
    checkpoints: state.hasPrompt ? state.checkpoints : [...state.checkpoints, prompt].slice(-limit),
  }
}

export function registerPromptHistory(ctx: Context, limit: number): void {
  ctx.sessionProjections.register({
    key: 'communityPrompts', stateVersion: 1,
    stateSchema: stateSchema.refine(state => state.checkpoints.length <= limit),
    init: header => ({
      sessionId: String(header.id), cwd: header.cwd ?? process.cwd(), turn: null,
      previousTurnEndSeq: null, hasPrompt: false, latest: null, checkpoints: [],
    }),
    apply: (state, event) => foldPromptHistory(state, event, limit),
  })
}

/** Publish only the prompt admitted by this event, after the projection has advanced. */
export function installPromptProjection(ctx: Context, sink: PromptNodeSink): void {
  ctx.on('session/event', (session, event) => {
    if (!isAcceptedPromptEvent(event)) return
    const prompt = ctx.sessionProjections.stateOf(session, 'communityPrompts')?.latest
    if (prompt?.admittedSeq === event.seq) sink.upsertPrompt(prompt)
  })
}

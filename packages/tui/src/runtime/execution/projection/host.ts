import type { Context } from '@deepseek-ai/cordis'
import { SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { promptImagesFromContent } from '../../session/input.ts'
import { promptTextFromContent } from '../prompt-text.ts'
import type { PromptNode, PromptNodeSink } from './types.ts'

type UserMessageEvent = Extract<SessionEvent, { type: 'user/message' }>
type AcceptedPromptEvent = UserMessageEvent & {
  readonly data: UserMessageEvent['data'] & {
    readonly source: Extract<UserMessageEvent['data']['source'], { kind: 'user' }>
  }
}

export function isAcceptedPromptEvent(event: SessionEvent): event is AcceptedPromptEvent {
  return event.type === 'user/message'
    && event.surfaceOp === 'append'
    && event.data.source.kind === 'user'
}

const boundarySchema = z.object({
  turn: z.number().int().nonnegative(),
  open: z.boolean(),
  firstPromptSeq: z.number().int().nonnegative().nullable(),
  previousTurnEndSeq: z.number().int().nonnegative().nullable(),
})
type PromptBoundary = z.infer<typeof boundarySchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    communityPromptBoundary: PromptBoundary
  }
}

const promptBoundary: ProjectionDefinition<'communityPromptBoundary'> = {
  key: 'communityPromptBoundary',
  stateVersion: 1,
  stateSchema: boundarySchema,
  init: () => ({ turn: 0, open: false, firstPromptSeq: null, previousTurnEndSeq: null }),
  apply(state, event) {
    if (event.type === 'turn/start') return { ...state, turn: event.data.turn, open: true, firstPromptSeq: null }
    if (event.type === 'turn/end') return { ...state, open: false, previousTurnEndSeq: event.seq }
    if (state.open && state.firstPromptSeq === null && isAcceptedPromptEvent(event)) {
      return { ...state, firstPromptSeq: event.seq }
    }
    return state
  },
}

function promptNode(header: SessionHeader, event: SessionEvent, state: PromptBoundary): PromptNode | undefined {
  if (!state.open || !isAcceptedPromptEvent(event)) return undefined
  const text = promptTextFromContent(event.data.content)
  return {
    promptId: String(event.data.id),
    sessionId: String(header.id),
    turn: state.turn,
    workspaceRoot: header.cwd ?? process.cwd(),
    input: { text: text.trim() === '' ? '[Message]' : text, attachments: promptImagesFromContent(event.data.content) },
    position: state.firstPromptSeq === event.seq ? 'turn-entry' : 'in-turn',
    admittedSeq: event.seq,
    admittedAt: event.time,
    ...state.previousTurnEndSeq === null ? {} : { previousTurnEndSeq: state.previousTurnEndSeq },
  }
}

/** Fold a Query observation with the same boundary rules as the live Host projection. */
export function projectPromptNodes(header: SessionHeader, events: readonly SessionEvent[]): PromptNode[] {
  let state = promptBoundary.init(header, SessionLogOffset(0))
  const nodes: PromptNode[] = []
  for (const event of events) {
    state = promptBoundary.apply(state, event)
    const node = promptNode(header, event, state)
    if (node !== undefined) nodes.push(node)
  }
  return nodes
}

/** Publish Prompt admission synchronously; the Host owns replay and the bounded boundary state. */
export function installPromptProjection(ctx: Context, sink: PromptNodeSink): void {
  ctx.sessionProjections.register(promptBoundary)
  ctx.on('session/event', (session, event) => {
    if (!isAcceptedPromptEvent(event)) return
    const state = ctx.sessionProjections.stateOf(session, 'communityPromptBoundary')
    if (state === undefined) throw new Error('Prompt boundary projection is unavailable')
    const prompt = promptNode(session.header, event, state)
    if (prompt !== undefined) sink.upsertPrompt(prompt)
  })
}

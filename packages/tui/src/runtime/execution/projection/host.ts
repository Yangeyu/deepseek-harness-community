import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
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

function promptText(event: UserMessageEvent): string {
  const text = promptTextFromContent(event.data.content)
  if (text.trim() !== '') return text
  return '[Message]'
}

/** Project the latest immutable state of one human Prompt from the Session log. */
export function projectPromptNode(
  session: Session,
  event: SessionEvent,
): PromptNode | undefined {
  if (!isAcceptedPromptEvent(event)) return undefined
  const prompt = event
  const events = session.snapshotEvents()

  const start = events.findLast(candidate => (
    candidate.seq < prompt.seq && candidate.type === 'turn/start'
  ))
  if (start?.type !== 'turn/start') return undefined
  const closed = events.some(candidate => (
    candidate.seq > start.seq
    && candidate.seq <= event.seq
    && candidate.type === 'turn/end'
    && candidate.data.turn === start.data.turn
  ))
  if (closed) return undefined

  const priorPrompt = events.some(candidate => (
    candidate.seq > start.seq
    && candidate.seq < prompt.seq
    && isAcceptedPromptEvent(candidate)
  ))
  const previous = events.findLast(candidate => (
    candidate.seq < start.seq && candidate.type === 'turn/end'
  ))
  const attachments = promptImagesFromContent(prompt.data.content)
  return {
    promptId: String(prompt.data.id),
    sessionId: String(session.id),
    turn: start.data.turn,
    workspaceRoot: session.header.cwd ?? process.cwd(),
    input: {
      text: promptText(prompt),
      attachments,
    },
    position: priorPrompt ? 'in-turn' : 'turn-entry',
    admittedSeq: prompt.seq,
    admittedAt: prompt.time,
    ...previous?.type === 'turn/end' ? { previousTurnEndSeq: previous.seq } : {},
  }
}

/** Publish complete immutable Prompt snapshots on canonical user admission. */
export function installPromptProjection(ctx: Context, sink: PromptNodeSink): void {
  ctx.on('session/event', (session, event) => {
    const prompt = projectPromptNode(session, event)
    if (prompt !== undefined) sink.upsertPrompt(prompt)
  })
}

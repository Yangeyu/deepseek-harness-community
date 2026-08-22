import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@vascent/deepseek-harness-vision'
import { promptTextFromContent } from '../../prompt-content.ts'
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

function promptEventFor(session: Session, event: SessionEvent): AcceptedPromptEvent | undefined {
  if (isAcceptedPromptEvent(event)) return event
  if (event.type !== 'user/message'
    || event.surfaceOp !== 'append'
    || event.data.source.kind !== 'community-vision') return undefined
  const promptId = event.data.source.promptId
  return session.events.find((candidate): candidate is AcceptedPromptEvent => (
    candidate.seq < event.seq
    && isAcceptedPromptEvent(candidate)
    && String(candidate.data.id) === promptId
  ))
}

function promptAttachments(
  session: Session,
  prompt: AcceptedPromptEvent,
  throughSeq: number,
): ImageAttachmentRef[] {
  const refs = [
    ...prompt.data.content.flatMap(block => block.type === 'image' ? [block.attachment] : []),
    ...session.events.flatMap((candidate) => {
      if (candidate.seq <= prompt.seq
        || candidate.seq > throughSeq
        || candidate.type !== 'user/message'
        || candidate.surfaceOp !== 'append'
        || candidate.data.source.kind !== 'community-vision'
        || candidate.data.source.promptId !== String(prompt.data.id)) return []
      return candidate.data.source.attachments
    }),
  ]
  const unique = new Map<string, ImageAttachmentRef>()
  for (const ref of refs) unique.set(String(ref.attachmentId), ref)
  return [...unique.values()]
}

/** Project the latest immutable state of one human Prompt from the Session log. */
export function projectPromptNode(
  session: Session,
  event: SessionEvent,
): PromptNode | undefined {
  const prompt = promptEventFor(session, event)
  if (prompt === undefined) return undefined

  const start = session.events.findLast(candidate => (
    candidate.seq < prompt.seq && candidate.type === 'turn/start'
  ))
  if (start?.type !== 'turn/start') return undefined
  const closed = session.events.some(candidate => (
    candidate.seq > start.seq
    && candidate.seq <= event.seq
    && candidate.type === 'turn/end'
    && candidate.data.turn === start.data.turn
  ))
  if (closed) return undefined

  const priorPrompt = session.events.some(candidate => (
    candidate.seq > start.seq
    && candidate.seq < prompt.seq
    && isAcceptedPromptEvent(candidate)
  ))
  const previous = session.events.findLast(candidate => (
    candidate.seq < start.seq && candidate.type === 'turn/end'
  ))
  const attachments = promptAttachments(session, prompt, event.seq)
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

/** Publish immutable Prompt snapshots after canonical input or evidence commits. */
export function installPromptLifecycle(ctx: Context, sink: PromptNodeSink): void {
  ctx.on('session/event', (session, event) => {
    const prompt = projectPromptNode(session, event)
    if (prompt !== undefined) sink.upsertPrompt(prompt)
  })
}

import type { InboxState, InboxTarget, InboxWireState } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { QueuedInboxItem } from './contracts.ts'

function queueItem(message: UserMessage, target: InboxTarget): QueuedInboxItem {
  const source = message.source
  return {
    id: message.id,
    placement: target === 'next-turn' ? 'queued' : source.kind === 'user' ? 'steering' : 'context',
    ...source.kind === 'user' && 'rpcId' in source ? { rpcId: source.rpcId } : {},
    message: { id: message.id, content: message.content as unknown as QueuedInboxItem['message']['content'] },
  }
}

/** Seed the display queue at the follow snapshot's cut, without replaying its history. */
export function queueFromInbox(inbox: InboxWireState | undefined): QueuedInboxItem[] {
  if (inbox === undefined) return []
  // The Host validates this public projection; its wire type erases UserMessage fields.
  const state = inbox as unknown as InboxState
  return [
    ...state['next-turn'].map(message => queueItem(message, 'next-turn')),
    ...state['next-step'].map(message => queueItem(message, 'next-step')),
  ]
}

/** Fold a committed splice into the existing display queue, retaining context positions. */
export function spliceQueue(queue: readonly QueuedInboxItem[], splice: SessionEvent<'agent/inbox/spliced'>['data']): {
  queue: QueuedInboxItem[]
  removed: QueuedInboxItem[]
} {
  const nextTurn = queue.filter(item => item.placement === 'queued')
  const nextStep = queue.filter(item => item.placement !== 'queued')
  const target = splice.target === 'next-turn' ? nextTurn : nextStep
  const inserted = splice.inserted.map(message => queueItem(message, splice.target))
  const replacedIds = new Set(inserted.map(item => item.id))
  const removed = target.splice(splice.start, splice.removedCount ?? 0, ...inserted)
  return {
    queue: [...nextTurn, ...nextStep],
    removed: removed.filter(item => !replacedIds.has(item.id)),
  }
}

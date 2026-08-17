import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@vascent/deepseek-harness-vision'
import {
  commandLifecycleKey,
  promptLifecycleKey,
  stepLifecycleKey,
  thoughtLifecycleKey,
  toolLifecycleKey,
  turnLifecycleKey,
  visionLifecycleKey,
} from './keys.ts'
import { isAcceptedPromptEvent } from './host.ts'
import { LifecycleReducer } from './reducer.ts'
import type { LifecycleBoundary, LifecycleError, LifecycleOutcome } from './types.ts'

function eventBoundary(entry: HistoryEntry): LifecycleBoundary {
  return { seq: entry.event.seq, time: entry.event.time, source: 'event' }
}

function parentBoundary(entry: HistoryEntry): LifecycleBoundary {
  return { seq: entry.event.seq, time: entry.event.time, source: 'parent' }
}

function textFromContent(content: readonly { type: string; text?: string }[], type: 'text' | 'reasoning'): string {
  return content.filter(block => block.type === type).map(block => block.text ?? '').join('')
}

function toolResultFailed(entry: HistoryEntry): boolean {
  if (entry.event.type !== 'tool/result') return false
  return entry.event.data.error !== undefined || entry.event.data.message.content.some(
    block => block.type === 'tool-result' && block.isError === true,
  )
}

function declareStepParent(reducer: LifecycleReducer, turn: number, step: number): void {
  reducer.declare(
    stepLifecycleKey(turn, step),
    'step',
    turnLifecycleKey(turn),
  )
}

function turnOutcome(entry: HistoryEntry & { event: Extract<HistoryEntry['event'], { type: 'turn/end' }> }): {
  outcome: LifecycleOutcome
  error?: LifecycleError
  unknown: boolean
} {
  const reason = entry.event.data.reason
  switch (reason.kind) {
    case 'completed': return { outcome: 'completed', unknown: false }
    case 'error': return {
      outcome: 'failed',
      error: {
        message: reason.error.message,
        ...reason.error.code === undefined ? {} : { code: reason.error.code },
      },
      unknown: false,
    }
    case 'aborted':
    case 'blocked':
    case 'max-tokens':
    case 'interrupted':
      return { outcome: 'interrupted', unknown: false }
    default:
      return { outcome: 'interrupted', unknown: true }
  }
}

function settleOpenStepChildren(entry: HistoryEntry, reducer: LifecycleReducer, turn: number, step: number): void {
  const parentKey = stepLifecycleKey(turn, step)
  const at = parentBoundary(entry)
  for (const node of reducer.openChildren(parentKey)) {
    if (node.kind === 'thought') {
      reducer.settle(node.key, node.kind, node.parentKey, 'completed', at)
      continue
    }
    if (node.kind === 'tool') {
      reducer.settle(node.key, node.kind, node.parentKey, 'interrupted', at)
      reducer.diagnose('tool-result-missing', `Tool lifecycle ${node.key} ended without a result.`, node.key, entry.event.seq)
    }
  }
}

function settleOpenTurnDescendants(
  entry: HistoryEntry,
  reducer: LifecycleReducer,
  turn: number,
  turnTerminal: LifecycleOutcome,
): void {
  const parentKey = turnLifecycleKey(turn)
  const outcome = turnTerminal === 'failed' ? 'failed' : 'interrupted'
  const at = parentBoundary(entry)
  const descendants = reducer.openChildren(parentKey, true).reverse()
  for (const node of descendants) {
    reducer.settle(node.key, node.kind, node.parentKey, outcome, at)
    if (node.kind === 'tool') {
      reducer.diagnose('tool-result-missing', `Tool lifecycle ${node.key} ended without a result.`, node.key, entry.event.seq)
    }
  }
}

export function applyLifecycleEntry(entry: HistoryEntry, reducer: LifecycleReducer): void {
  const event = entry.event
  const at = eventBoundary(entry)
  switch (event.type) {
    case 'turn/start':
      reducer.start(turnLifecycleKey(event.data.turn), 'turn', undefined, at)
      return
    case 'turn/end': {
      const terminal = turnOutcome(entry as HistoryEntry & { event: typeof event })
      settleOpenTurnDescendants(entry, reducer, event.data.turn, terminal.outcome)
      const key = turnLifecycleKey(event.data.turn)
      reducer.settle(key, 'turn', undefined, terminal.outcome, at, terminal.error)
      if (terminal.unknown) {
        reducer.diagnose('unknown-turn-reason', `Turn ${String(event.data.turn)} used an unknown terminal reason.`, key, event.seq)
      }
      return
    }
    case 'step/start':
      reducer.start(
        stepLifecycleKey(event.data.turn, event.data.step),
        'step',
        turnLifecycleKey(event.data.turn),
        at,
      )
      return
    case 'step/end': {
      settleOpenStepChildren(entry, reducer, event.data.turn, event.data.step)
      reducer.settle(
        stepLifecycleKey(event.data.turn, event.data.step),
        'step',
        turnLifecycleKey(event.data.turn),
        'completed',
        at,
      )
      return
    }
    case 'assistant/chunk': {
      const key = thoughtLifecycleKey(event.data.turn, event.data.step)
      const parentKey = stepLifecycleKey(event.data.turn, event.data.step)
      if (event.data.chunk.type === 'reasoning-delta' && event.data.chunk.text !== '') {
        declareStepParent(reducer, event.data.turn, event.data.step)
        reducer.start(key, 'thought', parentKey, at)
      } else if (event.data.chunk.type === 'text-delta' && event.data.chunk.text !== '' && reducer.has(key)) {
        reducer.settle(key, 'thought', parentKey, 'completed', at)
      }
      return
    }
    case 'assistant/message': {
      if (event.surfaceOp !== 'append') return
      const reasoning = textFromContent(event.data.message.content, 'reasoning')
      const answer = textFromContent(event.data.message.content, 'text')
      const key = thoughtLifecycleKey(event.data.turn, event.data.step)
      const parentKey = stepLifecycleKey(event.data.turn, event.data.step)
      if (reasoning !== '') {
        declareStepParent(reducer, event.data.turn, event.data.step)
        reducer.start(key, 'thought', parentKey, at)
      }
      if ((reasoning !== '' || answer !== '') && reducer.has(key)) {
        reducer.settle(key, 'thought', parentKey, 'completed', at)
      }
      return
    }
    case 'tool/call':
      declareStepParent(reducer, event.data.turn, event.data.step)
      reducer.start(
        toolLifecycleKey(String(event.data.callId)),
        'tool',
        stepLifecycleKey(event.data.turn, event.data.step),
        at,
      )
      return
    case 'tool/result': {
      declareStepParent(reducer, event.data.turn, event.data.step)
      const key = toolLifecycleKey(String(event.data.message.source.callId))
      const parentKey = stepLifecycleKey(event.data.turn, event.data.step)
      const failed = toolResultFailed(entry)
      reducer.settle(
        key,
        'tool',
        parentKey,
        failed ? 'failed' : 'completed',
        at,
        failed ? { message: event.data.error?.name ?? 'Tool execution failed.', ...event.data.error?.code === undefined ? {} : { code: event.data.error.code } } : undefined,
      )
      return
    }
    case 'command/run':
      reducer.start(commandLifecycleKey(String(event.data.commandId)), 'command', undefined, at)
      return
    case 'command/done':
      reducer.settle(
        commandLifecycleKey(String(event.data.commandId)),
        'command',
        undefined,
        event.data.kind === 'error' ? 'failed' : 'completed',
        at,
        event.data.kind === 'error' ? { message: event.data.text ?? 'Command failed.' } : undefined,
      )
      return
    case 'user/message': {
      const source = event.data.source
      if (isAcceptedPromptEvent(event)) {
        const parentKey = reducer.openNodes().findLast(node => node.kind === 'turn')?.key
        const key = promptLifecycleKey(String(event.data.id))
        reducer.start(key, 'prompt', parentKey, at)
        reducer.settle(key, 'prompt', parentKey, 'completed', at)
        return
      }
      if (source.kind !== 'community-vision') return
      const key = visionLifecycleKey(source.analysisId)
      const parentKey = promptLifecycleKey(source.promptId)
      const started: LifecycleBoundary = {
        time: Math.max(0, event.time - source.durationMs),
        source: 'event',
      }
      reducer.start(key, 'vision', parentKey, started)
      reducer.settle(key, 'vision', parentKey, 'completed', at)
      return
    }
    default:
      return
  }
}

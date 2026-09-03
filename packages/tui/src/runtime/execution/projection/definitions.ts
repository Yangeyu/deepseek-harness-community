import type { HistoryEntry } from '../../session/contracts.ts'
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@vascent/deepseek-harness-vision'
import {
  commandExecutionKey,
  promptExecutionKey,
  stepExecutionKey,
  thoughtExecutionKey,
  toolExecutionKey,
  turnExecutionKey,
  visionExecutionKey,
} from './keys.ts'
import { isAcceptedPromptEvent } from './host.ts'
import { ExecutionReducer } from './reducer.ts'
import type { ExecutionBoundary, ExecutionError, ExecutionOutcome } from './types.ts'

function eventBoundary(entry: HistoryEntry): ExecutionBoundary {
  return { seq: entry.event.seq, time: entry.event.time, source: 'event' }
}

function parentBoundary(entry: HistoryEntry): ExecutionBoundary {
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

function declareStepParent(reducer: ExecutionReducer, turn: number, step: number): void {
  reducer.declare(
    stepExecutionKey(turn, step),
    'step',
    turnExecutionKey(turn),
  )
}

function turnOutcome(entry: HistoryEntry & { event: Extract<HistoryEntry['event'], { type: 'turn/end' }> }): {
  outcome: ExecutionOutcome
  error?: ExecutionError
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

function settleOpenStepChildren(entry: HistoryEntry, reducer: ExecutionReducer, turn: number, step: number): void {
  const parentKey = stepExecutionKey(turn, step)
  const at = parentBoundary(entry)
  for (const node of reducer.openChildren(parentKey)) {
    if (node.kind === 'thought') {
      reducer.settle(node.key, node.kind, node.parentKey, 'completed', at)
      continue
    }
    if (node.kind === 'tool') {
      reducer.settle(node.key, node.kind, node.parentKey, 'interrupted', at)
      reducer.diagnose('tool-result-missing', `Tool execution ${node.key} ended without a result.`, node.key, entry.event.seq)
    }
  }
}

function settleOpenTurnDescendants(
  entry: HistoryEntry,
  reducer: ExecutionReducer,
  turn: number,
  turnTerminal: ExecutionOutcome,
): void {
  const parentKey = turnExecutionKey(turn)
  const outcome = turnTerminal === 'failed' ? 'failed' : 'interrupted'
  const at = parentBoundary(entry)
  const descendants = reducer.openChildren(parentKey, true).reverse()
  for (const node of descendants) {
    reducer.settle(node.key, node.kind, node.parentKey, outcome, at)
    if (node.kind === 'tool') {
      reducer.diagnose('tool-result-missing', `Tool execution ${node.key} ended without a result.`, node.key, entry.event.seq)
    }
  }
}

export function applyExecutionEntry(entry: HistoryEntry, reducer: ExecutionReducer): void {
  const event = entry.event
  const at = eventBoundary(entry)
  switch (event.type) {
    case 'turn/start':
      reducer.start(turnExecutionKey(event.data.turn), 'turn', undefined, at)
      return
    case 'turn/end': {
      const terminal = turnOutcome(entry as HistoryEntry & { event: typeof event })
      settleOpenTurnDescendants(entry, reducer, event.data.turn, terminal.outcome)
      const key = turnExecutionKey(event.data.turn)
      reducer.settle(key, 'turn', undefined, terminal.outcome, at, terminal.error)
      if (terminal.unknown) {
        reducer.diagnose('unknown-turn-reason', `Turn ${String(event.data.turn)} used an unknown terminal reason.`, key, event.seq)
      }
      return
    }
    case 'step/start':
      reducer.start(
        stepExecutionKey(event.data.turn, event.data.step),
        'step',
        turnExecutionKey(event.data.turn),
        at,
      )
      return
    case 'step/end': {
      settleOpenStepChildren(entry, reducer, event.data.turn, event.data.step)
      reducer.settle(
        stepExecutionKey(event.data.turn, event.data.step),
        'step',
        turnExecutionKey(event.data.turn),
        'completed',
        at,
      )
      return
    }
    case 'assistant/chunk': {
      const key = thoughtExecutionKey(event.data.turn, event.data.step)
      const parentKey = stepExecutionKey(event.data.turn, event.data.step)
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
      const key = thoughtExecutionKey(event.data.turn, event.data.step)
      const parentKey = stepExecutionKey(event.data.turn, event.data.step)
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
        toolExecutionKey(String(event.data.callId)),
        'tool',
        stepExecutionKey(event.data.turn, event.data.step),
        at,
      )
      return
    case 'tool/result': {
      declareStepParent(reducer, event.data.turn, event.data.step)
      const key = toolExecutionKey(String(event.data.message.source.callId))
      const parentKey = stepExecutionKey(event.data.turn, event.data.step)
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
      reducer.start(commandExecutionKey(String(event.data.commandId)), 'command', undefined, at)
      return
    case 'command/done':
      reducer.settle(
        commandExecutionKey(String(event.data.commandId)),
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
        const key = promptExecutionKey(String(event.data.id))
        reducer.start(key, 'prompt', parentKey, at)
        reducer.settle(key, 'prompt', parentKey, 'completed', at)
        return
      }
      if (source.kind !== 'community-vision') return
      const key = visionExecutionKey(source.analysisId)
      const parentKey = promptExecutionKey(source.promptId)
      const started: ExecutionBoundary = {
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

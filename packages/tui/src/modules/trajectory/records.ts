import type { HistoryEntry } from '../../runtime/session/contracts.ts'
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@vascent/deepseek-harness-vision'
import { displayUnknown, sanitizeTerminalLine } from '../../presentation/primitives/text.ts'
import { messageLabel } from './message-label.ts'
import {
  commandExecutionKey,
  executionStatus,
  executionEndedAt,
  executionStartedAt,
  promptExecutionKey,
  stepExecutionKey,
  thoughtExecutionKey,
  toolExecutionKey,
  turnExecutionKey,
  visionExecutionKey,
  type ExecutionStatus,
  type ExecutionNode,
  type ExecutionSnapshot,
  type ModelRequestAvailability,
} from '../../runtime/execution/projection/index.ts'

export type TrajectoryKind = 'turn' | 'step' | 'user' | 'thinking' | 'assistant' | 'tool' | 'command' | 'vision' | 'context' | 'event'
export type TrajectoryPresentationTone = 'warning' | 'info'
export type TrajectoryStatus = ExecutionStatus | TrajectoryPresentationTone

interface TrajectoryRecordBase {
  key: string
  kind: TrajectoryKind
  type: string
  completionType?: string
  seq: number
  completionSeq?: number
  turn?: number
  step?: number
  title: string
  /** Stable callable identity; title remains the human-readable operation. */
  toolName?: string
  summary: string
  detail?: string
  payload?: unknown
  requestDocument?: ModelRequestAvailability
  result?: unknown
  schema?: unknown
}

export interface TrajectoryExecutionRecord extends TrajectoryRecordBase {
  execution: ExecutionNode
}

export interface TrajectoryEventRecord extends TrajectoryRecordBase {
  tone: TrajectoryPresentationTone
  occurredAt: number
}

export type TrajectoryRecord = TrajectoryExecutionRecord | TrajectoryEventRecord

export interface TrajectoryRecordTiming {
  status: TrajectoryStatus
  startedAt?: number
  completedAt?: number
}

export function trajectoryTiming(record: TrajectoryRecord): TrajectoryRecordTiming {
  if ('execution' in record) {
    const startedAt = executionStartedAt(record.execution)
    const completedAt = executionEndedAt(record.execution)
    return {
      status: executionStatus(record.execution),
      ...startedAt === undefined ? {} : { startedAt },
      ...completedAt === undefined ? {} : { completedAt },
    }
  }
  return { status: record.tone, startedAt: record.occurredAt }
}

/** Use execution topology for executions and semantic location only for informational records. */
export function trajectoryParentKey(record: TrajectoryRecord): string | undefined {
  if ('execution' in record) return record.execution.parentKey
  if (record.turn === undefined) return undefined
  return record.step === undefined
    ? String(turnExecutionKey(record.turn))
    : String(stepExecutionKey(record.turn, record.step))
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function numericField(value: unknown, field: string): number | undefined {
  const candidate = recordValue(value)?.[field]
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined
}

function position(entry: HistoryEntry): Pick<TrajectoryRecordBase, 'turn' | 'step'> {
  const turn = numericField(entry.event.data, 'turn')
  const step = numericField(entry.event.data, 'step')
  return {
    ...turn === undefined ? {} : { turn },
    ...step === undefined ? {} : { step },
  }
}

function locatedPosition(
  entry: HistoryEntry,
  activeTurn: number | undefined,
  activeStep: number | undefined,
): Pick<TrajectoryRecordBase, 'turn' | 'step'> {
  const explicit = position(entry)
  const turn = explicit.turn ?? activeTurn
  const step = explicit.step ?? activeStep
  return {
    ...turn === undefined ? {} : { turn },
    ...step === undefined ? {} : { step },
  }
}

type MessageTextKind = 'text' | 'reasoning'

function contentText(value: unknown, kind: MessageTextKind): string {
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const item of value) {
    const block = recordValue(item)
    if (block === undefined) continue
    if (block.type === kind && typeof block.text === 'string') parts.push(block.text)
    const nested = contentText(block.content, kind)
    if (nested !== '') parts.push(nested)
  }
  return parts.join('\n')
}

function messageText(value: unknown, kind: MessageTextKind = 'text'): string {
  return contentText(recordValue(value)?.content, kind)
}

function oneLine(value: string, maximum = 140): string {
  const normalized = sanitizeTerminalLine(value)
  if (normalized.length <= maximum) return normalized
  return `${normalized.slice(0, Math.max(1, maximum - 1))}…`
}

function parsedJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function resultTitle(entry: HistoryEntry | undefined): string | undefined {
  return entry?.view?.for === 'result' ? entry.view.view.title : undefined
}

function callTitle(entry: HistoryEntry): string | undefined {
  return entry.view?.for === 'call' ? entry.view.view.title : undefined
}

function toolResult(entry: HistoryEntry | undefined): unknown {
  if (entry?.event.type !== 'tool/result') return undefined
  const text = messageText(entry.event.data.message)
  if (entry.event.data.error === undefined) return text === '' ? entry.event.data.message.content : text
  return {
    error: entry.event.data.error,
    ...text === '' ? { content: entry.event.data.message.content } : { content: text },
  }
}

function toolSchemaMap(entry: HistoryEntry): Map<string, unknown> | undefined {
  if (entry.event.type !== 'request/header') return undefined
  const schemas = new Map<string, unknown>()
  for (const tool of entry.event.data.header.tools ?? []) schemas.set(tool.name, tool)
  return schemas
}

function settledEntry(node: ExecutionNode, execution: ExecutionSnapshot): HistoryEntry | undefined {
  return node.state.phase === 'settled' ? execution.entry(node.state.ended.seq) : undefined
}

function completionFields(node: ExecutionNode, execution: ExecutionSnapshot): {
  completionType?: string
  completionSeq?: number
} {
  const completed = settledEntry(node, execution)
  return completed === undefined
    ? {}
    : { completionType: completed.event.type, completionSeq: completed.event.seq }
}

function stateWord(node: ExecutionNode): string {
  const status = executionStatus(node)
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function trajectoryKind(node: ExecutionNode): TrajectoryKind {
  switch (node.kind) {
    case 'turn': return 'turn'
    case 'prompt': return 'user'
    case 'step': return 'step'
    case 'tool': return 'tool'
    case 'command': return 'command'
    case 'vision': return 'vision'
    case 'thought': return 'thinking'
  }
}

function executionRecord(
  node: ExecutionNode,
  values: Omit<TrajectoryExecutionRecord, 'key' | 'kind' | 'execution'>,
): TrajectoryExecutionRecord {
  return { ...values, key: String(node.key), kind: trajectoryKind(node), execution: node }
}

function stepModelDetails(
  node: ExecutionNode,
  execution: ExecutionSnapshot,
): Pick<TrajectoryRecordBase, 'requestDocument' | 'result' | 'schema'> {
  const call = execution.modelCall(node.key)
  const event = execution.entry(call?.responseSeq)?.event
  const result = event?.type === 'assistant/message' ? event.data : undefined
  const schema = call?.request?.header?.tools
  return {
    requestDocument: execution.requestDocument(node.key),
    ...result === undefined ? {} : { result },
    ...schema === undefined ? {} : { schema },
  }
}

/** Build presentation records by joining payloads to the one execution snapshot. */
export function buildTrajectoryRecords(
  entries: readonly HistoryEntry[],
  execution: ExecutionSnapshot,
): TrajectoryRecord[] {
  let schemas = new Map<string, unknown>()
  let activeTurn: number | undefined
  let activeStep: number | undefined
  const records: TrajectoryRecord[] = []

  for (const entry of entries) {
    const event = entry.event
    if (event.type === 'turn/start') {
      activeTurn = event.data.turn
      activeStep = undefined
    }
    if (event.type === 'step/start') {
      activeTurn = event.data.turn
      activeStep = event.data.step
    }
    const at = locatedPosition(entry, activeTurn, activeStep)
    const schemaSnapshot = toolSchemaMap(entry)
    if (schemaSnapshot !== undefined) schemas = schemaSnapshot

    switch (event.type) {
      case 'turn/end': {
        const node = execution.get(turnExecutionKey(event.data.turn))
        if (node?.state.phase !== 'settled' || node.state.started !== undefined) break
        records.push(executionRecord(node, {
          type: event.type,
          seq: event.seq,
          turn: event.data.turn,
          title: `Turn ${String(event.data.turn)}`,
          summary: stateWord(node),
          result: event.data.reason,
          payload: event.data,
        }))
        break
      }
      case 'step/end': {
        const node = execution.get(stepExecutionKey(event.data.turn, event.data.step))
        if (node?.state.phase !== 'settled' || node.state.started !== undefined) break
        records.push(executionRecord(node, {
          type: event.type,
          seq: event.seq,
          turn: event.data.turn,
          step: event.data.step,
          title: `Step ${String(event.data.step)}`,
          summary: stateWord(node),
          ...stepModelDetails(node, execution),
        }))
        break
      }
      case 'tool/result': {
        const node = execution.get(toolExecutionKey(String(event.data.message.source.callId)))
        if (node?.state.phase !== 'settled' || node.state.started !== undefined) break
        records.push(executionRecord(node, {
          type: event.type,
          seq: event.seq,
          turn: event.data.turn,
          step: event.data.step,
          title: resultTitle(entry) ?? 'Tool completion',
          summary: stateWord(node),
          result: toolResult(entry),
          payload: event.data,
        }))
        break
      }
      case 'command/done': {
        const node = execution.get(commandExecutionKey(String(event.data.commandId)))
        if (node?.state.phase !== 'settled' || node.state.started !== undefined) break
        const detail = event.data.text ?? `${event.data.kind} command completion`
        records.push(executionRecord(node, {
          type: event.type,
          seq: event.seq,
          title: 'Command completion',
          summary: oneLine(detail),
          detail,
          result: event.data,
        }))
        break
      }
      case 'turn/start': {
        const node = execution.get(turnExecutionKey(event.data.turn))
        if (node === undefined) break
        const completed = settledEntry(node, execution)
        const reason = completed?.event.type === 'turn/end' ? completed.event.data.reason : undefined
        const reasonKind = recordValue(reason)?.kind
        records.push(executionRecord(node, {
          type: event.type,
          ...completionFields(node, execution),
          seq: event.seq,
          turn: event.data.turn,
          title: `Turn ${String(event.data.turn)}`,
          summary: reason === undefined
            ? stateWord(node)
            : `Finished · ${typeof reasonKind === 'string' ? reasonKind : executionStatus(node)}`,
          ...reason === undefined ? {} : { result: reason },
          payload: event.data,
        }))
        break
      }
      case 'step/start': {
        const node = execution.get(stepExecutionKey(event.data.turn, event.data.step))
        if (node === undefined) break
        records.push(executionRecord(node, {
          type: event.type,
          ...completionFields(node, execution),
          seq: event.seq,
          turn: event.data.turn,
          step: event.data.step,
          title: `Step ${String(event.data.step)}`,
          summary: stateWord(node),
          ...stepModelDetails(node, execution),
        }))
        break
      }
      case 'user/message': {
        const text = messageText(event.data)
        const source = event.data.source
        const detail = text === '' ? displayUnknown(event.data.content) : text
        if (source.kind === 'community-vision') {
          const node = execution.get(visionExecutionKey(source.analysisId))
          if (node === undefined) break
          records.push(executionRecord(node, {
            type: event.type,
            seq: event.seq,
            ...at,
            title: 'Vision analysis',
            summary: `${source.provider}/${source.model} · ${stateWord(node)}`,
            detail,
            payload: {
              analysisId: source.analysisId,
              route: { strategy: 'proxy', provider: source.provider, model: source.model },
              images: source.attachments,
            },
            result: {
              observation: detail,
              truncated: source.truncated,
              finishReason: source.finishReason,
              ...source.usage === undefined ? {} : { usage: source.usage },
            },
          }))
          break
        }
        if (source.kind === 'user') {
          const node = execution.get(promptExecutionKey(String(event.data.id)))
          const input = {
            type: event.type,
            seq: event.seq,
            ...at,
            ...messageLabel(event.data),
            detail,
            payload: event.data,
          }
          records.push(node === undefined
            ? { key: `event:${String(event.seq)}`, kind: 'user', tone: 'info', occurredAt: event.time, ...input }
            : executionRecord(node, input))
          break
        }
        records.push({
          key: `event:${String(event.seq)}`,
          kind: 'context',
          type: event.type,
          seq: event.seq,
          ...at,
          ...messageLabel(event.data),
          detail,
          tone: 'info',
          occurredAt: event.time,
          payload: event.data,
        })
        break
      }
      case 'assistant/message': {
        if (event.surfaceOp !== 'append') break
        const reasoning = messageText(event.data.message, 'reasoning')
        const thought = execution.get(thoughtExecutionKey(event.data.turn, event.data.step))
        if (reasoning !== '' && thought !== undefined) {
          records.push(executionRecord(thought, {
            type: event.type,
            ...completionFields(thought, execution),
            seq: event.seq,
            turn: event.data.turn,
            step: event.data.step,
            title: 'Thinking',
            summary: oneLine(reasoning),
            detail: reasoning,
            result: reasoning,
          }))
        }
        const text = messageText(event.data.message)
        if (text.trim() === '') break
        records.push({
          key: `event:${String(event.seq)}`,
          kind: 'assistant',
          type: event.type,
          seq: event.seq,
          turn: event.data.turn,
          step: event.data.step,
          title: 'Assistant response',
          summary: oneLine(text),
          detail: text,
          tone: 'info',
          occurredAt: event.time,
          payload: { source: event.data.message.source },
          result: {
            content: text,
            ...event.data.usage === undefined ? {} : { usage: event.data.usage },
          },
        })
        break
      }
      case 'tool/call': {
        const node = execution.get(toolExecutionKey(String(event.data.callId)))
        if (node === undefined) break
        const completed = settledEntry(node, execution)
        const result = completed?.event.type === 'tool/result' ? completed : undefined
        const displayTitle = resultTitle(result) ?? callTitle(entry) ?? event.data.name
        records.push(executionRecord(node, {
          type: event.type,
          ...completionFields(node, execution),
          seq: event.seq,
          turn: event.data.turn,
          step: event.data.step,
          title: displayTitle,
          toolName: event.data.name,
          summary: stateWord(node),
          ...result === undefined ? {} : { result: toolResult(result) },
          payload: {
            callId: event.data.callId,
            name: event.data.name,
            arguments: parsedJson(event.data.arguments),
          },
          ...schemas.get(event.data.name) === undefined ? {} : { schema: schemas.get(event.data.name) },
        }))
        break
      }
      case 'command/run': {
        const node = execution.get(commandExecutionKey(String(event.data.commandId)))
        if (node === undefined) break
        const completed = settledEntry(node, execution)
        const result = completed?.event.type === 'command/done' ? completed.event.data : undefined
        const commandLine = `/${event.data.name}${event.data.args ?? ''}`
        const detail = result?.text ?? commandLine
        records.push(executionRecord(node, {
          type: event.type,
          ...completionFields(node, execution),
          seq: event.seq,
          title: `/${event.data.name}`,
          summary: result?.text === undefined
            ? stateWord(node)
            : `${stateWord(node)} · ${oneLine(result.text)}`,
          detail,
          ...result === undefined ? {} : { result },
          payload: {
            commandId: event.data.commandId,
            name: event.data.name,
            ...event.data.args === undefined ? {} : { arguments: event.data.args },
            source: event.data.source,
          },
        }))
        break
      }
      case 'request/header':
      case 'request/context':
        break
      default: {
        const detail = displayUnknown(event.data)
        records.push({
          key: `event:${String(event.seq)}`,
          kind: event.type === 'todo/write' ? 'context' : 'event',
          type: event.type,
          seq: event.seq,
          ...at,
          title: event.type,
          summary: oneLine(detail),
          detail,
          tone: 'info',
          occurredAt: event.time,
          payload: event.data,
        })
      }
    }
    if (event.type === 'step/end'
      && activeTurn === event.data.turn
      && activeStep === event.data.step) activeStep = undefined
    if (event.type === 'turn/end' && activeTurn === event.data.turn) {
      activeStep = undefined
      activeTurn = undefined
    }
  }
  return records
}

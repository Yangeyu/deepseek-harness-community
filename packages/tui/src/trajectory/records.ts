import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@vascent/deepseek-harness-vision'
import { displayUnknown, sanitizeTerminalText } from '../text.ts'
import {
  commandLifecycleKey,
  executionStatus,
  lifecycleEndedAt,
  lifecycleStartedAt,
  promptLifecycleKey,
  stepLifecycleKey,
  toolLifecycleKey,
  turnLifecycleKey,
  visionLifecycleKey,
  type ExecutionStatus,
  type LifecycleNode,
  type LifecycleSnapshot,
} from '../runtime/lifecycle/index.ts'

export type TrajectoryKind = 'turn' | 'step' | 'user' | 'request' | 'assistant' | 'tool' | 'command' | 'vision' | 'context' | 'event'
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
  result?: unknown
  schema?: unknown
}

export interface TrajectoryExecutionRecord extends TrajectoryRecordBase {
  lifecycle: LifecycleNode
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
  if ('lifecycle' in record) {
    const startedAt = lifecycleStartedAt(record.lifecycle)
    const completedAt = lifecycleEndedAt(record.lifecycle)
    return {
      status: executionStatus(record.lifecycle),
      ...startedAt === undefined ? {} : { startedAt },
      ...completedAt === undefined ? {} : { completedAt },
    }
  }
  return { status: record.tone, startedAt: record.occurredAt }
}

/** Use lifecycle topology for executions and semantic location only for informational records. */
export function trajectoryParentKey(record: TrajectoryRecord): string | undefined {
  if ('lifecycle' in record) return record.lifecycle.parentKey
  if (record.turn === undefined) return undefined
  return record.step === undefined
    ? String(turnLifecycleKey(record.turn))
    : String(stepLifecycleKey(record.turn, record.step))
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

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const item of value) {
    const block = recordValue(item)
    if (block === undefined) continue
    if (typeof block.text === 'string') parts.push(block.text)
    if (Array.isArray(block.content)) {
      const nested = contentText(block.content)
      if (nested !== '') parts.push(nested)
    }
  }
  return parts.join('\n')
}

function messageText(value: unknown): string {
  return contentText(recordValue(value)?.content)
}

function oneLine(value: string, maximum = 140): string {
  const normalized = sanitizeTerminalText(value).replaceAll(/\s+/gu, ' ').trim()
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

function settledEntry(node: LifecycleNode, lifecycle: LifecycleSnapshot): HistoryEntry | undefined {
  return node.state.phase === 'settled' ? lifecycle.entry(node.state.ended.seq) : undefined
}

function completionFields(node: LifecycleNode, lifecycle: LifecycleSnapshot): {
  completionType?: string
  completionSeq?: number
} {
  const completed = settledEntry(node, lifecycle)
  return completed === undefined
    ? {}
    : { completionType: completed.event.type, completionSeq: completed.event.seq }
}

function stateWord(node: LifecycleNode): string {
  const status = executionStatus(node)
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function trajectoryKind(node: LifecycleNode): TrajectoryKind {
  switch (node.kind) {
    case 'turn': return 'turn'
    case 'prompt': return 'user'
    case 'step': return 'step'
    case 'tool': return 'tool'
    case 'command': return 'command'
    case 'vision': return 'vision'
    case 'thought': throw new Error('Thought lifecycle nodes belong to the transcript, not the trajectory ledger')
  }
}

function executionRecord(
  node: LifecycleNode,
  values: Omit<TrajectoryExecutionRecord, 'key' | 'kind' | 'lifecycle'>,
): TrajectoryExecutionRecord {
  return { ...values, key: String(node.key), kind: trajectoryKind(node), lifecycle: node }
}

/** Build presentation records by joining payloads to the one lifecycle snapshot. */
export function buildTrajectoryRecords(
  entries: readonly HistoryEntry[],
  lifecycle: LifecycleSnapshot,
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
      case 'assistant/chunk':
        break
      case 'turn/end': {
        const node = lifecycle.get(turnLifecycleKey(event.data.turn))
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
        const node = lifecycle.get(stepLifecycleKey(event.data.turn, event.data.step))
        if (node?.state.phase !== 'settled' || node.state.started !== undefined) break
        records.push(executionRecord(node, {
          type: event.type,
          seq: event.seq,
          turn: event.data.turn,
          step: event.data.step,
          title: `Step ${String(event.data.step)}`,
          summary: stateWord(node),
          result: event.data,
          payload: event.data,
        }))
        break
      }
      case 'tool/result': {
        const node = lifecycle.get(toolLifecycleKey(String(event.data.message.source.callId)))
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
        const node = lifecycle.get(commandLifecycleKey(String(event.data.commandId)))
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
        const node = lifecycle.get(turnLifecycleKey(event.data.turn))
        if (node === undefined) break
        const completed = settledEntry(node, lifecycle)
        const reason = completed?.event.type === 'turn/end' ? completed.event.data.reason : undefined
        const reasonKind = recordValue(reason)?.kind
        records.push(executionRecord(node, {
          type: event.type,
          ...completionFields(node, lifecycle),
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
        const node = lifecycle.get(stepLifecycleKey(event.data.turn, event.data.step))
        if (node === undefined) break
        const completed = settledEntry(node, lifecycle)
        records.push(executionRecord(node, {
          type: event.type,
          ...completionFields(node, lifecycle),
          seq: event.seq,
          turn: event.data.turn,
          step: event.data.step,
          title: `Step ${String(event.data.step)}`,
          summary: stateWord(node),
          ...completed?.event.type === 'step/end' ? { result: completed.event.data } : {},
          payload: event.data,
        }))
        break
      }
      case 'user/message': {
        const text = messageText(event.data)
        const source = event.data.source
        const detail = text === '' ? displayUnknown(event.data.content) : text
        if (source.kind === 'community-vision') {
          const node = lifecycle.get(visionLifecycleKey(source.analysisId))
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
          const node = lifecycle.get(promptLifecycleKey(String(event.data.id)))
          const input = {
            type: event.type,
            seq: event.seq,
            ...at,
            title: 'User input',
            summary: oneLine(detail),
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
          kind: 'user',
          type: event.type,
          seq: event.seq,
          ...at,
          title: 'Context input',
          summary: oneLine(detail),
          detail,
          tone: 'info',
          occurredAt: event.time,
          payload: event.data,
        })
        break
      }
      case 'assistant/message': {
        const text = messageText(event.data.message)
        const detail = text === '' ? '(empty response)' : text
        records.push({
          key: `event:${String(event.seq)}`,
          kind: 'assistant',
          type: event.type,
          seq: event.seq,
          turn: event.data.turn,
          step: event.data.step,
          title: 'Assistant response',
          summary: oneLine(detail),
          detail,
          tone: 'info',
          occurredAt: event.time,
          payload: { source: event.data.message.source },
          result: {
            content: text === '' ? event.data.message.content : text,
            ...event.data.usage === undefined ? {} : { usage: event.data.usage },
          },
        })
        break
      }
      case 'tool/call': {
        const node = lifecycle.get(toolLifecycleKey(String(event.data.callId)))
        if (node === undefined) break
        const completed = settledEntry(node, lifecycle)
        const result = completed?.event.type === 'tool/result' ? completed : undefined
        const displayTitle = resultTitle(result) ?? callTitle(entry) ?? event.data.name
        records.push(executionRecord(node, {
          type: event.type,
          ...completionFields(node, lifecycle),
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
        const node = lifecycle.get(commandLifecycleKey(String(event.data.commandId)))
        if (node === undefined) break
        const completed = settledEntry(node, lifecycle)
        const result = completed?.event.type === 'command/done' ? completed.event.data : undefined
        const commandLine = `/${event.data.name}${event.data.args ?? ''}`
        const detail = result?.text ?? commandLine
        records.push(executionRecord(node, {
          type: event.type,
          ...completionFields(node, lifecycle),
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
      case 'request/header': {
        const config = event.data.header.config
        records.push({
          key: `event:${String(event.seq)}`,
          kind: 'request',
          type: event.type,
          seq: event.seq,
          ...at,
          title: 'Model request',
          summary: `${config.provider}/${config.model}${config.reasoningEffort === undefined ? '' : ` · ${String(config.reasoningEffort)}`}`,
          detail: `Model request to ${config.provider}/${config.model}${config.reasoningEffort === undefined ? '' : ` with ${String(config.reasoningEffort)} reasoning`}`,
          tone: 'info',
          occurredAt: event.time,
          payload: event.data.header,
          ...event.data.header.tools === undefined ? {} : { schema: event.data.header.tools },
        })
        break
      }
      case 'request/context':
        records.push({
          key: `event:${String(event.seq)}`,
          kind: 'context',
          type: event.type,
          seq: event.seq,
          ...at,
          title: 'Request context',
          summary: `${event.data.provider}/${event.data.model}${event.data.contextWindow === undefined ? '' : ` · ${String(event.data.contextWindow)} context`}`,
          detail: `Request context for ${event.data.provider}/${event.data.model}${event.data.contextWindow === undefined ? '' : ` with a ${String(event.data.contextWindow)} token window`}`,
          tone: 'info',
          occurredAt: event.time,
          payload: event.data,
        })
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

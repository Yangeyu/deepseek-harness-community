import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-commands/types'
import { displayUnknown, sanitizeTerminalText } from '../text.ts'

export type TrajectoryKind = 'turn' | 'step' | 'user' | 'request' | 'assistant' | 'tool' | 'command' | 'vision' | 'context' | 'event'
export type TrajectoryStatus = 'pending' | 'completed' | 'warning' | 'failed' | 'info'

/** One semantic execution record assembled from the durable session event log. */
export interface TrajectoryRecord {
  key: string
  kind: TrajectoryKind
  type: string
  completionType?: string
  seq: number
  completionSeq?: number
  turn?: number
  step?: number
  title: string
  /** Compact, single-line preview used only by the execution ledger. */
  summary: string
  /** Complete semantic text shown by the Summary tab. */
  detail?: string
  status: TrajectoryStatus
  startedAt: number
  completedAt?: number
  payload?: unknown
  result?: unknown
  schema?: unknown
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

function position(entry: HistoryEntry): Pick<TrajectoryRecord, 'turn' | 'step'> {
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
): Pick<TrajectoryRecord, 'turn' | 'step'> {
  const explicit = position(entry)
  const turn = explicit.turn ?? activeTurn
  const step = explicit.step ?? activeStep
  return {
    ...turn === undefined ? {} : { turn },
    ...step === undefined ? {} : { step },
  }
}

function stepKey(turn: number, step: number): string {
  return `${String(turn)}:${String(step)}`
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
  if (entry?.view?.for !== 'result') return undefined
  return entry.view.view.title
}

function callTitle(entry: HistoryEntry): string | undefined {
  if (entry.view?.for !== 'call') return undefined
  return entry.view.view.title
}

function turnStatus(reason: unknown): TrajectoryStatus {
  const kind = recordValue(reason)?.kind
  if (kind === 'completed') return 'completed'
  if (kind === 'error') return 'failed'
  return 'warning'
}

function resultFailed(entry: HistoryEntry): boolean {
  if (entry.event.type !== 'tool/result') return false
  const block = entry.event.data.message.content[0]
  return entry.event.data.error !== undefined || block?.isError === true
}

function toolResult(entry: HistoryEntry): unknown {
  if (entry.event.type !== 'tool/result') return undefined
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

/** Pair lifecycle boundaries and tool call/results into an ordered diagnostic ledger. */
export function buildTrajectoryRecords(entries: readonly HistoryEntry[]): TrajectoryRecord[] {
  const turnEnds = new Map<number, HistoryEntry>()
  const stepEnds = new Map<string, HistoryEntry>()
  const stepStarts = new Map<string, HistoryEntry>()
  const toolResults = new Map<string, HistoryEntry>()
  const commandRuns = new Set<string>()
  const commandResults = new Map<string, HistoryEntry>()
  for (const entry of entries) {
    const event = entry.event
    if (event.type === 'turn/end') turnEnds.set(event.data.turn, entry)
    if (event.type === 'step/start') stepStarts.set(stepKey(event.data.turn, event.data.step), entry)
    if (event.type === 'step/end') stepEnds.set(stepKey(event.data.turn, event.data.step), entry)
    if (event.type === 'tool/result') toolResults.set(String(event.data.message.source.callId), entry)
    if (event.type === 'command/run') commandRuns.add(String(event.data.commandId))
    if (event.type === 'command/done') commandResults.set(String(event.data.commandId), entry)
  }

  let schemas = new Map<string, unknown>()
  let activeTurn: number | undefined
  let activeStep: number | undefined
  const records: TrajectoryRecord[] = []
  for (const entry of entries) {
    const event = entry.event
    if (event.type === 'turn/start') activeTurn = event.data.turn
    if (event.type === 'step/start') activeStep = event.data.step
    const at = locatedPosition(entry, activeTurn, activeStep)
    const schemaSnapshot = toolSchemaMap(entry)
    if (schemaSnapshot !== undefined) schemas = schemaSnapshot
    switch (event.type) {
      case 'assistant/chunk':
      case 'turn/end':
      case 'step/end':
      case 'tool/result':
        break
      case 'command/done': {
        if (commandRuns.has(String(event.data.commandId))) break
        const detail = event.data.text ?? `${event.data.kind} command completion`
        records.push({
          key: `command:${String(event.data.commandId)}:${String(event.seq)}`,
          kind: 'command',
          type: event.type,
          seq: event.seq,
          title: 'Command completion',
          summary: oneLine(detail),
          detail,
          status: event.data.kind === 'error' ? 'failed' : 'completed',
          startedAt: event.time,
          result: event.data,
        })
        break
      }
      case 'turn/start': {
        const completed = turnEnds.get(event.data.turn)
        const reason = completed?.event.type === 'turn/end' ? completed.event.data.reason : undefined
        const reasonKind = recordValue(reason)?.kind
        records.push({
          key: `turn:${String(event.data.turn)}:${String(event.seq)}`,
          kind: 'turn',
          type: event.type,
          ...completed === undefined ? {} : { completionType: completed.event.type, completionSeq: completed.event.seq },
          seq: event.seq,
          turn: event.data.turn,
          title: `Turn ${String(event.data.turn)}`,
          summary: completed === undefined ? 'Running' : `Finished · ${typeof reasonKind === 'string' ? reasonKind : 'completed'}`,
          status: completed === undefined ? 'pending' : turnStatus(reason),
          startedAt: event.time,
          ...completed === undefined ? {} : { completedAt: completed.event.time, result: reason },
          payload: event.data,
        })
        break
      }
      case 'step/start': {
        const completed = stepEnds.get(stepKey(event.data.turn, event.data.step))
        records.push({
          key: `step:${String(event.data.turn)}:${String(event.data.step)}:${String(event.seq)}`,
          kind: 'step',
          type: event.type,
          ...completed === undefined ? {} : { completionType: completed.event.type, completionSeq: completed.event.seq },
          seq: event.seq,
          turn: event.data.turn,
          step: event.data.step,
          title: `Step ${String(event.data.step)}`,
          summary: completed === undefined ? 'Running' : 'Completed',
          status: completed === undefined ? 'pending' : 'completed',
          startedAt: event.time,
          ...completed === undefined ? {} : { completedAt: completed.event.time, result: completed.event.data },
          payload: event.data,
        })
        break
      }
      case 'user/message': {
        const text = messageText(event.data)
        const source = event.data.source
        const detail = text === '' ? displayUnknown(event.data.content) : text
        if (source.kind === 'community-vision') {
          records.push({
            key: `vision:${source.analysisId}:${String(event.seq)}`,
            kind: 'vision',
            type: event.type,
            seq: event.seq,
            ...at,
            title: 'Vision analysis',
            summary: `${source.provider}/${source.model} · ${String(source.durationMs)}ms · completed`,
            detail,
            status: 'completed',
            startedAt: Math.max(0, event.time - source.durationMs),
            completedAt: event.time,
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
          })
          break
        }
        records.push({
          key: `event:${String(event.seq)}`,
          kind: 'user',
          type: event.type,
          seq: event.seq,
          ...at,
          title: source.kind === 'user' ? 'User input' : 'Context input',
          summary: oneLine(detail),
          detail,
          status: 'info',
          startedAt: event.time,
          payload: event.data,
        })
        break
      }
      case 'assistant/message': {
        const start = stepStarts.get(stepKey(event.data.turn, event.data.step))
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
          status: 'completed',
          startedAt: start?.event.time ?? event.time,
          completedAt: event.time,
          payload: { source: event.data.message.source },
          result: {
            content: text === '' ? event.data.message.content : text,
            ...event.data.usage === undefined ? {} : { usage: event.data.usage },
          },
        })
        break
      }
      case 'tool/call': {
        const completed = toolResults.get(String(event.data.callId))
        const displayTitle = resultTitle(completed) ?? callTitle(entry) ?? event.data.name
        const failed = completed === undefined ? false : resultFailed(completed)
        records.push({
          key: `tool:${String(event.data.callId)}:${String(event.seq)}`,
          kind: 'tool',
          type: event.type,
          ...completed === undefined ? {} : { completionType: completed.event.type, completionSeq: completed.event.seq },
          seq: event.seq,
          turn: event.data.turn,
          step: event.data.step,
          title: displayTitle,
          summary: `${event.data.name} · ${completed === undefined ? 'Running' : failed ? 'Failed' : 'Completed'}`,
          detail: displayTitle,
          status: completed === undefined ? 'pending' : failed ? 'failed' : 'completed',
          startedAt: event.time,
          ...completed === undefined ? {} : { completedAt: completed.event.time, result: toolResult(completed) },
          payload: {
            callId: event.data.callId,
            name: event.data.name,
            arguments: parsedJson(event.data.arguments),
          },
          ...schemas.get(event.data.name) === undefined ? {} : { schema: schemas.get(event.data.name) },
        })
        break
      }
      case 'command/run': {
        const completed = commandResults.get(String(event.data.commandId))
        const failed = completed?.event.type === 'command/done' && completed.event.data.kind === 'error'
        const result = completed?.event.type === 'command/done' ? completed.event.data : undefined
        const commandLine = `/${event.data.name}${event.data.args ?? ''}`
        const detail = result?.text ?? commandLine
        records.push({
          key: `command:${String(event.data.commandId)}:${String(event.seq)}`,
          kind: 'command',
          type: event.type,
          ...completed === undefined ? {} : { completionType: completed.event.type, completionSeq: completed.event.seq },
          seq: event.seq,
          title: `/${event.data.name}`,
          summary: completed === undefined
            ? 'Running'
            : failed ? `Failed${result?.text === undefined ? '' : ` · ${oneLine(result.text)}`}`
              : `Completed${result?.text === undefined ? '' : ` · ${oneLine(result.text)}`}`,
          detail,
          status: completed === undefined ? 'pending' : failed ? 'failed' : 'completed',
          startedAt: event.time,
          ...completed === undefined ? {} : { completedAt: completed.event.time, result },
          payload: {
            commandId: event.data.commandId,
            name: event.data.name,
            ...event.data.args === undefined ? {} : { arguments: event.data.args },
            source: event.data.source,
          },
        })
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
          status: 'info',
          startedAt: event.time,
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
          status: 'info',
          startedAt: event.time,
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
          status: 'info',
          startedAt: event.time,
          payload: event.data,
        })
      }
    }
    if (event.type === 'step/end') activeStep = undefined
    if (event.type === 'turn/end') {
      activeStep = undefined
      activeTurn = undefined
    }
  }
  return records
}

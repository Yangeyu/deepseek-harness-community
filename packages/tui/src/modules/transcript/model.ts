import type {
  HistoryEntry,
  ToolCallView,
  ToolResultView,
} from '../../runtime/session/contracts.ts'
import type {} from '@deepseek-ai/dsh-commands/types'
import type { RuntimeSessionSnapshot } from '../../runtime/session/snapshot.ts'
import {
  aggregateExecution,
  commandExecutionKey,
  promptExecutionKey,
  thoughtExecutionKey,
  toolExecutionKey,
  visionExecutionKey,
  type ExecutionAggregate,
  type ExecutionNode,
} from '../../runtime/execution/projection/index.ts'
import { promptTextFromContent } from '../../runtime/execution/prompt-text.ts'
import { displayUnknown, sanitizeTerminalLine, sanitizeTerminalText } from '../../presentation/primitives/text.ts'

export type TranscriptTone = 'accent' | 'dim' | 'error' | 'warning'

export interface TranscriptTextItem {
  kind: 'text'
  key: string
  label?: string
  tone?: TranscriptTone
  body?: string
  markdown?: boolean
  dim?: boolean
}

export interface TranscriptPromptItem {
  kind: 'prompt'
  key: string
  body: string
  promptStatus?: string
  execution?: ExecutionNode
}

export interface TranscriptThinkingItem {
  kind: 'thinking'
  key: string
  text: string
  execution: ExecutionNode
}

export interface TranscriptToolItem {
  kind: 'tool'
  key: string
  toolName: string
  operation: string
  execution: ExecutionNode
  arguments?: string
  result?: string
}

export type TranscriptActivityItem = TranscriptThinkingItem | TranscriptToolItem

export interface TranscriptActivityGroup {
  kind: 'activity'
  key: string
  items: readonly TranscriptActivityItem[]
  execution: ExecutionAggregate
}

export interface TranscriptDiffItem {
  kind: 'diff'
  key: string
  title: string
  execution: ExecutionNode
  diffs: Extract<ToolResultView, { card: 'diff' }>['diffs']
}

export type UngroupedTranscriptItem = TranscriptTextItem | TranscriptPromptItem | TranscriptActivityItem | TranscriptDiffItem
export type TranscriptItem = TranscriptTextItem | TranscriptPromptItem | TranscriptActivityGroup | TranscriptDiffItem

function contentStepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

function messageText(content: readonly { type: string; text?: string }[], reasoning: boolean): string {
  return content
    .filter(block => block.type === 'text' || (reasoning && block.type === 'reasoning'))
    .map(block => block.type === 'reasoning' ? `> ${block.text ?? ''}` : block.text ?? '')
    .join('\n')
}

function reasoningText(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text ?? '')
    .join('\n')
}

function toolName(value: string): string {
  const name = sanitizeTerminalLine(value)
  if (name === '') return 'Tool'
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

function toolOperation(
  name: string,
  callView: ToolCallView | undefined,
  resultView: ToolResultView | undefined,
): string {
  const rawInput = callView?.card === 'generic' && typeof callView.rawInput === 'string'
    ? sanitizeTerminalLine(callView.rawInput)
    : undefined
  const resultTitle = resultView?.card === 'terminal'
    ? ''
    : sanitizeTerminalLine(resultView?.title ?? '')
  if (resultTitle !== '' && resultTitle !== rawInput) return resultTitle
  if (callView?.card === 'terminal') {
    const description = sanitizeTerminalLine(callView.description ?? '')
    return description === '' ? name : `${name} · ${description}`
  }
  const callTitle = sanitizeTerminalLine(callView?.title ?? '')
  return callTitle === '' || callTitle === rawInput ? name : callTitle
}

function boundedLines(value: string, limit: number): string {
  const lines = sanitizeTerminalText(value).split('\n')
  if (lines.length <= limit) return lines.join('\n')
  const head = Math.max(1, Math.ceil(limit / 2))
  const tail = Math.max(1, Math.floor(limit / 2))
  return [...lines.slice(0, head), `… ${lines.length - head - tail} lines hidden …`, ...lines.slice(-tail)].join('\n')
}

function toolArguments(value: string, limit: number): string | undefined {
  const clean = sanitizeTerminalText(value).trim()
  if (clean === '') return undefined
  try {
    const parsed = JSON.parse(clean) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length === 0) {
      return undefined
    }
    return boundedLines(displayUnknown(parsed), limit)
  } catch {
    return boundedLines(clean, limit)
  }
}

function rawResultText(entry: HistoryEntry): string {
  if (entry.event.type !== 'tool/result') return ''
  const result = entry.event.data.message.content[0]
  if (result?.type !== 'tool-result') return ''
  return messageText(result.content, true)
}

function resultBody(view: ToolResultView | undefined, fallback: string, limit: number): string {
  if (view === undefined) return boundedLines(fallback, limit)
  switch (view.card) {
    case 'terminal': {
      const status = view.signal !== undefined
        ? `[${view.signal}]`
        : view.exitCode === undefined ? '' : `[exit ${view.exitCode}]`
      return boundedLines([view.output ?? '', status].filter(Boolean).join('\n'), limit)
    }
    case 'diff':
      return boundedLines(view.diffs.flatMap(diff => [
        `--- ${diff.path}`,
        `+++ ${diff.path}`,
        ...diff.oldText === null ? [] : diff.oldText.split('\n').map(line => `- ${line}`),
        ...diff.newText.split('\n').map(line => `+ ${line}`),
      ]).join('\n'), limit)
    case 'search':
      if (view.shape === 'paths') {
        return boundedLines([
          ...view.paths,
          ...view.truncated ? [`… ${view.total - view.paths.length} more results …`] : [],
        ].join('\n'), limit)
      }
      return boundedLines(view.files.flatMap(file => [
        file.path,
        ...file.matches.map(match => `  ${match.lineNumber}: ${match.line}`),
      ]).join('\n'), limit)
    case 'read':
      return boundedLines(view.lines.map(line => `${String(line.number).padStart(4)}  ${line.text}`).join('\n'), limit)
    case 'web':
      if (view.kind === 'fetch') {
        return boundedLines(`${view.statusCode} ${view.url}${view.truncated ? '\n… content truncated …' : ''}`, limit)
      }
      return boundedLines([
        view.answer ?? '',
        ...view.sources.map(source => `- ${source.title ?? source.url} — ${source.url}`),
        ...view.truncated ? ['… sources truncated …'] : [],
      ].filter(Boolean).join('\n'), limit)
    case 'generic':
      return boundedLines(view.content === undefined ? fallback : messageText(view.content, true), limit)
  }
}

function isActivityItem(item: UngroupedTranscriptItem): item is TranscriptActivityItem {
  return item.kind === 'thinking' || item.kind === 'tool'
}

/** Group only adjacent model activity. Any user-visible transcript item is a hard boundary. */
export function groupTranscriptActivity(
  items: readonly UngroupedTranscriptItem[],
): TranscriptItem[] {
  const grouped: TranscriptItem[] = []
  let activity: TranscriptActivityItem[] = []

  const flush = (): void => {
    if (activity.length === 0) return
    const first = activity[0]
    if (first === undefined) return
    grouped.push({
      kind: 'activity',
      key: `activity:${first.key}`,
      items: activity,
      execution: aggregateExecution(activity.map(item => item.execution)),
    })
    activity = []
  }

  for (const item of items) {
    if (isActivityItem(item)) {
      activity.push(item)
      continue
    }
    flush()
    grouped.push(item)
  }
  flush()
  return grouped
}

/** Project durable history only; live output and pending work are composed separately. */
export function buildTranscriptHistory(
  state: Readonly<RuntimeSessionSnapshot>,
  showReasoning: boolean,
  showDetails: boolean,
  maxToolOutputLines: number,
): UngroupedTranscriptItem[] {
  const items: UngroupedTranscriptItem[] = []
  for (const entry of state.events) {
    const event = entry.event
    switch (event.type) {
      case 'user/message': {
        if (event.surfaceOp !== 'append') break
        const source = event.data.source
        const rawText = messageText(event.data.content, showReasoning)
        if (source.kind === 'community-vision') {
          const execution = state.execution.get(visionExecutionKey(source.analysisId))
          if (execution === undefined) break
          const imageCount = source.attachments.length
          items.push({
            kind: 'tool',
            key: String(execution.key),
            toolName: 'Vision',
            operation: `Vision · ${String(imageCount)} image${imageCount === 1 ? '' : 's'} · ${sanitizeTerminalLine(source.model)}`,
            execution,
            arguments: `${String(imageCount)} image${imageCount === 1 ? '' : 's'} · ${source.provider}/${source.model}`,
            result: rawText === '' ? 'Vision analysis completed.' : rawText,
          })
          break
        }
        const human = source.kind === 'user'
        if (!human && !showDetails) break
        if (human) {
          const execution = state.execution.get(promptExecutionKey(String(event.data.id)))
          const text = promptTextFromContent(event.data.content)
          if (text.trim() === '') break
          items.push({
            kind: 'prompt',
            key: `prompt:${String(event.data.id)}`,
            body: text,
            ...execution === undefined ? {} : { execution },
          })
        } else {
          const imageCount = event.data.content.filter(block => block.type === 'image').length
          const text = [rawText, imageCount === 0 ? '' : `${String(imageCount)} image${imageCount === 1 ? '' : 's'} attached`]
            .filter(Boolean)
            .join('\n\n')
          if (text.trim() === '') break
          items.push({
            kind: 'text',
            key: `context:${String(event.data.id)}`,
            label: 'Context',
            tone: 'dim',
            body: text,
            dim: true,
          })
        }
        break
      }
      case 'assistant/message': {
        if (event.surfaceOp !== 'append') {
          items.push({
            kind: 'text',
            key: `compaction:${String(event.seq)}`,
            label: 'Context',
            tone: 'dim',
            body: 'Earlier model context was compacted.',
            dim: true,
          })
          break
        }
        const reasoning = reasoningText(event.data.message.content)
        if (showReasoning && reasoning.trim() !== '') {
          const execution = state.execution.get(thoughtExecutionKey(event.data.turn, event.data.step))
          if (execution !== undefined) {
            items.push({
              kind: 'thinking',
              key: String(execution.key),
              text: reasoning,
              execution,
            })
          }
        }
        const text = messageText(event.data.message.content, false)
        if (text.trim() !== '') {
          items.push({
            kind: 'text',
            key: `assistant:${contentStepKey(event.data.turn, event.data.step)}:text`,
            body: text,
            markdown: true,
          })
        }
        break
      }
      case 'tool/call': {
        const execution = state.execution.get(toolExecutionKey(String(event.data.callId)))
        if (execution === undefined) break
        const callView = entry.view?.for === 'call' ? entry.view.view : undefined
        const result = execution.state.phase === 'settled'
          ? state.execution.entry(execution.state.ended.seq)
          : undefined
        const toolResult = result?.event.type === 'tool/result' ? result : undefined
        const resultView = toolResult?.view?.for === 'result' ? toolResult.view.view : undefined
        const name = toolName(event.data.name)
        const diffView = resultView?.card === 'diff'
          ? resultView
          : toolResult === undefined && callView?.card === 'diff' ? callView : undefined
        if (diffView !== undefined && diffView.diffs.length > 0) {
          items.push({
            kind: 'diff',
            key: `${String(event.data.callId)}:diff`,
            title: sanitizeTerminalLine(resultView?.title ?? callView?.title ?? name),
            execution,
            diffs: diffView.diffs,
          })
          break
        }
        const argumentsBody = toolArguments(event.data.arguments, maxToolOutputLines)
        items.push({
          kind: 'tool',
          key: String(execution.key),
          toolName: name,
          operation: toolOperation(name, callView, resultView),
          execution,
          ...argumentsBody === undefined ? {} : { arguments: argumentsBody },
          ...toolResult === undefined ? {} : { result: resultBody(resultView, rawResultText(toolResult), maxToolOutputLines) },
        })
        break
      }
      case 'command/run': {
        const execution = state.execution.get(commandExecutionKey(String(event.data.commandId)))
        if (execution === undefined) break
        const completed = execution.state.phase === 'settled'
          ? state.execution.entry(execution.state.ended.seq)
          : undefined
        const result = completed?.event.type === 'command/done' ? completed.event.data : undefined
        items.push({
          kind: 'text',
          key: `command:${String(event.data.commandId)}`,
          label: execution.state.phase !== 'settled'
            ? 'Command running'
            : execution.state.outcome === 'failed' ? 'Command failed' : 'Command',
          tone: execution.state.phase !== 'settled'
            ? 'warning'
            : execution.state.outcome === 'failed' ? 'error' : 'accent',
          body: [
            `/${event.data.name}${event.data.args ?? ''}`,
            result?.text,
          ].filter(value => value !== undefined && value !== '').join('\n'),
        })
        break
      }
      case 'command/done': {
        const execution = state.execution.get(commandExecutionKey(String(event.data.commandId)))
        if (execution?.state.phase === 'settled' && execution.state.started === undefined) {
          items.push({
            kind: 'text',
            key: `command:${String(event.data.commandId)}:done`,
            label: event.data.kind === 'error' ? 'Command failed' : 'Command',
            tone: event.data.kind === 'error' ? 'error' : 'accent',
            body: event.data.text ?? `${event.data.kind} command completion`,
          })
        }
        break
      }
      case 'turn/end':
        if (event.data.reason.kind === 'error') {
          items.push({
            kind: 'text',
            key: `turn:${String(event.seq)}:error`,
            label: 'Error',
            tone: 'error',
            body: event.data.reason.error.message,
          })
        } else if (event.data.reason.kind === 'max-tokens') {
          items.push({
            kind: 'text',
            key: `turn:${String(event.seq)}:max-tokens`,
            label: 'Notice',
            tone: 'warning',
            body: 'The response reached the model output limit. Send “continue” to proceed.',
          })
        }
        break
      default:
        break
    }
  }

  return items
}

/** Compose a reusable history projection with the current live tail. */
export function buildTranscriptItems(
  state: Readonly<RuntimeSessionSnapshot>,
  showReasoning: boolean,
  showDetails: boolean,
  maxToolOutputLines: number,
  history = buildTranscriptHistory(state, showReasoning, showDetails, maxToolOutputLines),
): TranscriptItem[] {
  const items = [...history]

  if (state.assistant !== undefined) {
    const assistant = state.assistant
    const reasoning = reasoningText(assistant.content)
    const execution = state.execution.get(thoughtExecutionKey(assistant.turn, assistant.step))
    if (showReasoning && reasoning !== '' && execution !== undefined) {
      items.push({ kind: 'thinking', key: String(execution.key), text: reasoning, execution })
    }
    const text = messageText(assistant.content, false)
    if (text !== '') {
      items.push({ kind: 'text', key: `assistant:${contentStepKey(assistant.turn, assistant.step)}:text`, body: text, markdown: true })
    }
  }

  const grouped = groupTranscriptActivity(items)
  const visibleQueueRequestIds = new Set<string>()
  for (const [index, item] of state.queue.entries()) {
    if (item.placement === 'context') continue
    const body = promptTextFromContent(item.message.content)
    if (body.trim() === '') continue
    if (item.rpcId !== undefined) visibleQueueRequestIds.add(String(item.rpcId))
    grouped.push({
      kind: 'prompt',
      key: `queue:${item.rpcId === undefined ? String(index) : String(item.rpcId)}`,
      body,
      promptStatus: item.placement === 'steering' ? 'Steering next step…' : 'Queued',
    })
  }
  for (const submission of state.pendingSubmissions) {
    const promptVisible = submission.durablePromptObserved === true
      || (submission.requestId !== undefined && visibleQueueRequestIds.has(String(submission.requestId)))
    if (!promptVisible) {
      grouped.push({
        kind: 'prompt',
        key: `pending:${String(submission.key)}`,
        body: submission.text,
        ...submission.intent === 'queueing'
          ? { promptStatus: 'Queueing…' }
          : submission.intent === 'steering'
            ? { promptStatus: 'Steering…' }
            : {},
      })
    }
    if (submission.activity?.kind === 'vision') {
      const execution = state.execution.get(visionExecutionKey(submission.activity.analysisId))
      if (execution === undefined || execution.durability !== 'ephemeral') continue
      const imageCount = submission.activity.imageCount
      grouped.push(...groupTranscriptActivity([{
        kind: 'tool',
        key: String(execution.key),
        toolName: 'Vision',
        operation: `Vision · ${String(imageCount)} image${imageCount === 1 ? '' : 's'} · Analyzing…`,
        execution,
        arguments: `${String(imageCount)} attached image${imageCount === 1 ? '' : 's'}`,
      }]))
    }
  }
  if (state.notice !== undefined) {
    grouped.push({ kind: 'text', key: 'session:notice', label: 'Notice', tone: 'accent', body: state.notice })
  }
  if (state.error !== undefined) {
    grouped.push({ kind: 'text', key: 'session:error', label: 'Error', tone: 'error', body: state.error })
  }
  return grouped
}

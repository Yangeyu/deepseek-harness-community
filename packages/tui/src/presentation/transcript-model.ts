import type {
  HistoryEntry,
  ToolCallView,
  ToolResultView,
} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-commands/types'
import type { TuiState } from '../runtime/controller.ts'
import { displayUnknown, sanitizeTerminalText } from '../text.ts'

export type TranscriptTone = 'accent' | 'dim' | 'error' | 'warning'

export interface TranscriptTextItem {
  kind: 'text'
  label?: string
  tone?: TranscriptTone
  body?: string
  markdown?: boolean
  dim?: boolean
}

export interface TranscriptPromptItem {
  kind: 'prompt'
  body: string
  promptStatus?: string
}

export interface TranscriptThinkingItem {
  kind: 'thinking'
  key: string
  text: string
  streaming: boolean
  startedAt: number
  completedAt?: number
}

export interface TranscriptToolItem {
  kind: 'tool'
  key: string
  title: string
  status: 'pending' | 'completed' | 'failed'
  arguments?: string
  result?: string
  startedAt: number
  completedAt?: number
}

export type TranscriptActivityItem = TranscriptThinkingItem | TranscriptToolItem

export interface TranscriptActivityGroup {
  kind: 'activity'
  key: string
  items: readonly TranscriptActivityItem[]
  status: 'running' | 'completed' | 'failed'
  startedAt: number
  completedAt?: number
}

export interface TranscriptDiffItem {
  kind: 'diff'
  key: string
  title: string
  settled: boolean
  diffs: Extract<ToolResultView, { card: 'diff' }>['diffs']
}

export type UngroupedTranscriptItem = TranscriptTextItem | TranscriptPromptItem | TranscriptActivityItem | TranscriptDiffItem
export type TranscriptItem = TranscriptTextItem | TranscriptPromptItem | TranscriptActivityGroup | TranscriptDiffItem

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

export function formatTranscriptDuration(milliseconds: number): string {
  return milliseconds < 1_000
    ? `${String(milliseconds)}ms`
    : `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`
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

function callTitle(name: string, view: ToolCallView | undefined): string {
  if (view === undefined) return name
  if (view.card === 'terminal') return `$ ${view.title}`
  return view.title
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

function resultTitle(view: ToolResultView | undefined): string | undefined {
  return view?.title
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

function activityStatus(
  items: readonly TranscriptActivityItem[],
  runningTail: boolean,
): TranscriptActivityGroup['status'] {
  if (items.some(item => item.kind === 'tool' && item.status === 'failed')) return 'failed'
  const pending = items.some(item =>
    (item.kind === 'tool' && item.status === 'pending') || (item.kind === 'thinking' && item.streaming))
  if (runningTail || pending) return 'running'
  return 'completed'
}

/** Group only adjacent model activity. Any user-visible transcript item is a hard boundary. */
export function groupTranscriptActivity(
  items: readonly UngroupedTranscriptItem[],
  sessionRunning: boolean,
): TranscriptItem[] {
  const grouped: TranscriptItem[] = []
  let activity: TranscriptActivityItem[] = []

  const flush = (runningTail: boolean): void => {
    if (activity.length === 0) return
    const first = activity[0]
    if (first === undefined) return
    const status = activityStatus(activity, runningTail)
    const completedTimes = activity.map(item => item.completedAt).filter(value => value !== undefined)
    grouped.push({
      kind: 'activity',
      key: `activity:${first.key}`,
      items: activity,
      status,
      startedAt: Math.min(...activity.map(item => item.startedAt)),
      ...status === 'running' || completedTimes.length === 0
        ? {}
        : { completedAt: Math.max(...completedTimes) },
    })
    activity = []
  }

  for (const item of items) {
    if (isActivityItem(item)) {
      activity.push(item)
      continue
    }
    flush(false)
    grouped.push(item)
  }
  flush(sessionRunning)
  return grouped
}

/** Rebuild the visible transcript projection from the current session state. */
export function buildTranscriptItems(
  state: Readonly<TuiState>,
  showReasoning: boolean,
  showDetails: boolean,
  maxToolOutputLines: number,
): TranscriptItem[] {
  const items: UngroupedTranscriptItem[] = []
  const finalSteps = new Set<string>()
  const reasoningStarts = new Map<string, number>()
  const results = new Map<string, HistoryEntry>()
  const commandRuns = new Set<string>()
  const commandResults = new Map<string, HistoryEntry>()
  for (const entry of state.events) {
    const event = entry.event
    if (event.type === 'assistant/message') finalSteps.add(stepKey(event.data.turn, event.data.step))
    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'reasoning-delta') {
      const key = stepKey(event.data.turn, event.data.step)
      if (!reasoningStarts.has(key)) reasoningStarts.set(key, event.time)
    }
    if (event.type === 'tool/result') results.set(String(event.data.message.source.callId), entry)
    if (event.type === 'command/run') commandRuns.add(String(event.data.commandId))
    if (event.type === 'command/done') commandResults.set(String(event.data.commandId), entry)
  }

  const partials = new Map<string, {
    textIndex: number | undefined
    thinkingIndex: number | undefined
    text: string
    reasoning: string
    reasoningStartedAt: number | undefined
  }>()
  for (const entry of state.events) {
    const event = entry.event
    switch (event.type) {
      case 'user/message': {
        if (event.surfaceOp !== 'append') break
        const source = event.data.source
        const rawText = messageText(event.data.content, showReasoning)
        if (source.kind === 'community-vision') {
          const imageCount = source.attachments.length
          items.push({
            kind: 'tool',
            key: `vision:${source.analysisId}`,
            title: `Vision · ${String(imageCount)} image${imageCount === 1 ? '' : 's'} · ${sanitizeTerminalText(source.model)} · ${formatTranscriptDuration(source.durationMs)}`,
            status: 'completed',
            arguments: `${String(imageCount)} image${imageCount === 1 ? '' : 's'} · ${source.provider}/${source.model}`,
            result: rawText === '' ? 'Vision analysis completed.' : rawText,
            startedAt: Math.max(0, event.time - source.durationMs),
            completedAt: event.time,
          })
          break
        }
        const human = source.kind === 'user'
        if (!human && !showDetails) break
        const imageCount = event.data.content.filter(block => block.type === 'image').length
        const text = [rawText, imageCount === 0 ? '' : `${String(imageCount)} image${imageCount === 1 ? '' : 's'} attached`]
          .filter(Boolean)
          .join('\n\n')
        if (text.trim() === '') break
        if (human) {
          items.push({ kind: 'prompt', body: text })
        } else {
          items.push({ kind: 'text', label: 'Context', tone: 'dim', body: text, dim: true })
        }
        break
      }
      case 'assistant/chunk': {
        const key = stepKey(event.data.turn, event.data.step)
        if (finalSteps.has(key)) break
        const chunk = event.data.chunk
        if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') break
        let partial = partials.get(key)
        if (partial === undefined) {
          partial = {
            textIndex: undefined,
            thinkingIndex: undefined,
            text: '',
            reasoning: '',
            reasoningStartedAt: undefined,
          }
          partials.set(key, partial)
        }
        if (chunk.type === 'reasoning-delta') {
          if (!showReasoning) break
          partial.reasoning += chunk.text
          partial.reasoningStartedAt ??= event.time
          if (partial.thinkingIndex === undefined) {
            partial.thinkingIndex = items.length
            items.push({
              kind: 'thinking',
              key: `${key}:thinking`,
              text: '',
              streaming: true,
              startedAt: partial.reasoningStartedAt,
            })
          }
          items[partial.thinkingIndex] = {
            kind: 'thinking',
            key: `${key}:thinking`,
            text: partial.reasoning,
            streaming: true,
            startedAt: partial.reasoningStartedAt,
          }
          break
        }
        partial.text += chunk.text
        if (partial.textIndex === undefined) {
          partial.textIndex = items.length
          items.push({ kind: 'text' })
        }
        items[partial.textIndex] = { kind: 'text', body: partial.text, markdown: true }
        break
      }
      case 'assistant/message': {
        if (event.surfaceOp !== 'append') {
          items.push({ kind: 'text', label: 'Context', tone: 'dim', body: 'Earlier model context was compacted.', dim: true })
          break
        }
        const key = stepKey(event.data.turn, event.data.step)
        const reasoning = reasoningText(event.data.message.content)
        if (showReasoning && reasoning.trim() !== '') {
          items.push({
            kind: 'thinking',
            key: `${key}:thinking`,
            text: reasoning,
            streaming: false,
            startedAt: reasoningStarts.get(key) ?? event.time,
            completedAt: event.time,
          })
        }
        const text = messageText(event.data.message.content, false)
        if (text.trim() !== '') items.push({ kind: 'text', body: text, markdown: true })
        break
      }
      case 'tool/call': {
        const callView = entry.view?.for === 'call' ? entry.view.view : undefined
        const result = results.get(String(event.data.callId))
        const resultView = result?.view?.for === 'result' ? result.view.view : undefined
        const failed = result?.event.type === 'tool/result' && result.event.data.error !== undefined
        const title = resultTitle(resultView) ?? callTitle(event.data.name, callView)
        const diffView = resultView?.card === 'diff'
          ? resultView
          : result === undefined && callView?.card === 'diff' ? callView : undefined
        if (!failed && diffView !== undefined && diffView.diffs.length > 0) {
          items.push({
            kind: 'diff',
            key: `${String(event.data.callId)}:diff`,
            title: sanitizeTerminalText(title),
            settled: result !== undefined,
            diffs: diffView.diffs,
          })
          break
        }
        const argumentsBody = toolArguments(event.data.arguments, maxToolOutputLines)
        items.push({
          kind: 'tool',
          key: `${String(event.data.callId)}:tool`,
          title: sanitizeTerminalText(title),
          status: result === undefined ? 'pending' : failed ? 'failed' : 'completed',
          ...argumentsBody === undefined ? {} : { arguments: argumentsBody },
          ...result === undefined
            ? {}
            : {
                result: resultBody(resultView, rawResultText(result), maxToolOutputLines),
                completedAt: result.event.time,
              },
          startedAt: event.time,
        })
        break
      }
      case 'command/run': {
        const completed = commandResults.get(String(event.data.commandId))
        const result = completed?.event.type === 'command/done' ? completed.event.data : undefined
        const failed = result?.kind === 'error'
        items.push({
          kind: 'text',
          label: failed ? 'Command failed' : result === undefined ? 'Command running' : 'Command',
          tone: failed ? 'error' : result === undefined ? 'warning' : 'accent',
          body: [
            `/${event.data.name}${event.data.args ?? ''}`,
            result?.text,
          ].filter(value => value !== undefined && value !== '').join('\n'),
        })
        break
      }
      case 'command/done':
        if (!commandRuns.has(String(event.data.commandId))) {
          items.push({
            kind: 'text',
            label: event.data.kind === 'error' ? 'Command failed' : 'Command',
            tone: event.data.kind === 'error' ? 'error' : 'accent',
            body: event.data.text ?? `${event.data.kind} command completion`,
          })
        }
        break
      case 'turn/end':
        if (event.data.reason.kind === 'error') {
          items.push({ kind: 'text', label: 'Error', tone: 'error', body: event.data.reason.error.message })
        } else if (event.data.reason.kind === 'max-tokens') {
          items.push({
            kind: 'text',
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

  const grouped = groupTranscriptActivity(items, state.running)
  const visibleQueueRpcIds = new Set<string>()
  for (const item of state.queue) {
    if (item.placement === 'context') continue
    const body = messageText(item.message.content, false)
    if (body.trim() === '') continue
    const source = item.message.source
    if (source.kind === 'user' && 'rpcId' in source) visibleQueueRpcIds.add(String(source.rpcId))
    grouped.push({
      kind: 'prompt',
      body,
      promptStatus: item.placement === 'steering' ? 'Steering next step…' : 'Queued',
    })
  }
  for (const submission of state.pendingSubmissions) {
    const promptVisible = submission.durablePromptObserved === true
      || (submission.rpcId !== undefined && visibleQueueRpcIds.has(String(submission.rpcId)))
    if (!promptVisible) {
      grouped.push({
        kind: 'prompt',
        body: submission.text,
        ...submission.intent === 'queueing'
          ? { promptStatus: 'Queueing…' }
          : submission.intent === 'steering'
            ? { promptStatus: 'Steering…' }
            : {},
      })
    }
    if (submission.activity?.kind === 'vision') {
      const imageCount = submission.activity.imageCount
      const elapsed = formatTranscriptDuration(Math.max(0, Date.now() - submission.activity.startedAt))
      grouped.push(...groupTranscriptActivity([{
        kind: 'tool',
        key: `vision:${submission.activity.analysisId}`,
        title: `Vision · ${String(imageCount)} image${imageCount === 1 ? '' : 's'} · Analyzing… ${elapsed}`,
        status: 'pending',
        arguments: `${String(imageCount)} attached image${imageCount === 1 ? '' : 's'}`,
        startedAt: submission.activity.startedAt,
      }], true))
    }
  }
  if (state.notice !== undefined) grouped.push({ kind: 'text', label: 'Notice', tone: 'accent', body: state.notice })
  if (state.error !== undefined) grouped.push({ kind: 'text', label: 'Error', tone: 'error', body: state.error })
  return grouped
}

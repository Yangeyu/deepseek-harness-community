import type {
  HistoryEntry,
  ToolCallView,
  ToolResultView,
} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-commands/types'
import type { TuiState } from '../runtime/controller.ts'
import {
  aggregateLifecycle,
  commandLifecycleKey,
  thoughtLifecycleKey,
  toolLifecycleKey,
  visionLifecycleKey,
  type LifecycleAggregate,
  type LifecycleNode,
} from '../runtime/lifecycle/index.ts'
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
  lifecycle: LifecycleNode
}

export interface TranscriptToolItem {
  kind: 'tool'
  key: string
  title: string
  lifecycle: LifecycleNode
  arguments?: string
  result?: string
}

export type TranscriptActivityItem = TranscriptThinkingItem | TranscriptToolItem

export interface TranscriptActivityGroup {
  kind: 'activity'
  key: string
  items: readonly TranscriptActivityItem[]
  lifecycle: LifecycleAggregate
}

export interface TranscriptDiffItem {
  kind: 'diff'
  key: string
  title: string
  lifecycle: LifecycleNode
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
      lifecycle: aggregateLifecycle(activity.map(item => item.lifecycle)),
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

/** Rebuild the visible transcript projection from the current session state. */
export function buildTranscriptItems(
  state: Readonly<TuiState>,
  showReasoning: boolean,
  showDetails: boolean,
  maxToolOutputLines: number,
): TranscriptItem[] {
  const items: UngroupedTranscriptItem[] = []
  const finalSteps = new Set<string>()
  for (const entry of state.events) {
    const event = entry.event
    if (event.type === 'assistant/message') finalSteps.add(contentStepKey(event.data.turn, event.data.step))
  }

  const partials = new Map<string, {
    textIndex: number | undefined
    thinkingIndex: number | undefined
    text: string
    reasoning: string
  }>()
  for (const entry of state.events) {
    const event = entry.event
    switch (event.type) {
      case 'user/message': {
        if (event.surfaceOp !== 'append') break
        const source = event.data.source
        const rawText = messageText(event.data.content, showReasoning)
        if (source.kind === 'community-vision') {
          const lifecycle = state.lifecycle.get(visionLifecycleKey(source.analysisId))
          if (lifecycle === undefined) break
          const imageCount = source.attachments.length
          items.push({
            kind: 'tool',
            key: String(lifecycle.key),
            title: `Vision · ${String(imageCount)} image${imageCount === 1 ? '' : 's'} · ${sanitizeTerminalText(source.model)}`,
            lifecycle,
            arguments: `${String(imageCount)} image${imageCount === 1 ? '' : 's'} · ${source.provider}/${source.model}`,
            result: rawText === '' ? 'Vision analysis completed.' : rawText,
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
        const key = contentStepKey(event.data.turn, event.data.step)
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
          }
          partials.set(key, partial)
        }
        if (chunk.type === 'reasoning-delta') {
          if (!showReasoning) break
          partial.reasoning += chunk.text
          const lifecycle = state.lifecycle.get(thoughtLifecycleKey(event.data.turn, event.data.step))
          if (lifecycle === undefined) break
          const thinking: TranscriptThinkingItem = {
            kind: 'thinking',
            key: String(lifecycle.key),
            text: partial.reasoning,
            lifecycle,
          }
          if (partial.thinkingIndex === undefined) {
            partial.thinkingIndex = items.length
            items.push(thinking)
          } else {
            items[partial.thinkingIndex] = thinking
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
        const reasoning = reasoningText(event.data.message.content)
        if (showReasoning && reasoning.trim() !== '') {
          const lifecycle = state.lifecycle.get(thoughtLifecycleKey(event.data.turn, event.data.step))
          if (lifecycle !== undefined) {
            items.push({
              kind: 'thinking',
              key: String(lifecycle.key),
              text: reasoning,
              lifecycle,
            })
          }
        }
        const text = messageText(event.data.message.content, false)
        if (text.trim() !== '') items.push({ kind: 'text', body: text, markdown: true })
        break
      }
      case 'tool/call': {
        const lifecycle = state.lifecycle.get(toolLifecycleKey(String(event.data.callId)))
        if (lifecycle === undefined) break
        const callView = entry.view?.for === 'call' ? entry.view.view : undefined
        const result = lifecycle.state.phase === 'settled'
          ? state.lifecycle.entry(lifecycle.state.ended.seq)
          : undefined
        const toolResult = result?.event.type === 'tool/result' ? result : undefined
        const resultView = toolResult?.view?.for === 'result' ? toolResult.view.view : undefined
        const title = resultTitle(resultView) ?? callTitle(event.data.name, callView)
        const diffView = resultView?.card === 'diff'
          ? resultView
          : toolResult === undefined && callView?.card === 'diff' ? callView : undefined
        if (diffView !== undefined && diffView.diffs.length > 0) {
          items.push({
            kind: 'diff',
            key: `${String(event.data.callId)}:diff`,
            title: sanitizeTerminalText(title),
            lifecycle,
            diffs: diffView.diffs,
          })
          break
        }
        const argumentsBody = toolArguments(event.data.arguments, maxToolOutputLines)
        items.push({
          kind: 'tool',
          key: String(lifecycle.key),
          title: sanitizeTerminalText(title),
          lifecycle,
          ...argumentsBody === undefined ? {} : { arguments: argumentsBody },
          ...toolResult === undefined ? {} : { result: resultBody(resultView, rawResultText(toolResult), maxToolOutputLines) },
        })
        break
      }
      case 'command/run': {
        const lifecycle = state.lifecycle.get(commandLifecycleKey(String(event.data.commandId)))
        if (lifecycle === undefined) break
        const completed = lifecycle.state.phase === 'settled'
          ? state.lifecycle.entry(lifecycle.state.ended.seq)
          : undefined
        const result = completed?.event.type === 'command/done' ? completed.event.data : undefined
        items.push({
          kind: 'text',
          label: lifecycle.state.phase !== 'settled'
            ? 'Command running'
            : lifecycle.state.outcome === 'failed' ? 'Command failed' : 'Command',
          tone: lifecycle.state.phase !== 'settled'
            ? 'warning'
            : lifecycle.state.outcome === 'failed' ? 'error' : 'accent',
          body: [
            `/${event.data.name}${event.data.args ?? ''}`,
            result?.text,
          ].filter(value => value !== undefined && value !== '').join('\n'),
        })
        break
      }
      case 'command/done': {
        const lifecycle = state.lifecycle.get(commandLifecycleKey(String(event.data.commandId)))
        if (lifecycle?.state.phase === 'settled' && lifecycle.state.started === undefined) {
          items.push({
            kind: 'text',
            label: event.data.kind === 'error' ? 'Command failed' : 'Command',
            tone: event.data.kind === 'error' ? 'error' : 'accent',
            body: event.data.text ?? `${event.data.kind} command completion`,
          })
        }
        break
      }
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

  const grouped = groupTranscriptActivity(items)
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
      const lifecycle = state.lifecycle.get(visionLifecycleKey(submission.activity.analysisId))
      if (lifecycle === undefined || lifecycle.durability !== 'ephemeral') continue
      const imageCount = submission.activity.imageCount
      grouped.push(...groupTranscriptActivity([{
        kind: 'tool',
        key: String(lifecycle.key),
        title: `Vision · ${String(imageCount)} image${imageCount === 1 ? '' : 's'} · Analyzing…`,
        lifecycle,
        arguments: `${String(imageCount)} attached image${imageCount === 1 ? '' : 's'}`,
      }]))
    }
  }
  if (state.notice !== undefined) grouped.push({ kind: 'text', label: 'Notice', tone: 'accent', body: state.notice })
  if (state.error !== undefined) grouped.push({ kind: 'text', label: 'Error', tone: 'error', body: state.error })
  return grouped
}

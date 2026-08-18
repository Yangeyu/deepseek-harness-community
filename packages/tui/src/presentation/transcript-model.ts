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
  promptLifecycleKey,
  thoughtLifecycleKey,
  toolLifecycleKey,
  visionLifecycleKey,
  type LifecycleAggregate,
  type LifecycleNode,
  type LifecycleSnapshot,
} from '../runtime/lifecycle/index.ts'
import { legacyPromptTextFromContent } from '../prompt-content.ts'
import { displayUnknown, sanitizeTerminalLine, sanitizeTerminalText } from '../text.ts'

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
  lifecycle?: LifecycleNode
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
  toolName: string
  operation: string
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

function runtimeTail(item: TranscriptItem): boolean {
  if (item.kind === 'prompt') return item.key.startsWith('queue:') || item.key.startsWith('pending:')
  if (item.kind === 'text') return item.key.startsWith('session:')
  return item.kind === 'activity' && item.items.some(child => child.lifecycle.durability === 'ephemeral')
}

function insertBeforeRuntimeTail(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  const index = items.findIndex(runtimeTail)
  const next = [...items]
  next.splice(index < 0 ? next.length : index, 0, item)
  return next
}

function refreshThought(
  items: TranscriptItem[],
  key: string,
  lifecycle: LifecycleSnapshot,
  appendText?: string,
): { items: TranscriptItem[]; found: boolean } {
  const node = lifecycle.get(key)
  if (node === undefined) return { items, found: false }
  const index = items.findIndex(item => item.kind === 'activity' && item.items.some(child => child.key === key))
  if (index < 0) return { items, found: false }
  const activity = items[index]
  if (activity?.kind !== 'activity') return { items, found: false }
  const children = activity.items.map(child => child.key === key && child.kind === 'thinking'
    ? { ...child, text: `${child.text}${appendText ?? ''}`, lifecycle: node }
    : child)
  const next = [...items]
  next[index] = { ...activity, items: children, lifecycle: aggregateLifecycle(children.map(child => child.lifecycle)) }
  return { items: next, found: true }
}

function appendThinking(
  items: TranscriptItem[],
  thinking: TranscriptThinkingItem,
): TranscriptItem[] {
  const tailIndex = items.findIndex(runtimeTail)
  const insertion = tailIndex < 0 ? items.length : tailIndex
  const previous = items[insertion - 1]
  if (previous?.kind !== 'activity') {
    return insertBeforeRuntimeTail(items, {
      kind: 'activity',
      key: `activity:${thinking.key}`,
      items: [thinking],
      lifecycle: aggregateLifecycle([thinking.lifecycle]),
    })
  }
  const children = [...previous.items, thinking]
  const next = [...items]
  next[insertion - 1] = {
    ...previous,
    items: children,
    lifecycle: aggregateLifecycle(children.map(child => child.lifecycle)),
  }
  return next
}

/** Increment the live transcript tail without replaying the durable event window. */
export function appendTranscriptChunks(
  current: TranscriptItem[],
  entries: readonly HistoryEntry[],
  lifecycle: LifecycleSnapshot,
  showReasoning: boolean,
): TranscriptItem[] | undefined {
  if (!entries.every(entry => entry.event.type === 'assistant/chunk')) return undefined
  let items = current
  for (const entry of entries) {
    if (entry.event.type !== 'assistant/chunk') return undefined
    const event = entry.event
    const chunk = event.data.chunk
    const step = contentStepKey(event.data.turn, event.data.step)
    const thoughtKey = String(thoughtLifecycleKey(event.data.turn, event.data.step))
    if (chunk.type === 'reasoning-delta' && chunk.text !== '') {
      if (!showReasoning) continue
      const refreshed = refreshThought(items, thoughtKey, lifecycle, chunk.text)
      if (refreshed.found) {
        items = refreshed.items
        continue
      }
      const node = lifecycle.get(thoughtKey)
      if (node !== undefined) {
        items = appendThinking(items, { kind: 'thinking', key: thoughtKey, text: chunk.text, lifecycle: node })
      }
      continue
    }
    if (chunk.type !== 'text-delta' || chunk.text === '') continue
    items = refreshThought(items, thoughtKey, lifecycle).items
    const textKey = `assistant:${step}:text`
    const textIndex = items.findIndex(item => item.kind === 'text' && item.key === textKey)
    if (textIndex < 0) {
      items = insertBeforeRuntimeTail(items, {
        kind: 'text', key: textKey, body: chunk.text, markdown: true,
      })
      continue
    }
    const text = items[textIndex]
    if (text?.kind !== 'text') continue
    const next = [...items]
    next[textIndex] = { ...text, body: `${text.body ?? ''}${chunk.text}` }
    items = next
  }
  return items
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
            toolName: 'Vision',
            operation: `Vision · ${String(imageCount)} image${imageCount === 1 ? '' : 's'} · ${sanitizeTerminalLine(source.model)}`,
            lifecycle,
            arguments: `${String(imageCount)} image${imageCount === 1 ? '' : 's'} · ${source.provider}/${source.model}`,
            result: rawText === '' ? 'Vision analysis completed.' : rawText,
          })
          break
        }
        const human = source.kind === 'user'
        if (!human && !showDetails) break
        if (human) {
          const lifecycle = state.lifecycle.get(promptLifecycleKey(String(event.data.id)))
          const text = legacyPromptTextFromContent(event.data.content)
          if (text.trim() === '') break
          items.push({
            kind: 'prompt',
            key: `prompt:${String(event.data.id)}`,
            body: text,
            ...lifecycle === undefined ? {} : { lifecycle },
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
          items.push({ kind: 'text', key: `assistant:${key}:text` })
        }
        items[partial.textIndex] = {
          kind: 'text',
          key: `assistant:${key}:text`,
          body: partial.text,
          markdown: true,
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
        const lifecycle = state.lifecycle.get(toolLifecycleKey(String(event.data.callId)))
        if (lifecycle === undefined) break
        const callView = entry.view?.for === 'call' ? entry.view.view : undefined
        const result = lifecycle.state.phase === 'settled'
          ? state.lifecycle.entry(lifecycle.state.ended.seq)
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
            lifecycle,
            diffs: diffView.diffs,
          })
          break
        }
        const argumentsBody = toolArguments(event.data.arguments, maxToolOutputLines)
        items.push({
          kind: 'tool',
          key: String(lifecycle.key),
          toolName: name,
          operation: toolOperation(name, callView, resultView),
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
          key: `command:${String(event.data.commandId)}`,
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

  const grouped = groupTranscriptActivity(items)
  const visibleQueueRpcIds = new Set<string>()
  for (const [index, item] of state.queue.entries()) {
    if (item.placement === 'context') continue
    const body = legacyPromptTextFromContent(item.message.content)
    if (body.trim() === '') continue
    const source = item.message.source
    if (source.kind === 'user' && 'rpcId' in source) visibleQueueRpcIds.add(String(source.rpcId))
    grouped.push({
      kind: 'prompt',
      key: `queue:${source.kind === 'user' && 'rpcId' in source ? String(source.rpcId) : String(index)}`,
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
      const lifecycle = state.lifecycle.get(visionLifecycleKey(submission.activity.analysisId))
      if (lifecycle === undefined || lifecycle.durability !== 'ephemeral') continue
      const imageCount = submission.activity.imageCount
      grouped.push(...groupTranscriptActivity([{
        kind: 'tool',
        key: String(lifecycle.key),
        toolName: 'Vision',
        operation: `Vision · ${String(imageCount)} image${imageCount === 1 ? '' : 's'} · Analyzing…`,
        lifecycle,
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

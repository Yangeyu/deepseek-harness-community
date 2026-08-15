import {
  Markdown,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui'
import type {
  HistoryEntry,
  ToolCallView,
  ToolResultView,
} from '@deepseek-ai/dsh-host-apiproxy'
import type { TuiState } from './controller.ts'
import { displayUnknown, sanitizeTerminalText } from './text.ts'
import type { TuiTheme } from './theme.ts'

interface TranscriptRow {
  label?: string
  labelPaint?: (text: string) => string
  body?: string
  markdown?: boolean
  dim?: boolean
  prompt?: boolean
}

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

function messageText(content: readonly { type: string; text?: string }[], reasoning: boolean): string {
  return content
    .filter(block => block.type === 'text' || (reasoning && block.type === 'reasoning'))
    .map(block => block.type === 'reasoning' ? `> ${block.text ?? ''}` : block.text ?? '')
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

function rowsFromState(
  state: Readonly<TuiState>,
  theme: TuiTheme,
  showReasoning: boolean,
  showDetails: boolean,
  maxToolOutputLines: number,
): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  const finalSteps = new Set<string>()
  const results = new Map<string, HistoryEntry>()
  for (const entry of state.events) {
    const event = entry.event
    if (event.type === 'assistant/message') finalSteps.add(stepKey(event.data.turn, event.data.step))
    if (event.type === 'tool/result') results.set(String(event.data.message.source.callId), entry)
  }

  const partials = new Map<string, { index: number; text: string; reasoning: string }>()
  for (const entry of state.events) {
    const event = entry.event
    switch (event.type) {
      case 'user/message': {
        if (event.surfaceOp !== 'append') break
        const human = event.data.source.kind === 'user'
        if (!human && !showDetails) break
        const text = messageText(event.data.content, showReasoning)
        if (text.trim() === '') break
        rows.push({
          ...human ? { prompt: true } : { label: 'Context', labelPaint: theme.dim },
          body: text,
          markdown: human,
          dim: !human,
        })
        break
      }
      case 'assistant/chunk': {
        const key = stepKey(event.data.turn, event.data.step)
        if (finalSteps.has(key)) break
        const chunk = event.data.chunk
        if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') break
        let partial = partials.get(key)
        if (partial === undefined) {
          partial = { index: rows.length, text: '', reasoning: '' }
          partials.set(key, partial)
          rows.push({ body: '', markdown: true })
        }
        if (chunk.type === 'text-delta') partial.text += chunk.text
        else partial.reasoning += chunk.text
        rows[partial.index] = {
          body: [showReasoning && partial.reasoning !== '' ? `> ${partial.reasoning}` : '', partial.text]
            .filter(Boolean)
            .join('\n'),
          markdown: true,
        }
        break
      }
      case 'assistant/message': {
        if (event.surfaceOp !== 'append') {
          rows.push({ label: 'Context', labelPaint: theme.dim, body: 'Earlier model context was compacted.', dim: true })
          break
        }
        const text = messageText(event.data.message.content, showReasoning)
        if (text.trim() !== '') {
          rows.push({ body: text, markdown: true })
        }
        break
      }
      case 'tool/call': {
        const callView = entry.view?.for === 'call' ? entry.view.view : undefined
        const result = results.get(String(event.data.callId))
        const resultView = result?.view?.for === 'result' ? result.view.view : undefined
        const failed = result?.event.type === 'tool/result' && result.event.data.error !== undefined
        const title = resultTitle(resultView) ?? callTitle(event.data.name, callView)
        const body = result === undefined
          ? showDetails ? displayUnknown(event.data.arguments) : undefined
          : showDetails ? resultBody(resultView, rawResultText(result), maxToolOutputLines) : undefined
        rows.push({
          label: `${result === undefined ? '○' : failed ? '×' : '●'} ${sanitizeTerminalText(title)}`,
          labelPaint: result === undefined ? theme.warning : failed ? theme.error : theme.success,
          ...body === undefined || body === '' ? {} : { body, dim: true },
        })
        break
      }
      case 'turn/end':
        if (event.data.reason.kind === 'error') {
          rows.push({
            label: 'Error',
            labelPaint: theme.error,
            body: event.data.reason.error.message,
          })
        } else if (event.data.reason.kind === 'max-tokens') {
          rows.push({
            label: 'Notice',
            labelPaint: theme.warning,
            body: 'The response reached the model output limit. Send “continue” to proceed.',
          })
        }
        break
      default:
        break
    }
  }

  if (state.queue.length > 0) {
    rows.push({
      label: `Queued · ${state.queue.length}`,
      labelPaint: theme.warning,
      body: state.queue.map(item => messageText(item.message.content, false)).filter(Boolean).join('\n'),
      dim: true,
    })
  }
  if (state.notice !== undefined) rows.push({ label: 'Notice', labelPaint: theme.accent, body: state.notice })
  if (state.error !== undefined) rows.push({ label: 'Error', labelPaint: theme.error, body: state.error })
  return rows
}

/** Scrollback-first transcript component rebuilt from the current API event window. */
export class TranscriptComponent implements Component {
  private state: Readonly<TuiState>
  private showDetails = false

  constructor(
    state: Readonly<TuiState>,
    private readonly theme: TuiTheme,
    private readonly showReasoning: boolean,
    private readonly maxToolOutputLines: number,
  ) {
    this.state = state
  }

  setState(state: Readonly<TuiState>): void {
    this.state = state
  }

  setDetails(show: boolean): void {
    this.showDetails = show
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    const lines: string[] = []
    const rows = rowsFromState(
      this.state,
      this.theme,
      this.showReasoning,
      this.showDetails,
      this.maxToolOutputLines,
    )
    for (const [index, row] of rows.entries()) {
      if (index > 0) lines.push('')
      if (row.prompt && row.body !== undefined) {
        let firstLine = true
        for (const sourceLine of sanitizeTerminalText(row.body).split('\n')) {
          const wrapped = wrapTextWithAnsi(sourceLine, Math.max(1, safeWidth - 2))
          for (const wrappedLine of wrapped.length === 0 ? [''] : wrapped) {
            const marker = firstLine ? `${this.theme.bold('›')} ` : '  '
            lines.push(truncateToWidth(`${marker}${wrappedLine}`, safeWidth))
            firstLine = false
          }
        }
        continue
      }
      if (row.label !== undefined) {
        lines.push(truncateToWidth((row.labelPaint ?? (text => text))(row.label), safeWidth))
      }
      if (row.body === undefined || row.body === '') continue
      const body = sanitizeTerminalText(row.body)
      if (row.markdown) {
        const markdown = new Markdown(body, 0, 0, this.theme.markdown, row.dim ? { color: this.theme.dim } : undefined)
        lines.push(...markdown.render(safeWidth))
      } else {
        const styled = row.dim ? this.theme.dim(body) : body
        lines.push(...wrapTextWithAnsi(styled, safeWidth))
      }
    }
    return lines
  }
}

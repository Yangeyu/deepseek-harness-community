import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui'
import type {
  HistoryEntry,
  ToolCallView,
  ToolResultView,
} from '@deepseek-ai/dsh-host-apiproxy'
import type { TuiState } from './controller.ts'
import type { DiffLineStarts } from './diff-location.ts'
import {
  buildDiffDisplay,
  diffSummary,
  highlightDiffText,
  type DiffDisplayLine,
} from './diff.ts'
import { displayUnknown, sanitizeTerminalText } from './text.ts'
import type { TuiTheme } from './theme.ts'

interface TranscriptRow {
  label?: string
  labelPaint?: (text: string) => string
  body?: string
  markdown?: boolean
  dim?: boolean
  prompt?: boolean
  promptStatus?: string
  thinking?: {
    key: string
    text: string
    streaming: boolean
  }
  diff?: {
    key: string
    title: string
    settled: boolean
    diffs: Extract<ToolResultView, { card: 'diff' }>['diffs']
  }
}

interface BlockHit {
  key: string
  kind: 'thinking' | 'diff'
  titleLine: number
  firstLine: number
  lastLine: number
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
          partial = { textIndex: undefined, thinkingIndex: undefined, text: '', reasoning: '' }
          partials.set(key, partial)
        }
        if (chunk.type === 'reasoning-delta') {
          if (!showReasoning) break
          partial.reasoning += chunk.text
          if (partial.thinkingIndex === undefined) {
            partial.thinkingIndex = rows.length
            rows.push({})
          }
          rows[partial.thinkingIndex] = {
            thinking: { key: `${key}:thinking`, text: partial.reasoning, streaming: true },
          }
          break
        }
        partial.text += chunk.text
        if (partial.textIndex === undefined) {
          partial.textIndex = rows.length
          rows.push({})
        }
        rows[partial.textIndex] = { body: partial.text, markdown: true }
        break
      }
      case 'assistant/message': {
        if (event.surfaceOp !== 'append') {
          rows.push({ label: 'Context', labelPaint: theme.dim, body: 'Earlier model context was compacted.', dim: true })
          break
        }
        const reasoning = reasoningText(event.data.message.content)
        if (showReasoning && reasoning.trim() !== '') {
          rows.push({
            thinking: { key: `${stepKey(event.data.turn, event.data.step)}:thinking`, text: reasoning, streaming: false },
          })
        }
        const text = messageText(event.data.message.content, false)
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
        const diffView = resultView?.card === 'diff'
          ? resultView
          : result === undefined && callView?.card === 'diff' ? callView : undefined
        if (!failed && diffView !== undefined && diffView.diffs.length > 0) {
          rows.push({
            diff: {
              key: `${String(event.data.callId)}:diff`,
              title: sanitizeTerminalText(title),
              settled: result !== undefined,
              diffs: diffView.diffs,
            },
          })
          break
        }
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

  const visibleQueueRpcIds = new Set<string>()
  for (const item of state.queue) {
    if (item.placement === 'context') continue
    const body = messageText(item.message.content, false)
    if (body.trim() === '') continue
    const source = item.message.source
    if (source.kind === 'user' && 'rpcId' in source) visibleQueueRpcIds.add(String(source.rpcId))
    rows.push({
      prompt: true,
      body,
      promptStatus: item.placement === 'steering' ? 'Steering next step…' : 'Queued',
    })
  }
  for (const submission of state.pendingSubmissions) {
    if (submission.rpcId !== undefined && visibleQueueRpcIds.has(String(submission.rpcId))) continue
    rows.push({
      prompt: true,
      body: submission.text,
      ...submission.intent === 'queueing'
        ? { promptStatus: 'Queueing…' }
        : submission.intent === 'steering'
          ? { promptStatus: 'Steering…' }
          : {},
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
  private readonly expandedThinking = new Set<string>()
  private readonly collapsedDiffs = new Set<string>()
  private readonly followingThinking = new Set<string>()
  private readonly blockOffsets = new Map<string, number>()
  private readonly blockMaxOffsets = new Map<string, number>()
  private blockHits: BlockHit[] = []
  private hoveredBlockKey: string | undefined
  private diffLineStarts: DiffLineStarts = new Map()

  constructor(
    state: Readonly<TuiState>,
    private readonly theme: TuiTheme,
    private readonly showReasoning: boolean,
    private readonly maxToolOutputLines: number,
    private readonly thinkingMaxLines = 8,
  ) {
    this.state = state
  }

  setState(state: Readonly<TuiState>): void {
    if (state.sessionId !== this.state.sessionId) {
      this.expandedThinking.clear()
      this.collapsedDiffs.clear()
      this.followingThinking.clear()
      this.blockOffsets.clear()
      this.blockMaxOffsets.clear()
      this.hoveredBlockKey = undefined
    }
    this.state = state
  }

  setDetails(show: boolean): void {
    this.showDetails = show
  }

  /** Supply asynchronously resolved absolute file-line starts for diff cards. */
  setDiffLineStarts(starts: DiffLineStarts): void {
    this.diffLineStarts = starts
  }

  invalidate(): void {}

  /** Apply one pointer action to the block rendered at a transcript-relative row. */
  handlePointer(line: number, action: 'move' | 'click' | 'wheel-up' | 'wheel-down'): boolean {
    const hit = this.blockHits.find(candidate => line >= candidate.firstLine && line <= candidate.lastLine)
    if (action === 'move') {
      const next = hit?.titleLine === line ? hit.key : undefined
      if (next === this.hoveredBlockKey) return false
      this.hoveredBlockKey = next
      return true
    }
    if (action === 'click') {
      if (hit === undefined || hit.titleLine !== line) return false
      this.hoveredBlockKey = hit.key
      if (hit.kind === 'thinking') {
        if (this.expandedThinking.delete(hit.key)) {
          this.followingThinking.delete(hit.key)
          this.blockOffsets.delete(hit.key)
        } else {
          this.expandedThinking.add(hit.key)
          this.followingThinking.add(hit.key)
        }
      } else if (!this.collapsedDiffs.delete(hit.key)) {
        this.collapsedDiffs.add(hit.key)
        this.blockOffsets.delete(hit.key)
      }
      return true
    }
    if (hit === undefined || (hit.kind === 'thinking' && !this.expandedThinking.has(hit.key)) ||
      (hit.kind === 'diff' && this.collapsedDiffs.has(hit.key))) return false
    return this.scrollBlock(hit.key, action === 'wheel-up' ? -3 : 3, hit.kind === 'thinking')
  }

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
    this.blockHits = []
    for (const [index, row] of rows.entries()) {
      if (index > 0) lines.push('')
      if (row.thinking !== undefined) {
        this.pushBlock(lines, this.renderThinking(row.thinking, safeWidth), row.thinking.key, 'thinking')
        continue
      }
      if (row.diff !== undefined) {
        this.pushBlock(lines, this.renderDiff(row.diff, safeWidth), row.diff.key, 'diff')
        continue
      }
      if (row.prompt && row.body !== undefined) {
        lines.push(...this.renderPromptBlock(row.body, row.promptStatus, safeWidth))
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
    if (this.hoveredBlockKey !== undefined && !this.blockHits.some(hit => hit.key === this.hoveredBlockKey)) {
      this.hoveredBlockKey = undefined
    }
    return lines
  }

  private renderPromptBlock(body: string, status: string | undefined, width: number): string[] {
    const paintLine = (line: string): string => {
      const clipped = truncateToWidth(line, width, '…')
      const padding = ' '.repeat(Math.max(0, width - visibleWidth(clipped)))
      return this.theme.userBlock(`${clipped}${padding}`)
    }
    const lines = [paintLine(' '.repeat(width))]
    let firstLine = true
    for (const sourceLine of sanitizeTerminalText(body).split('\n')) {
      const wrapped = wrapTextWithAnsi(sourceLine, Math.max(1, width - 4))
      for (const wrappedLine of wrapped.length === 0 ? [''] : wrapped) {
        const marker = firstLine ? '› ' : '  '
        lines.push(paintLine(` ${this.theme.user(`${marker}${wrappedLine}`)} `))
        firstLine = false
      }
    }
    if (status !== undefined) lines.push(paintLine(`   ${this.theme.dim(this.theme.user(status))} `))
    lines.push(paintLine(' '.repeat(width)))
    return lines
  }

  private pushBlock(lines: string[], rendered: string[], key: string, kind: BlockHit['kind']): void {
    const titleLine = lines.length
    lines.push(...rendered)
    this.blockHits.push({ key, kind, titleLine, firstLine: titleLine, lastLine: lines.length - 1 })
  }

  private renderThinking(
    thinking: NonNullable<TranscriptRow['thinking']>,
    width: number,
  ): string[] {
    const expanded = this.expandedThinking.has(thinking.key)
    const marker = expanded ? '▾' : '▸'
    const label = thinking.streaming ? 'Thinking…' : 'Thought'
    if (!expanded) return [this.renderBlockTitle(`${marker} ${label}`, thinking.key, width, this.theme.reasoning)]

    const contentWidth = Math.max(1, width - 2)
    const content = new Markdown(
      sanitizeTerminalText(thinking.text),
      0,
      0,
      this.theme.markdown,
      { color: this.theme.reasoning },
    ).render(contentWidth)
    const { offset, maxOffset } = this.resolveBlockOffset(
      thinking.key,
      content.length,
      this.thinkingMaxLines,
      thinking.streaming && this.followingThinking.has(thinking.key),
    )
    const visible = content.slice(offset, offset + this.thinkingMaxLines)
    const range = maxOffset === 0 ? '' : ` · ${offset + 1}-${Math.min(content.length, offset + this.thinkingMaxLines)}/${content.length}`
    return [
      this.renderBlockTitle(`${marker} ${label}${range}`, thinking.key, width, this.theme.reasoning),
      ...visible.map(line => truncateToWidth(`${this.theme.reasoning('│')} ${line}`, width)),
    ]
  }

  private renderDiff(diff: NonNullable<TranscriptRow['diff']>, width: number): string[] {
    const model = buildDiffDisplay(diff.title, diff.diffs, this.diffLineStarts.get(diff.key) ?? [])
    const collapsed = this.collapsedDiffs.has(diff.key)
    const title = this.renderDiffTitle(model.operation, model.target, diff.settled, collapsed, diff.key, width)
    if (collapsed) return [title]
    const { offset } = this.resolveBlockOffset(diff.key, model.lines.length, this.maxToolOutputLines, false)
    const visible = model.lines.slice(offset, offset + this.maxToolOutputLines)
    const numberWidth = Math.max(2, ...model.lines.map(line => String(line.number ?? '').length))
    return [
      title,
      truncateToWidth(this.theme.dim(`  └ ${diffSummary(model.added, model.removed)}`), width),
      ...visible.map(line => this.renderDiffLine(line, width, numberWidth)),
    ]
  }

  private renderDiffTitle(
    operation: string,
    target: string,
    settled: boolean,
    collapsed: boolean,
    key: string,
    width: number,
  ): string {
    const marker = collapsed ? '▸ ' : ''
    const cleanOperation = sanitizeTerminalText(operation)
    const cleanTarget = sanitizeTerminalText(target)
    const status = settled ? '●' : '○'
    const plain = `${marker}${status} ${cleanOperation}(${cleanTarget})`
    if (this.hoveredBlockKey === key) return this.theme.hover(truncateToWidth(plain, width, '…'))
    return truncateToWidth([
      marker,
      (settled ? this.theme.success : this.theme.warning)(status),
      ` ${this.theme.assistant(cleanOperation)}(`,
      this.theme.underline(cleanTarget),
      ')',
    ].join(''), width, '…')
  }

  private renderDiffLine(line: DiffDisplayLine, width: number, numberWidth: number): string {
    switch (line.kind) {
      case 'file': return truncateToWidth(this.theme.bold(`  ${sanitizeTerminalText(line.text)}`), width)
      case 'gap': return truncateToWidth(this.theme.dim('  ⋯'), width)
      case 'context': {
        const prefix = this.theme.dim(`${String(line.number ?? '').padStart(numberWidth)}   `)
        const code = highlightDiffText(sanitizeTerminalText(line.text), line.path, this.theme)
        return truncateToWidth(`${prefix}${code}`, width, '…')
      }
      case 'del': {
        const prefix = this.theme.error(`${String(line.number ?? '').padStart(numberWidth)} - `)
        const code = highlightDiffText(sanitizeTerminalText(line.text), line.path, this.theme)
        return this.theme.diffRemoved(truncateToWidth(`${prefix}${code}`, width, '…', true))
      }
      case 'add': {
        const prefix = this.theme.success(`${String(line.number ?? '').padStart(numberWidth)} + `)
        const code = highlightDiffText(sanitizeTerminalText(line.text), line.path, this.theme)
        return this.theme.diffAdded(truncateToWidth(`${prefix}${code}`, width, '…', true))
      }
    }
  }

  private renderBlockTitle(title: string, key: string, width: number, paint: (text: string) => string): string {
    const text = truncateToWidth(sanitizeTerminalText(title), width, '…')
    return this.hoveredBlockKey === key
      ? this.theme.hover(text)
      : paint(text)
  }

  private resolveBlockOffset(key: string, lines: number, limit: number, follow: boolean): { offset: number; maxOffset: number } {
    const maxOffset = Math.max(0, lines - limit)
    this.blockMaxOffsets.set(key, maxOffset)
    const offset = follow ? maxOffset : Math.max(0, Math.min(maxOffset, this.blockOffsets.get(key) ?? 0))
    this.blockOffsets.set(key, offset)
    return { offset, maxOffset }
  }

  private scrollBlock(key: string, delta: number, thinking: boolean): boolean {
    const maxOffset = this.blockMaxOffsets.get(key) ?? 0
    const current = this.blockOffsets.get(key) ?? 0
    const next = Math.max(0, Math.min(maxOffset, current + delta))
    if (next === current) return false
    this.blockOffsets.set(key, next)
    if (thinking) {
      if (next === maxOffset && delta > 0) this.followingThinking.add(key)
      else if (delta < 0) this.followingThinking.delete(key)
    }
    return true
  }
}

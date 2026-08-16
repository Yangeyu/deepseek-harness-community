import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui'
import type { TuiState } from '../runtime/controller.ts'
import type { DiffLineStarts } from './diff-location.ts'
import {
  buildDiffDisplay,
  diffSummary,
  highlightDiffText,
  type DiffDisplayLine,
} from './diff.ts'
import {
  buildTranscriptItems,
  formatTranscriptDuration,
  type TranscriptActivityGroup,
  type TranscriptDiffItem,
  type TranscriptTextItem,
  type TranscriptThinkingItem,
  type TranscriptTone,
  type TranscriptToolItem,
} from './transcript-model.ts'
import { sanitizeTerminalText } from '../text.ts'
import type { TuiTheme } from './theme.ts'

interface BlockHit {
  key: string
  kind: 'activity' | 'thinking' | 'tool' | 'diff'
  titleLine: number
  firstLine: number
  lastLine: number
}

const DIFF_CONTENT_INDENT = '  '
const ACTIVITY_CHILD_INDENT = 3
const DISCLOSURE_COLLAPSED = '›'
const DISCLOSURE_EXPANDED = '⌄'

function padToWidth(value: string, width: number): string {
  const clipped = truncateToWidth(value, width, '…', true)
  return `${clipped}${' '.repeat(Math.max(0, width - visibleWidth(clipped)))}`
}

/** Scrollback-first transcript component rebuilt from the current API event window. */
export class TranscriptComponent implements Component {
  private state: Readonly<TuiState>
  private showDetails = false
  private readonly activityExpansion = new Map<string, boolean>()
  private readonly activityStatuses = new Map<string, TranscriptActivityGroup['status']>()
  private readonly failedActivities = new Set<string>()
  private readonly failedTools = new Set<string>()
  private readonly expandedThinking = new Set<string>()
  private readonly toolExpansion = new Map<string, boolean>()
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
      this.activityExpansion.clear()
      this.activityStatuses.clear()
      this.failedActivities.clear()
      this.failedTools.clear()
      this.expandedThinking.clear()
      this.toolExpansion.clear()
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
    this.activityExpansion.clear()
    this.toolExpansion.clear()
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
      if (hit.kind === 'activity') {
        this.activityExpansion.set(hit.key, !this.isActivityExpanded(hit.key))
      } else if (hit.kind === 'thinking') {
        if (this.expandedThinking.delete(hit.key)) {
          this.followingThinking.delete(hit.key)
          this.blockOffsets.delete(hit.key)
        } else {
          this.expandedThinking.add(hit.key)
          this.followingThinking.add(hit.key)
        }
      } else if (hit.kind === 'tool') {
        this.toolExpansion.set(hit.key, !this.isToolExpanded(hit.key))
      } else if (!this.collapsedDiffs.delete(hit.key)) {
        this.collapsedDiffs.add(hit.key)
        this.blockOffsets.delete(hit.key)
      }
      return true
    }
    if (hit === undefined || hit.kind === 'activity' || hit.kind === 'tool' ||
      (hit.kind === 'thinking' && !this.expandedThinking.has(hit.key)) ||
      (hit.kind === 'diff' && this.collapsedDiffs.has(hit.key))) return false
    return this.scrollBlock(hit.key, action === 'wheel-up' ? -3 : 3, hit.kind === 'thinking')
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    const lines: string[] = []
    const items = buildTranscriptItems(
      this.state,
      this.showReasoning,
      this.showDetails,
      this.maxToolOutputLines,
    )
    this.blockHits = []
    this.failedActivities.clear()
    this.failedTools.clear()
    const nextActivityStatuses = new Map<string, TranscriptActivityGroup['status']>()
    for (const item of items) {
      if (item.kind !== 'activity') continue
      if (item.status === 'failed') {
        this.failedActivities.add(item.key)
        if (this.activityStatuses.get(item.key) !== 'failed') this.activityExpansion.delete(item.key)
      }
      nextActivityStatuses.set(item.key, item.status)
    }
    this.activityStatuses.clear()
    for (const [key, status] of nextActivityStatuses) this.activityStatuses.set(key, status)
    for (const [index, item] of items.entries()) {
      if (index > 0) lines.push('')
      if (item.kind === 'activity') {
        this.renderActivity(lines, item, safeWidth)
        continue
      }
      if (item.kind === 'diff') {
        const contentWidth = this.contentWidth(safeWidth)
        this.pushBlock(
          lines,
          this.frameContent(this.renderDiff(item, contentWidth), safeWidth),
          item.key,
          'diff',
        )
        continue
      }
      if (item.kind === 'prompt') {
        lines.push(...this.renderPromptBlock(item.body, item.promptStatus, safeWidth))
        continue
      }
      lines.push(...this.frameContent(this.renderText(item, this.contentWidth(safeWidth)), safeWidth))
    }
    if (this.hoveredBlockKey !== undefined && !this.blockHits.some(hit => hit.key === this.hoveredBlockKey)) {
      this.hoveredBlockKey = undefined
    }
    return lines
  }

  private renderText(item: TranscriptTextItem, width: number): string[] {
    const lines: string[] = []
    if (item.label !== undefined) {
      lines.push(truncateToWidth(this.paintTone(item.tone)(item.label), width))
    }
    if (item.body === undefined || item.body === '') return lines
    const body = sanitizeTerminalText(item.body)
    if (item.markdown) {
      const markdown = new Markdown(body, 0, 0, this.theme.markdown, item.dim ? { color: this.theme.dim } : undefined)
      lines.push(...markdown.render(width))
    } else {
      lines.push(...wrapTextWithAnsi(item.dim ? this.theme.dim(body) : body, width))
    }
    return lines
  }

  private paintTone(tone: TranscriptTone | undefined): (text: string) => string {
    switch (tone) {
      case 'accent': return this.theme.accent
      case 'dim': return this.theme.dim
      case 'error': return this.theme.error
      case 'warning': return this.theme.warning
      case undefined: return text => text
    }
  }

  private renderActivity(lines: string[], activity: TranscriptActivityGroup, width: number): void {
    const contentWidth = this.contentWidth(width)
    this.pushBlock(
      lines,
      this.frameContent([this.renderActivityTitle(activity, contentWidth)], width),
      activity.key,
      'activity',
    )
    if (!this.isActivityExpanded(activity.key)) return

    const childWidth = Math.max(1, contentWidth - ACTIVITY_CHILD_INDENT)
    for (const [index, item] of activity.items.entries()) {
      const last = index === activity.items.length - 1
      if (item.kind === 'tool' && item.status === 'failed') this.failedTools.add(item.key)
      const rendered = item.kind === 'thinking'
        ? this.renderThinking(item, childWidth)
        : this.renderTool(item, childWidth)
      this.pushBlock(
        lines,
        this.frameContent(this.indentActivityChild(rendered, last), width),
        item.key,
        item.kind,
      )
    }
  }

  private renderActivityTitle(activity: TranscriptActivityGroup, width: number): string {
    const expanded = this.isActivityExpanded(activity.key)
    const marker = expanded ? DISCLOSURE_EXPANDED : DISCLOSURE_COLLAPSED
    const elapsed = activity.completedAt === undefined
      ? undefined
      : Math.max(0, activity.completedAt - activity.startedAt)
    const duration = elapsed === undefined || elapsed === 0 ? undefined : elapsed
    const lead = this.activityLead(activity.status, duration)
    const thoughts = activity.items.filter(item => item.kind === 'thinking').length
    const tools = activity.items.length - thoughts
    const counts = [
      ...thoughts === 0 ? [] : [`${String(thoughts)} thought${thoughts === 1 ? '' : 's'}`],
      ...tools === 0 ? [] : [`${String(tools)} tool${tools === 1 ? '' : 's'}`],
    ]
    const latest = activity.status === 'running'
      ? activity.items.at(-1)
      : activity.status === 'failed'
        ? activity.items.findLast(item => item.kind === 'tool' && item.status === 'failed')
        : undefined
    const latestLabel = latest === undefined
      ? undefined
      : latest.kind === 'thinking' ? 'Thinking…' : latest.title
    const title = [lead, ...counts, latestLabel].filter(value => value !== undefined).join(' · ')
    const paint = activity.status === 'failed'
      ? this.theme.error
      : activity.status === 'running' ? this.theme.warning : this.theme.reasoning
    return this.renderBlockTitle(`${marker} ${title}`, activity.key, width, paint)
  }

  private activityLead(status: TranscriptActivityGroup['status'], duration: number | undefined): string {
    if (status === 'running') return 'Working'
    if (status === 'failed') {
      return duration === undefined ? 'Failed' : `Failed after ${formatTranscriptDuration(duration)}`
    }
    return duration === undefined ? 'Worked' : `Worked for ${formatTranscriptDuration(duration)}`
  }

  private indentActivityChild(lines: string[], last: boolean): string[] {
    return lines.map((line, index) => `${index === 0 ? last ? '└─ ' : '├─ ' : last ? '   ' : '│  '}${line}`)
  }

  private isActivityExpanded(key: string): boolean {
    return this.activityExpansion.get(key) ?? (this.showDetails || this.failedActivities.has(key))
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

  private contentWidth(width: number): number {
    return Math.max(1, width - (width >= 24 ? 2 : 0))
  }

  private frameContent(lines: string[], width: number): string[] {
    const gutter = width >= 24 ? 1 : 0
    if (gutter === 0) return lines
    const contentWidth = this.contentWidth(width)
    return lines.map(line => {
      const content = truncateToWidth(line, contentWidth, '…')
      const right = ' '.repeat(Math.max(gutter, width - gutter - visibleWidth(content)))
      return `${' '.repeat(gutter)}${content}${right}`
    })
  }

  private pushBlock(lines: string[], rendered: string[], key: string, kind: BlockHit['kind']): void {
    const titleLine = lines.length
    lines.push(...rendered)
    this.blockHits.push({ key, kind, titleLine, firstLine: titleLine, lastLine: lines.length - 1 })
  }

  private renderThinking(
    thinking: TranscriptThinkingItem,
    width: number,
  ): string[] {
    const expanded = this.expandedThinking.has(thinking.key)
    const marker = expanded ? DISCLOSURE_EXPANDED : DISCLOSURE_COLLAPSED
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

  private renderTool(tool: TranscriptToolItem, width: number): string[] {
    const expanded = this.isToolExpanded(tool.key)
    const marker = expanded ? DISCLOSURE_EXPANDED : DISCLOSURE_COLLAPSED
    const glyph = tool.status === 'pending' ? '○' : tool.status === 'failed' ? '×' : '•'
    const paint = tool.status === 'pending'
      ? this.theme.warning
      : tool.status === 'failed' ? this.theme.error : this.theme.success
    const renderedGlyph = tool.status === 'completed' ? this.theme.bold(paint(glyph)) : paint(glyph)
    const title = `${marker} ${glyph} ${tool.title}`
    const renderedTitle = this.hoveredBlockKey === tool.key
      ? this.theme.hover(truncateToWidth(title, width, '…'))
      : truncateToWidth(`${this.theme.dim(`${marker} `)}${renderedGlyph} ${this.theme.tool(tool.title)}`, width, '…')
    if (!expanded) return [renderedTitle]

    const sections = [
      ...tool.arguments === undefined ? [] : [{ label: 'Arguments', value: tool.arguments }],
      ...tool.result === undefined || tool.result === '' ? [] : [{ label: 'Result', value: tool.result }],
    ]
    if (sections.length === 0) {
      return [renderedTitle, truncateToWidth(`  ${this.theme.reasoning('No details recorded yet.')}`, width)]
    }
    return [
      renderedTitle,
      ...sections.flatMap((section, index) => [
        ...index === 0 ? [] : [''],
        truncateToWidth(`  ${this.theme.dim(section.label)}`, width),
        ...sanitizeTerminalText(section.value).split('\n').flatMap(line => {
          const wrapped = wrapTextWithAnsi(line, Math.max(1, width - 4))
          return (wrapped.length === 0 ? [''] : wrapped)
            .map(part => truncateToWidth(`  ${this.theme.reasoning('│')} ${this.theme.reasoning(part)}`, width, '…'))
        }),
      ]),
    ]
  }

  private isToolExpanded(key: string): boolean {
    return this.toolExpansion.get(key) ?? (this.showDetails || this.failedTools.has(key))
  }

  private renderDiff(diff: TranscriptDiffItem, width: number): string[] {
    const model = buildDiffDisplay(diff.title, diff.diffs, this.diffLineStarts.get(diff.key) ?? [])
    const collapsed = this.collapsedDiffs.has(diff.key)
    const title = this.renderDiffTitle(model.operation, model.target, diff.settled, collapsed, diff.key, width)
    if (collapsed) return [title]
    const { offset } = this.resolveBlockOffset(diff.key, model.lines.length, this.maxToolOutputLines, false)
    const visible = model.lines.slice(offset, offset + this.maxToolOutputLines)
    const numberWidth = Math.max(2, ...model.lines.map(line => String(line.number ?? '').length))
    const contentWidth = Math.max(1, width - DIFF_CONTENT_INDENT.length)
    return [
      title,
      truncateToWidth(this.theme.reasoning(`${DIFF_CONTENT_INDENT}└ ${diffSummary(model.added, model.removed)}`), width),
      ...visible.flatMap(line => this.renderDiffLine(line, contentWidth, numberWidth)
        .map(rendered => `${DIFF_CONTENT_INDENT}${rendered}`)),
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
    const marker = `${collapsed ? DISCLOSURE_COLLAPSED : DISCLOSURE_EXPANDED} `
    const cleanOperation = sanitizeTerminalText(operation)
    const cleanTarget = sanitizeTerminalText(target)
    const status = settled ? '•' : '○'
    const plain = `${marker}${status} ${cleanOperation}(${cleanTarget})`
    if (this.hoveredBlockKey === key) return this.theme.hover(truncateToWidth(plain, width, '…'))
    return truncateToWidth([
      marker,
      settled ? this.theme.bold(this.theme.success(status)) : this.theme.warning(status),
      ` ${this.theme.tool(cleanOperation)}(`,
      this.theme.underline(cleanTarget),
      ')',
    ].join(''), width, '…')
  }

  private renderDiffLine(line: DiffDisplayLine, width: number, numberWidth: number): string[] {
    switch (line.kind) {
      case 'file': return [truncateToWidth(this.theme.bold(sanitizeTerminalText(line.text)), width)]
      case 'gap': return [truncateToWidth(this.theme.dim('⋯'), width)]
      case 'context': {
        const gutterWidth = numberWidth + 3
        const firstPrefix = this.theme.dim(`${String(line.number ?? '').padStart(numberWidth)}   `)
        const continuationPrefix = ' '.repeat(gutterWidth)
        const code = this.theme.reasoning(sanitizeTerminalText(line.text))
        const wrapped = wrapTextWithAnsi(code, Math.max(1, width - gutterWidth))
        return (wrapped.length === 0 ? [''] : wrapped).map((part, index) =>
          truncateToWidth(`${index === 0 ? firstPrefix : continuationPrefix}${part}`, width, '…'))
      }
      case 'del': {
        const gutterWidth = numberWidth + 3
        const firstPrefix = this.theme.error(`${String(line.number ?? '').padStart(numberWidth)} - `)
        const continuationPrefix = ' '.repeat(gutterWidth)
        const code = highlightDiffText(sanitizeTerminalText(line.text), line.path, this.theme)
        const wrapped = wrapTextWithAnsi(code, Math.max(1, width - gutterWidth))
        return (wrapped.length === 0 ? [''] : wrapped).map((part, index) => this.theme.diffRemoved(
          padToWidth(`${index === 0 ? firstPrefix : continuationPrefix}${part}`, width),
        ))
      }
      case 'add': {
        const gutterWidth = numberWidth + 3
        const firstPrefix = this.theme.success(`${String(line.number ?? '').padStart(numberWidth)} + `)
        const continuationPrefix = ' '.repeat(gutterWidth)
        const code = highlightDiffText(sanitizeTerminalText(line.text), line.path, this.theme)
        const wrapped = wrapTextWithAnsi(code, Math.max(1, width - gutterWidth))
        return (wrapped.length === 0 ? [''] : wrapped).map((part, index) => this.theme.diffAdded(
          padToWidth(`${index === 0 ? firstPrefix : continuationPrefix}${part}`, width),
        ))
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

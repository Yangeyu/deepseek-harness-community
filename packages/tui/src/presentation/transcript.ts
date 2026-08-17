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
  type TranscriptActivityGroup,
  type TranscriptDiffItem,
  type TranscriptTextItem,
  type TranscriptThinkingItem,
  type TranscriptTone,
  type TranscriptToolItem,
} from './transcript-model.ts'
import { sanitizeTerminalText } from '../text.ts'
import type { TuiTheme } from './theme.ts'
import {
  executionStatus,
  type ExecutionStatus,
} from '../runtime/lifecycle/index.ts'
import {
  activityLabel,
  executionLabel,
  executionVisual,
  ExecutionDisclosureState,
  type ExecutionVisual,
} from './execution-style.ts'

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
  private readonly disclosure = new ExecutionDisclosureState()
  private readonly collapsedDiffs = new Set<string>()
  private readonly pausedThinking = new Set<string>()
  private readonly thinkingOffsets = new Map<string, number>()
  private readonly thinkingMaxOffsets = new Map<string, number>()
  private blockHits: BlockHit[] = []
  private activityExecutionKeys = new Map<string, readonly string[]>()
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
      this.disclosure.clear()
      this.collapsedDiffs.clear()
      this.pausedThinking.clear()
      this.thinkingOffsets.clear()
      this.thinkingMaxOffsets.clear()
      this.hoveredBlockKey = undefined
    }
    this.state = state
  }

  setDetails(show: boolean): void {
    this.showDetails = show
    this.disclosure.clearOverrides()
    this.pausedThinking.clear()
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
        this.disclosure.toggleActivity(this.activityExecutionKeys.get(hit.key) ?? [], this.showDetails)
      } else if (hit.kind === 'thinking' || hit.kind === 'tool') {
        this.disclosure.toggle(hit.key, this.showDetails)
        if (hit.kind === 'thinking') {
          this.pausedThinking.delete(hit.key)
          this.thinkingOffsets.delete(hit.key)
          this.thinkingMaxOffsets.delete(hit.key)
        }
      } else if (!this.collapsedDiffs.delete(hit.key)) {
        this.collapsedDiffs.add(hit.key)
      }
      return true
    }
    if (hit?.kind !== 'thinking' || !this.isChildExpanded(hit.key)) return false
    return this.scrollThinking(hit.key, action === 'wheel-up' ? -3 : 3)
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
    this.activityExecutionKeys = new Map()
    for (const item of items) {
      if (item.kind !== 'activity') continue
      const keys = item.items.map(child => child.key)
      this.activityExecutionKeys.set(item.key, keys)
      this.disclosure.observeActivity(keys, item.lifecycle.status)
    }
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
    if (!this.isActivityExpanded(activity)) return

    const childWidth = Math.max(1, contentWidth - ACTIVITY_CHILD_INDENT)
    for (const [index, item] of activity.items.entries()) {
      const last = index === activity.items.length - 1
      this.disclosure.observe(item.key, executionStatus(item.lifecycle))
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
    const expanded = this.isActivityExpanded(activity)
    const marker = expanded ? DISCLOSURE_EXPANDED : DISCLOSURE_COLLAPSED
    const status = activity.lifecycle.status
    const lead = activityLabel(activity.lifecycle)
    const thoughts = activity.items.filter(item => item.kind === 'thinking').length
    const tools = activity.items.length - thoughts
    const counts = [
      ...thoughts === 0 ? [] : [`${String(thoughts)} thought${thoughts === 1 ? '' : 's'}`],
      ...tools === 0 ? [] : [`${String(tools)} tool${tools === 1 ? '' : 's'}`],
    ]
    const latest = status === 'running' || status === 'pending'
      ? activity.items.at(-1)
      : status === 'failed'
        ? activity.items.findLast(item => executionStatus(item.lifecycle) === 'failed')
        : status === 'interrupted'
          ? activity.items.findLast(item => executionStatus(item.lifecycle) === 'interrupted')
          : undefined
    const latestLabel = latest === undefined
      ? undefined
      : latest.kind === 'thinking'
        ? executionLabel('thought', executionStatus(latest.lifecycle))
        : latest.title
    const title = [lead, ...counts, latestLabel].filter(value => value !== undefined).join(' · ')
    const paint = status === 'failed'
      ? this.theme.error
      : status === 'running' || status === 'pending' || status === 'interrupted'
        ? this.theme.warning
        : this.theme.reasoning
    return this.renderBlockTitle(`${marker} ${title}`, activity.key, width, paint)
  }

  private indentActivityChild(lines: string[], last: boolean): string[] {
    return lines.map((line, index) => `${index === 0 ? last ? '└─ ' : '├─ ' : last ? '   ' : '│  '}${line}`)
  }

  private isActivityExpanded(activity: TranscriptActivityGroup): boolean {
    return this.disclosure.activityExpanded(activity.items.map(item => item.key), this.showDetails)
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
    const expanded = this.isChildExpanded(thinking.key)
    const marker = expanded ? DISCLOSURE_EXPANDED : DISCLOSURE_COLLAPSED
    const status = executionStatus(thinking.lifecycle)
    const label = executionLabel('thought', status)
    if (!expanded) {
      return [this.renderExecutionTitle(marker, status, label, thinking.key, width, this.theme.reasoning)]
    }

    const contentWidth = Math.max(1, width - 2)
    const content = new Markdown(
      sanitizeTerminalText(thinking.text),
      0,
      0,
      this.theme.markdown,
      { color: this.theme.reasoning },
    ).render(contentWidth)
    const { offset, maxOffset } = this.resolveThinkingOffset(
      thinking.key,
      content.length,
      this.thinkingMaxLines,
      status === 'running' && !this.pausedThinking.has(thinking.key),
    )
    const visible = content.slice(offset, offset + this.thinkingMaxLines)
    const range = maxOffset === 0 ? '' : ` · ${offset + 1}-${Math.min(content.length, offset + this.thinkingMaxLines)}/${content.length}`
    return [
      this.renderExecutionTitle(marker, status, `${label}${range}`, thinking.key, width, this.theme.reasoning),
      ...visible.map(line => truncateToWidth(`${this.theme.reasoning('│')} ${line}`, width)),
    ]
  }

  private renderTool(tool: TranscriptToolItem, width: number): string[] {
    const expanded = this.isChildExpanded(tool.key)
    const marker = expanded ? DISCLOSURE_EXPANDED : DISCLOSURE_COLLAPSED
    const renderedTitle = this.renderExecutionTitle(
      marker,
      executionStatus(tool.lifecycle),
      tool.title,
      tool.key,
      width,
      this.theme.tool,
    )
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

  private isChildExpanded(key: string): boolean {
    return this.disclosure.expanded(key, this.showDetails)
  }

  private renderDiff(diff: TranscriptDiffItem, width: number): string[] {
    const model = buildDiffDisplay(diff.title, diff.diffs, this.diffLineStarts.get(diff.key) ?? [])
    const collapsed = this.collapsedDiffs.has(diff.key)
    const title = this.renderDiffTitle(
      model.operation,
      model.target,
      executionStatus(diff.lifecycle),
      collapsed,
      diff.key,
      width,
    )
    if (collapsed) return [title]
    const numberWidth = Math.max(2, ...model.lines.map(line => String(line.number ?? '').length))
    const contentWidth = Math.max(1, width - DIFF_CONTENT_INDENT.length)
    return [
      title,
      truncateToWidth(this.theme.reasoning(`${DIFF_CONTENT_INDENT}└ ${diffSummary(model.added, model.removed)}`), width),
      ...model.lines.flatMap(line => this.renderDiffLine(line, contentWidth, numberWidth)
        .map(rendered => `${DIFF_CONTENT_INDENT}${rendered}`)),
    ]
  }

  private renderDiffTitle(
    operation: string,
    target: string,
    status: ExecutionStatus,
    collapsed: boolean,
    key: string,
    width: number,
  ): string {
    const marker = `${collapsed ? DISCLOSURE_COLLAPSED : DISCLOSURE_EXPANDED} `
    const cleanOperation = sanitizeTerminalText(operation)
    const cleanTarget = sanitizeTerminalText(target)
    const visual = executionVisual(status, this.theme)
    const plain = `${marker}${visual.glyph} ${cleanOperation}(${cleanTarget})`
    if (this.hoveredBlockKey === key) return this.theme.hover(truncateToWidth(plain, width, '…'))
    return truncateToWidth([
      marker,
      this.renderExecutionGlyph(visual),
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

  private renderExecutionTitle(
    marker: string,
    status: ExecutionStatus,
    label: string,
    key: string,
    width: number,
    labelPaint: (text: string) => string,
  ): string {
    const visual = executionVisual(status, this.theme)
    const plain = `${marker} ${visual.glyph} ${label}`
    if (this.hoveredBlockKey === key) return this.theme.hover(truncateToWidth(plain, width, '…'))
    return truncateToWidth(
      `${this.theme.dim(`${marker} `)}${this.renderExecutionGlyph(visual)} ${labelPaint(label)}`,
      width,
      '…',
    )
  }

  private renderExecutionGlyph(visual: ExecutionVisual): string {
    const painted = visual.paint(visual.glyph)
    return visual.bold ? this.theme.bold(painted) : painted
  }

  private resolveThinkingOffset(key: string, lines: number, limit: number, follow: boolean): { offset: number; maxOffset: number } {
    const maxOffset = Math.max(0, lines - limit)
    this.thinkingMaxOffsets.set(key, maxOffset)
    const offset = follow ? maxOffset : Math.max(0, Math.min(maxOffset, this.thinkingOffsets.get(key) ?? 0))
    this.thinkingOffsets.set(key, offset)
    return { offset, maxOffset }
  }

  private scrollThinking(key: string, delta: number): boolean {
    const maxOffset = this.thinkingMaxOffsets.get(key) ?? 0
    const current = this.thinkingOffsets.get(key) ?? 0
    const next = Math.max(0, Math.min(maxOffset, current + delta))
    if (next === current) return false
    this.thinkingOffsets.set(key, next)
    if (next === maxOffset && delta > 0) this.pausedThinking.delete(key)
    else if (delta < 0) this.pausedThinking.add(key)
    return true
  }
}

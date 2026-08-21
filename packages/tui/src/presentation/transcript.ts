import {
  Markdown,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui'
import type { TuiState } from '../runtime/controller.ts'
import { appendedHistoryEntries } from '../runtime/event-window.ts'
import type { DiffLineStarts } from './diff-location.ts'
import {
  buildDiffDisplay,
  diffSummary,
  highlightDiffText,
  type DiffDisplayLine,
} from './diff.ts'
import {
  appendTranscriptChunks,
  buildTranscriptItems,
  type TranscriptActivityGroup,
  type TranscriptDiffItem,
  type TranscriptItem,
  type TranscriptPromptItem,
  type TranscriptTextItem,
  type TranscriptThinkingItem,
  type TranscriptTone,
  type TranscriptToolItem,
} from './transcript-model.ts'
import { sanitizeTerminalText } from '../text.ts'
import type { TuiTheme } from './theme.ts'
import { paintImageReferences } from './image-references.ts'
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

interface TextBlockCache {
  width: number
  label: string | undefined
  tone: TranscriptTone | undefined
  body: string | undefined
  markdown: boolean | undefined
  dim: boolean | undefined
  lines: string[]
}

interface PromptBlockCache {
  width: number
  body: string
  status: string | undefined
  lines: string[]
}

interface DiffBlockCache {
  width: number
  title: string
  diffs: TranscriptDiffItem['diffs']
  starts: readonly (number | undefined)[]
  status: ExecutionStatus
  disclosure: boolean | undefined
  collapsed: boolean
  lines: string[]
}

const DIFF_CONTENT_INDENT = '  '
const ACTIVITY_CHILD_INDENT = 3
const DISCLOSURE_COLLAPSED = '›'
const DISCLOSURE_EXPANDED = '⌄'
const EMPTY_DIFF_STARTS: readonly (number | undefined)[] = []
const LARGE_DIFF_LINES = 200

function sameItems<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function padToWidth(value: string, width: number): string {
  const clipped = truncateToWidth(value, width, '…', true)
  return `${clipped}${' '.repeat(Math.max(0, width - visibleWidth(clipped)))}`
}

/** Scrollback-first transcript component rebuilt from the current API event window. */
export class TranscriptComponent implements Component {
  private state: Readonly<TuiState>
  private showDetails = false
  private readonly disclosure = new ExecutionDisclosureState()
  private readonly diffDisclosure = new Map<string, boolean>()
  private readonly renderedDiffCollapsed = new Map<string, boolean>()
  private readonly pausedThinking = new Set<string>()
  private readonly thinkingOffsets = new Map<string, number>()
  private readonly thinkingMaxOffsets = new Map<string, number>()
  private items: TranscriptItem[] | undefined
  private renderedLineCount = 0
  private renderedDocument: { width: number; lines: string[] } | undefined
  private readonly textBlocks = new Map<string, TextBlockCache>()
  private readonly promptBlocks = new Map<string, PromptBlockCache>()
  private readonly diffBlocks = new Map<string, DiffBlockCache>()
  private blockHits: BlockHit[] = []
  private blockTitleHits = new Map<number, BlockHit>()
  private blockHitsByKey = new Map<string, BlockHit>()
  private activityExecutionKeys = new Map<string, readonly string[]>()
  private hoveredBlockKey: string | undefined
  private diffLineStarts: DiffLineStarts = new Map()
  private animationFrame = 0

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
    const previous = this.state
    const sessionChanged = state.sessionId !== previous.sessionId
    const appended = sessionChanged
      ? undefined
      : appendedHistoryEntries(previous.events, state.events)
    const incrementalItems = this.items === undefined
      || appended === undefined
      || !sameItems(previous.queue, state.queue)
      || !sameItems(previous.pendingSubmissions, state.pendingSubmissions)
      || state.notice !== previous.notice
      || state.error !== previous.error
      ? undefined
      : appendTranscriptChunks(this.items, appended, state.lifecycle, this.showReasoning)
    const contentChanged = sessionChanged
      || state.events !== previous.events
      || state.queue !== previous.queue
      || state.pendingSubmissions !== previous.pendingSubmissions
      || state.lifecycle !== previous.lifecycle
      || state.notice !== previous.notice
      || state.error !== previous.error
    if (sessionChanged) {
      this.disclosure.clear()
      this.diffDisclosure.clear()
      this.renderedDiffCollapsed.clear()
      this.pausedThinking.clear()
      this.thinkingOffsets.clear()
      this.thinkingMaxOffsets.clear()
      this.hoveredBlockKey = undefined
      this.textBlocks.clear()
      this.promptBlocks.clear()
      this.diffBlocks.clear()
    }
    this.state = state
    if (incrementalItems !== undefined && appended !== undefined && appended.length > 0) {
      if (incrementalItems !== this.items) {
        this.items = incrementalItems
        this.invalidate()
      }
    } else if (contentChanged) {
      this.invalidateContent()
    }
  }

  setDetails(show: boolean): void {
    if (show === this.showDetails) return
    this.showDetails = show
    this.disclosure.clearOverrides()
    this.pausedThinking.clear()
    this.invalidateContent()
  }

  /** Supply asynchronously resolved absolute file-line starts for diff cards. */
  setDiffLineStarts(starts: DiffLineStarts): void {
    if (starts === this.diffLineStarts) return
    this.diffLineStarts = starts
    this.invalidate()
  }

  /**
   * Advance the shared loading-animation frame for the running activity and
   * execution rows. Drives the same spinner frames as the status bar; a no-op
   * while no lifecycle node is active, so idle frames never rebuild.
   */
  advanceAnimation(): void {
    if (this.state.lifecycle.active().length === 0) return
    this.animationFrame += 1
    this.invalidateContent()
  }

  invalidate(): void {
    this.renderedDocument = undefined
  }

  /** Apply one pointer action to the block rendered at a transcript-relative row. */
  handlePointer(line: number, action: 'move' | 'click' | 'wheel-up' | 'wheel-down'): boolean {
    if (action === 'move') {
      const next = this.blockTitleHits.get(line)?.key
      if (next === this.hoveredBlockKey) return false
      this.hoveredBlockKey = next
      this.invalidate()
      return true
    }
    if (action === 'click') {
      const hit = this.blockTitleHits.get(line)
      if (hit === undefined) return false
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
      } else {
        const collapsed = this.renderedDiffCollapsed.get(hit.key) ?? false
        this.diffDisclosure.set(hit.key, !collapsed)
      }
      this.invalidate()
      return true
    }
    const hit = this.blockHitAt(line)
    if (hit?.kind !== 'thinking' || !this.isChildExpanded(hit.key)) return false
    return this.scrollThinking(hit.key, action === 'wheel-up' ? -1 : 1)
  }

  /** Whether the disclosure title at a transcript row belongs to the block reaching the transcript end. */
  isTrailingBlock(line: number): boolean {
    const hit = this.blockTitleHits.get(line)
    return hit !== undefined && hit.lastLine === this.renderedLineCount - 1
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    if (this.renderedDocument?.width === safeWidth) return this.renderedDocument.lines
    const lines: string[] = []
    const items = this.items ??= buildTranscriptItems(
      this.state, this.showReasoning, this.showDetails, this.maxToolOutputLines,
    )
    const activeTextBlocks = new Set<string>()
    const activePromptBlocks = new Set<string>()
    const activeDiffBlocks = new Set<string>()
    this.renderedDiffCollapsed.clear()
    this.blockHits = []
    this.blockTitleHits = new Map()
    this.blockHitsByKey = new Map()
    this.activityExecutionKeys = new Map()
    for (const item of items) {
      if (item.kind !== 'activity') continue
      this.activityExecutionKeys.set(item.key, item.items.map(child => child.key))
    }
    for (const [index, item] of items.entries()) {
      if (index > 0) lines.push('')
      if (item.kind === 'activity') {
        this.renderActivity(lines, item, safeWidth)
        continue
      }
      if (item.kind === 'diff') {
        activeDiffBlocks.add(item.key)
        this.pushBlock(
          lines,
          this.renderDiffBlock(item, safeWidth),
          item.key,
          'diff',
        )
        continue
      }
      if (item.kind === 'prompt') {
        activePromptBlocks.add(item.key)
        lines.push(...this.renderPromptBlock(item, safeWidth))
        continue
      }
      activeTextBlocks.add(item.key)
      lines.push(...this.renderTextBlock(item, safeWidth))
    }
    this.pruneBlockCache(this.textBlocks, activeTextBlocks)
    this.pruneBlockCache(this.promptBlocks, activePromptBlocks)
    this.pruneBlockCache(this.diffBlocks, activeDiffBlocks)
    this.paintHoveredTitle(lines)
    this.renderedDocument = { width: safeWidth, lines }
    this.renderedLineCount = lines.length
    return lines
  }

  private renderTextBlock(item: TranscriptTextItem, width: number): string[] {
    const cached = this.textBlocks.get(item.key)
    if (cached !== undefined
      && cached.width === width
      && cached.label === item.label
      && cached.tone === item.tone
      && cached.body === item.body
      && cached.markdown === item.markdown
      && cached.dim === item.dim) return cached.lines
    const lines = this.frameContent(this.renderText(item, this.contentWidth(width)), width)
    this.textBlocks.set(item.key, {
      width,
      label: item.label,
      tone: item.tone,
      body: item.body,
      markdown: item.markdown,
      dim: item.dim,
      lines,
    })
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
        : latest.toolName
    const title = [lead, ...counts, latestLabel].filter(value => value !== undefined).join(' · ')
    const paint = status === 'failed'
      ? this.theme.error
      : status === 'running' || status === 'pending' || status === 'interrupted'
        ? this.theme.warning
        : this.theme.reasoning
    return this.renderBlockTitle(`${marker} ${title}`, width, paint)
  }

  private indentActivityChild(lines: string[], last: boolean): string[] {
    return lines.map((line, index) => `${index === 0 ? last ? '└─ ' : '├─ ' : last ? '   ' : '│  '}${line}`)
  }

  private isActivityExpanded(activity: TranscriptActivityGroup): boolean {
    return this.disclosure.activityExpanded(activity.items.map(item => item.key), this.showDetails)
  }

  private renderPromptBlock(item: TranscriptPromptItem, width: number): string[] {
    const cached = this.promptBlocks.get(item.key)
    if (cached !== undefined
      && cached.width === width
      && cached.body === item.body
      && cached.status === item.promptStatus) return cached.lines
    const paintLine = (line: string): string => {
      const clipped = truncateToWidth(line, width, '…')
      const padding = ' '.repeat(Math.max(0, width - visibleWidth(clipped)))
      return this.theme.userBlock(`${clipped}${padding}`)
    }
    const lines = [paintLine(' '.repeat(width))]
    let firstLine = true
    for (const sourceLine of sanitizeTerminalText(item.body).split('\n')) {
      const painted = paintImageReferences(sourceLine, this.theme.user, this.theme.imageReference)
      const wrapped = wrapTextWithAnsi(painted, Math.max(1, width - 4))
      for (const wrappedLine of wrapped.length === 0 ? [''] : wrapped) {
        const marker = firstLine ? '› ' : '  '
        lines.push(paintLine(` ${this.theme.user(marker)}${wrappedLine} `))
        firstLine = false
      }
    }
    if (item.promptStatus !== undefined) {
      lines.push(paintLine(`   ${this.theme.dim(this.theme.user(item.promptStatus))} `))
    }
    lines.push(paintLine(' '.repeat(width)))
    this.promptBlocks.set(item.key, {
      width,
      body: item.body,
      status: item.promptStatus,
      lines,
    })
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
    const hit = { key, kind, titleLine, firstLine: titleLine, lastLine: lines.length - 1 }
    this.blockHits.push(hit)
    this.blockTitleHits.set(titleLine, hit)
    this.blockHitsByKey.set(key, hit)
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
      return [this.renderExecutionTitle(marker, status, label, width, this.theme.reasoning)]
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
      this.renderExecutionTitle(marker, status, `${label}${range}`, width, this.theme.reasoning),
      ...visible.map(line => truncateToWidth(`${this.theme.reasoning('│')} ${line}`, width)),
    ]
  }

  private renderTool(tool: TranscriptToolItem, width: number): string[] {
    const expanded = this.isChildExpanded(tool.key)
    const marker = expanded ? DISCLOSURE_EXPANDED : DISCLOSURE_COLLAPSED
    const renderedTitle = this.renderExecutionTitle(
      marker,
      executionStatus(tool.lifecycle),
      tool.operation,
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

  private renderDiffBlock(diff: TranscriptDiffItem, width: number): string[] {
    const contentWidth = this.contentWidth(width)
    const starts = this.diffLineStarts.get(diff.key) ?? EMPTY_DIFF_STARTS
    const disclosure = this.diffDisclosure.get(diff.key)
    const status = executionStatus(diff.lifecycle)
    const cached = this.diffBlocks.get(diff.key)
    if (cached !== undefined
      && cached.width === width
      && cached.title === diff.title
      && cached.diffs === diff.diffs
      && cached.starts === starts
      && cached.status === status
      && cached.disclosure === disclosure) {
      this.renderedDiffCollapsed.set(diff.key, cached.collapsed)
      return cached.lines
    }
    const model = buildDiffDisplay(diff.title, diff.diffs, starts)
    const collapsed = disclosure ?? (status === 'failed' || model.lines.length > LARGE_DIFF_LINES)
    this.renderedDiffCollapsed.set(diff.key, collapsed)
    const title = this.renderDiffTitle(
      model.operation,
      model.target,
      status,
      collapsed,
      contentWidth,
    )
    const summary = this.renderDiffSummary(model, contentWidth)
    const rendered = collapsed
      ? [title, summary]
      : this.renderDiffBody(model, title, summary, contentWidth)
    const lines = this.frameContent(rendered, width)
    this.diffBlocks.set(diff.key, {
      width,
      title: diff.title,
      diffs: diff.diffs,
      starts,
      status,
      disclosure,
      collapsed,
      lines,
    })
    return lines
  }

  private renderDiffBody(
    model: ReturnType<typeof buildDiffDisplay>,
    title: string,
    summary: string,
    width: number,
  ): string[] {
    const numberWidth = Math.max(2, ...model.lines.map(line => String(line.number ?? '').length))
    const contentWidth = Math.max(1, width - DIFF_CONTENT_INDENT.length)
    const syntaxHighlight = model.lines.length <= LARGE_DIFF_LINES
    return [
      title,
      summary,
      ...model.lines.flatMap(line => this.renderDiffLine(line, contentWidth, numberWidth, syntaxHighlight)
        .map(rendered => `${DIFF_CONTENT_INDENT}${rendered}`)),
    ]
  }

  private renderDiffSummary(model: ReturnType<typeof buildDiffDisplay>, width: number): string {
    return truncateToWidth(
      this.theme.reasoning(`${DIFF_CONTENT_INDENT}└ ${diffSummary(model.added, model.removed)}`),
      width,
    )
  }

  private renderDiffTitle(
    operation: string,
    target: string,
    status: ExecutionStatus,
    collapsed: boolean,
    width: number,
  ): string {
    const marker = `${collapsed ? DISCLOSURE_COLLAPSED : DISCLOSURE_EXPANDED} `
    const cleanOperation = sanitizeTerminalText(operation)
    const cleanTarget = sanitizeTerminalText(target)
    const visual = executionVisual(status, this.theme)
    return truncateToWidth([
      marker,
      this.renderExecutionGlyph(visual),
      ` ${this.theme.tool(cleanOperation)}(`,
      this.theme.underline(cleanTarget),
      ')',
    ].join(''), width, '…')
  }

  private renderDiffLine(
    line: DiffDisplayLine,
    width: number,
    numberWidth: number,
    syntaxHighlight: boolean,
  ): string[] {
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
        const clean = sanitizeTerminalText(line.text)
        const code = syntaxHighlight ? highlightDiffText(clean, line.path, this.theme) : clean
        const wrapped = wrapTextWithAnsi(code, Math.max(1, width - gutterWidth))
        return (wrapped.length === 0 ? [''] : wrapped).map((part, index) => this.theme.diffRemoved(
          padToWidth(`${index === 0 ? firstPrefix : continuationPrefix}${part}`, width),
        ))
      }
      case 'add': {
        const gutterWidth = numberWidth + 3
        const firstPrefix = this.theme.success(`${String(line.number ?? '').padStart(numberWidth)} + `)
        const continuationPrefix = ' '.repeat(gutterWidth)
        const clean = sanitizeTerminalText(line.text)
        const code = syntaxHighlight ? highlightDiffText(clean, line.path, this.theme) : clean
        const wrapped = wrapTextWithAnsi(code, Math.max(1, width - gutterWidth))
        return (wrapped.length === 0 ? [''] : wrapped).map((part, index) => this.theme.diffAdded(
          padToWidth(`${index === 0 ? firstPrefix : continuationPrefix}${part}`, width),
        ))
      }
    }
  }

  private renderBlockTitle(title: string, width: number, paint: (text: string) => string): string {
    const text = truncateToWidth(sanitizeTerminalText(title), width, '…')
    return paint(text)
  }

  private renderExecutionTitle(
    marker: string,
    status: ExecutionStatus,
    label: string,
    width: number,
    labelPaint: (text: string) => string,
  ): string {
    const visual = executionVisual(status, this.theme)
    const glyph = visual.glyph
    return truncateToWidth(
      `${this.theme.dim(`${marker} `)}${this.renderExecutionGlyph({ ...visual, glyph })} ${labelPaint(label)}`,
      width,
      '…',
    )
  }

  private renderExecutionGlyph(visual: ExecutionVisual): string {
    const painted = visual.paint(visual.glyph)
    return visual.bold ? this.theme.bold(painted) : painted
  }

  private paintHoveredTitle(lines: string[]): void {
    if (this.hoveredBlockKey === undefined) return
    const hit = this.blockHitsByKey.get(this.hoveredBlockKey)
    if (hit === undefined) {
      this.hoveredBlockKey = undefined
      return
    }
    const rendered = lines[hit.titleLine]
    if (rendered === undefined) return
    const plain = stripTerminalSequences(rendered)
    const start = plain.search(/\S/u)
    if (start < 0) return
    const end = plain.trimEnd().length
    lines[hit.titleLine] = `${plain.slice(0, start)}${this.theme.hover(plain.slice(start, end))}${plain.slice(end)}`
  }

  private blockHitAt(line: number): BlockHit | undefined {
    let low = 0
    let high = this.blockHits.length - 1
    while (low <= high) {
      const middle = (low + high) >>> 1
      const hit = this.blockHits[middle]
      if (hit === undefined) return undefined
      if (line < hit.firstLine) high = middle - 1
      else if (line > hit.lastLine) low = middle + 1
      else return hit
    }
    return undefined
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
    this.invalidate()
    return true
  }

  private invalidateContent(): void {
    this.items = undefined
    this.invalidate()
  }

  private pruneBlockCache<T>(cache: Map<string, T>, active: ReadonlySet<string>): void {
    for (const key of cache.keys()) {
      if (!active.has(key)) cache.delete(key)
    }
  }
}

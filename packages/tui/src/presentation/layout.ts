/** Composer-anchored layout primitives for the terminal presentation layer. */
import {
  Container,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
} from '@earendil-works/pi-tui'

type Paint = (text: string) => string

const identityPaint: Paint = text => text
const READABLE_SURFACE_COLUMNS = 100

export type ActiveSurface =
  | { readonly kind: 'readable'; readonly component: Component }
  | { readonly kind: 'workspace'; readonly component: Component }

function trimVisibleEnd(line: string): string {
  if (!line.includes('\u001b')) return line.trimEnd()
  const visible = stripTerminalSequences(line)
  const trimmedWidth = visibleWidth(visible.trimEnd())
  return trimmedWidth === visibleWidth(visible)
    ? line
    : truncateToWidth(line, trimmedWidth, '')
}

/** Main-screen layout with a fixed composer and a scrollable conversation viewport. */
export class ComposerAnchoredLayout extends Container {
  private activeSurface: ActiveSurface | undefined
  private conversationTop: number | undefined
  private renderedTranscriptTop = 0
  private renderedTranscriptRows = 0
  private renderedTranscriptScreenRow = 0
  private maxConversationTop = 0
  private conversationPageRows = 1

  constructor(
    private readonly header: Component,
    private readonly transcript: Component,
    private readonly status: Component,
    private readonly editor: Component,
    private readonly footer: Component,
    private readonly viewportRows: () => number,
    private readonly attachments?: Component,
    private readonly surfaceBorder: Paint = identityPaint,
  ) {
    super()
    this.addChild(header)
    this.addChild(transcript)
    this.addChild(status)
    if (attachments !== undefined) this.addChild(attachments)
    this.addChild(editor)
    this.addChild(footer)
  }

  /** Whether new transcript output remains pinned to the bottom edge. */
  get followsTranscriptTail(): boolean {
    return this.conversationTop === undefined
  }

  override render(width: number): string[] {
    const viewportRows = Math.max(0, this.viewportRows())
    if (this.activeSurface?.kind === 'workspace') {
      const lines = this.renderActiveSurface(width, this.activeSurface)
      return [
        ...lines.slice(0, viewportRows),
        ...Array<string>(Math.max(0, viewportRows - lines.length)).fill(''),
      ]
    }
    const header = this.header.render(width)
    const transcript = this.transcript.render(width)
    const composer = this.renderComposer(width)
    const transcriptStart = header.length + 1
    const conversation = [...header, '', ...transcript]
    const composerGapRows = this.activeSurface === undefined && viewportRows > composer.length ? 1 : 0
    const availableRows = Math.max(0, viewportRows - composer.length - composerGapRows)
    this.conversationPageRows = Math.max(1, availableRows)
    this.maxConversationTop = Math.max(0, conversation.length - availableRows)

    const requestedTop = this.conversationTop ?? this.maxConversationTop
    const top = Math.max(0, Math.min(this.maxConversationTop, requestedTop))
    if (this.conversationTop !== undefined && top === this.maxConversationTop) this.conversationTop = undefined
    const visible = conversation.slice(top, top + availableRows)
    const visibleTranscriptStart = Math.max(top, transcriptStart)
    const visibleTranscriptEnd = Math.min(top + visible.length, conversation.length)
    this.renderedTranscriptTop = Math.max(0, visibleTranscriptStart - transcriptStart)
    this.renderedTranscriptRows = Math.max(0, visibleTranscriptEnd - visibleTranscriptStart)
    this.renderedTranscriptScreenRow = visibleTranscriptStart - top

    const gap = Math.max(0, availableRows - visible.length)
    return [
      ...visible,
      ...Array<string>(gap + composerGapRows).fill(''),
      ...composer,
    ]
  }

  /** Replace the editor with a readable dock, or the whole viewport with a workspace. */
  setActiveSurface(surface: ActiveSurface | undefined): void {
    if (this.activeSurface !== undefined) this.removeChild(this.activeSurface.component)
    this.activeSurface = surface
    if (surface !== undefined) this.addChild(surface.component)
  }

  /** Temporarily replace the active surface and restore it only while this value still owns it. */
  pushActiveSurface(surface: ActiveSurface): () => boolean {
    const previous = this.activeSurface
    this.setActiveSurface(surface)
    let active = true
    return () => {
      if (!active) return false
      active = false
      if (this.activeSurface !== surface) return false
      this.setActiveSurface(previous)
      return true
    }
  }

  /** Move the conversation viewport by rendered lines; positive values move toward newer output. */
  scrollTranscript(delta: number): boolean {
    const current = this.conversationTop ?? this.maxConversationTop
    const next = Math.max(0, Math.min(this.maxConversationTop, current + delta))
    const normalized = next === this.maxConversationTop ? undefined : next
    if (normalized === this.conversationTop) return false
    this.conversationTop = normalized
    return true
  }

  /** Move one conversation page while keeping one context line visible. */
  pageTranscript(direction: -1 | 1): boolean {
    return this.scrollTranscript(direction * Math.max(1, this.conversationPageRows - 1))
  }

  /** Resume automatic tail following after viewing older output. */
  followTranscript(): boolean {
    if (this.conversationTop === undefined) return false
    this.conversationTop = undefined
    return true
  }

  /** Map one terminal row to the corresponding full-transcript rendered line. */
  transcriptRowAt(screenRow: number, viewportTop: number): number {
    const renderedRow = viewportTop + screenRow
    const relative = renderedRow - this.renderedTranscriptScreenRow
    if (relative < 0 || relative >= this.renderedTranscriptRows) return -1
    return this.renderedTranscriptTop + relative
  }

  private renderComposer(width: number): string[] {
    if (this.activeSurface !== undefined) return this.renderActiveSurface(width, this.activeSurface)
    return [
      ...this.status.render(width),
      ...this.attachments?.render(width) ?? [],
      ...this.editor.render(width),
      ...this.footer.render(width),
    ]
  }

  private renderActiveSurface(width: number, surface: ActiveSurface): string[] {
    const safeWidth = Math.max(1, width)
    const availableWidth = Math.max(1, safeWidth - 3)
    const contentWidth = surface.kind === 'workspace'
      ? availableWidth
      : Math.min(READABLE_SURFACE_COLUMNS, availableWidth)
    const lines = surface.component.render(contentWidth)
    return lines.map((line, index) => {
      const edge = index === 0 ? 'top' : index === lines.length - 1 ? 'bottom' : 'middle'
      return this.renderSurfaceLine(line, safeWidth, edge)
    })
  }

  private renderSurfaceLine(
    line: string,
    width: number,
    edge: 'top' | 'middle' | 'bottom',
  ): string {
    const normalizedLine = trimVisibleEnd(line)
    const marker = edge === 'top' ? '╭─ ' : edge === 'bottom' ? '╰─ ' : '│  '
    const prefix = truncateToWidth(marker, width, '')
    const available = Math.max(0, width - visibleWidth(prefix))
    const content = truncateToWidth(normalizedLine, available, '')
    const used = visibleWidth(prefix) + visibleWidth(content)
    const remaining = Math.max(0, width - used)
    const suffix = edge === 'middle' || remaining === 0
      ? ''
      : remaining === 1 ? '─' : ` ${'─'.repeat(remaining - 1)}`
    return `${this.surfaceBorder(prefix)}${content}${this.surfaceBorder(suffix)}`
  }
}

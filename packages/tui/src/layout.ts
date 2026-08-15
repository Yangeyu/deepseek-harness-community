import { Container, type Component } from '@earendil-works/pi-tui'

/** Main-screen layout with a fixed composer and a scrollable conversation viewport. */
export class ComposerAnchoredLayout extends Container {
  private composerOverride: Component | undefined
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
  ) {
    super()
    this.addChild(header)
    this.addChild(transcript)
    this.addChild(status)
    this.addChild(editor)
    this.addChild(footer)
  }

  /** Whether new transcript output remains pinned to the bottom edge. */
  get followsTranscriptTail(): boolean {
    return this.conversationTop === undefined
  }

  override render(width: number): string[] {
    const header = this.header.render(width)
    const transcript = this.transcript.render(width)
    const composer = this.renderComposer(width)
    const transcriptStart = header.length + 1
    const conversation = [...header, '', ...transcript]
    const availableRows = Math.max(0, this.viewportRows() - composer.length)
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
      ...Array<string>(gap).fill(''),
      ...composer,
    ]
  }

  /** Replace the editor area with an inline modal surface, or restore the editor. */
  setComposerOverride(component: Component | undefined): void {
    if (this.composerOverride !== undefined) this.removeChild(this.composerOverride)
    this.composerOverride = component
    if (component !== undefined) this.addChild(component)
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
    if (this.composerOverride !== undefined) return this.composerOverride.render(width)
    return [
      ...this.status.render(width),
      ...this.editor.render(width),
      ...this.footer.render(width),
    ]
  }
}

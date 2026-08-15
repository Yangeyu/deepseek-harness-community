import { Container, type Component } from '@earendil-works/pi-tui'

/** Main-screen layout with a fixed composer and an application-owned transcript viewport. */
export class ComposerAnchoredLayout extends Container {
  private composerOverride: Component | undefined
  private transcriptTop: number | undefined
  private renderedTranscriptTop = 0
  private renderedTranscriptRows = 0
  private renderedTranscriptScreenRow = 0
  private maxTranscriptTop = 0
  private transcriptPageRows = 1

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
    return this.transcriptTop === undefined
  }

  override render(width: number): string[] {
    const header = this.header.render(width)
    const transcript = this.transcript.render(width)
    const composer = this.renderComposer(width)
    const fixedRows = header.length + 1 + composer.length
    const availableRows = Math.max(0, this.viewportRows() - fixedRows)
    this.transcriptPageRows = Math.max(1, availableRows)
    this.maxTranscriptTop = Math.max(0, transcript.length - availableRows)

    const requestedTop = this.transcriptTop ?? this.maxTranscriptTop
    const top = Math.max(0, Math.min(this.maxTranscriptTop, requestedTop))
    if (this.transcriptTop !== undefined && top === this.maxTranscriptTop) this.transcriptTop = undefined
    this.renderedTranscriptTop = top
    const visible = transcript.slice(top, top + availableRows)
    this.renderedTranscriptRows = visible.length
    this.renderedTranscriptScreenRow = header.length + 1

    const gap = Math.max(0, availableRows - visible.length)
    return [
      ...header,
      '',
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

  /** Move the transcript viewport by rendered lines; positive values move toward newer output. */
  scrollTranscript(delta: number): boolean {
    const current = this.transcriptTop ?? this.maxTranscriptTop
    const next = Math.max(0, Math.min(this.maxTranscriptTop, current + delta))
    const normalized = next === this.maxTranscriptTop ? undefined : next
    if (normalized === this.transcriptTop) return false
    this.transcriptTop = normalized
    return true
  }

  /** Move one transcript page while keeping one context line visible. */
  pageTranscript(direction: -1 | 1): boolean {
    return this.scrollTranscript(direction * Math.max(1, this.transcriptPageRows - 1))
  }

  /** Resume automatic tail following after viewing older output. */
  followTranscript(): boolean {
    if (this.transcriptTop === undefined) return false
    this.transcriptTop = undefined
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

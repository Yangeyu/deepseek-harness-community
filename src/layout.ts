import { Container, type Component } from '@earendil-works/pi-tui'

/** Keep the composer at the bottom while preserving all transcript lines above it. */
export function anchorComposer(
  content: string[],
  composer: string[],
  viewportRows: number,
): string[] {
  const gap = Math.max(1, viewportRows - content.length - composer.length)
  return [...content, ...Array<string>(gap).fill(''), ...composer]
}

/** Main-screen layout whose stable viewport height prevents overlays from moving the composer. */
export class ComposerAnchoredLayout extends Container {
  private composerOverride: Component | undefined

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

  override render(width: number): string[] {
    const content = [
      ...this.header.render(width),
      '',
      ...this.transcript.render(width),
    ]
    return anchorComposer(content, this.renderComposer(width), this.viewportRows())
  }

  /** Replace the editor area with an inline modal surface, or restore the editor. */
  setComposerOverride(component: Component | undefined): void {
    if (this.composerOverride !== undefined) this.removeChild(this.composerOverride)
    this.composerOverride = component
    if (component !== undefined) this.addChild(component)
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

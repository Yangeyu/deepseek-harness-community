import {
  TuiMainScreen,
  type Terminal,
  type TuiStopOptions,
} from '@earendil-works/pi-tui'
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
} from './mouse.ts'
import {
  RenderedTextSelection,
  type TextSelectionRelease,
} from './text-selection.ts'

/** Main-screen renderer with application-controlled text-selection gestures. */
export class SelectableMainScreen extends TuiMainScreen {
  private readonly textSelection = new RenderedTextSelection()
  private renderedLines: string[] = []

  constructor(terminal: Terminal, showHardwareCursor: boolean) {
    super(terminal, showHardwareCursor)
  }

  override render(width: number): string[] {
    this.renderedLines = super.render(width)
    return this.textSelection.apply(this.renderedLines)
  }

  beginTextSelection(x: number, y: number): boolean {
    return this.textSelection.begin(this.renderedPoint(x, y))
  }

  updateTextSelection(x: number, y: number): boolean {
    return this.textSelection.update(this.renderedPoint(x, y))
  }

  finishTextSelection(x: number, y: number): TextSelectionRelease {
    return this.textSelection.finish(this.renderedPoint(x, y), this.renderedLines)
  }

  clearTextSelection(): boolean {
    return this.textSelection.clear()
  }

  protected override afterTerminalStart(): void {
    super.afterTerminalStart()
    this.terminal.write(ENABLE_MOUSE_TRACKING)
  }

  protected override beforeTerminalStop(options: TuiStopOptions): void {
    this.terminal.write(DISABLE_MOUSE_TRACKING)
    super.beforeTerminalStop(options)
  }

  private renderedPoint(x: number, y: number): { row: number; col: number } {
    const state = this.captureRenderState()
    return {
      row: state.previousViewportTop + Math.max(0, Math.min(this.terminal.rows - 1, y)),
      col: Math.max(0, Math.min(this.terminal.columns - 1, x)),
    }
  }
}

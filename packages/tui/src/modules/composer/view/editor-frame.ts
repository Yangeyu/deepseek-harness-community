import {
  CURSOR_MARKER,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
} from '@earendil-works/pi-tui'
import type { TuiTheme } from '../../../presentation/primitives/theme.ts'
import type { ComposerEditorPort } from '../editor-port.ts'
import type { ComposerSparkle } from './sparkle.ts'

const PLACEHOLDER = 'Ask anything'
// oxlint-disable-next-line no-control-regex -- pi-tui renders its software cursor as one reverse-video grapheme.
const EDITOR_CURSOR = /\u001b\[7m([\s\S]*?)\u001b\[0m/gu

function padded(line: string, width: number): string {
  const clipped = truncateToWidth(line, width, '')
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)))
}

/** Preserve the Editor's offscreen-line count in the card's padding row. */
function scrollHint(border: string, width: number): string {
  const hint = stripTerminalSequences(border).replaceAll('─', '').trim()
  return padded(hint === '' ? '' : `  ${hint}`, width)
}

interface EditorRender {
  autocomplete: string[]
  frame: string[]
}

function isEditorBorder(line: string): boolean {
  return /^─+(?: ↓ .*|\.{1,3})?$/u.test(stripTerminalSequences(line))
}

function splitEditorRender(lines: string[]): EditorRender {
  const closingBorder = lines.findIndex((line, index) => index > 0 && isEditorBorder(line))
  if (closingBorder < 0) {
    return { autocomplete: [], frame: lines }
  }
  return {
    autocomplete: lines.slice(closingBorder + 1),
    frame: lines.slice(0, closingBorder + 1),
  }
}

/** Borderless, padded input card; autocomplete remains above the bottom-anchored draft. */
export class ComposerEditorFrame implements Component {
  constructor(
    private readonly editor: Pick<ComposerEditorPort, 'render' | 'invalidate' | 'getText'>,
    private readonly theme: TuiTheme,
    private readonly sparkle: ComposerSparkle,
  ) {}

  invalidate(): void {
    this.editor.invalidate()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    const prefixWidth = Math.min(2, safeWidth - 1)
    const innerWidth = safeWidth - prefixWidth
    // Reserve two text cells for wide graphemes plus the Editor cursor gutter.
    const rendered = splitEditorRender(this.editor.render(Math.max(3, innerWidth)))
    const colors = this.theme.inputColors
    const text = rendered.frame.slice(1, -1).map(line => line.replace(EDITOR_CURSOR, '$1'))
    if (this.editor.getText() === '') {
      const marker = text[0]!.includes(CURSOR_MARKER) ? CURSOR_MARKER : ''
      const placeholder = truncateToWidth(PLACEHOLDER, Math.max(1, innerWidth - 1), '')
      const muted = (['r', 'g', 'b'] as const).map(channel => Math.floor(
        (colors.foreground[channel] + colors.background[channel]) / 2,
      )).join(';')
      text[0] = padded(this.theme.colorEnabled ? `\u001b[38;2;${muted}m${marker}${placeholder}\u001b[39m` : marker + placeholder, innerWidth)
    }
    const card = [
      scrollHint(rendered.frame[0]!, safeWidth),
      ...text.map((line, index) => {
        const prefix = index === 0 ? this.theme.bold(padded('›', prefixWidth)) : ' '.repeat(prefixWidth)
        return padded(prefix + line, safeWidth)
      }),
      scrollHint(rendered.frame.at(-1)!, safeWidth),
    ]
    const decorated = this.sparkle.render(card, colors)
    return [
      ...rendered.autocomplete.map(line => padded(' '.repeat(prefixWidth) + line, safeWidth)),
      ...decorated.map(line => this.theme.inputSurface(line)),
    ]
  }
}

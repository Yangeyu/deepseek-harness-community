import { CURSOR_MARKER, visibleWidth, type RgbColor } from '@earendil-works/pi-tui'

const DOTS = ['⠁', '⠂', '⠄', '⠈', '⠐', '⠠', '⡀', '⢀']
const FRAME_MS = 150

export interface SparkleColors {
  readonly foreground: RgbColor
  readonly background: RgbColor
}

interface ComposerSparkleOptions {
  readonly enabled: boolean
  readonly visible: () => boolean
  readonly invalidate: () => void
}

/** Persistent starfield. Owns its visual recipe, clock and on-demand redraws. */
export class ComposerSparkle {
  private startedAt: number | undefined
  private disposed = false
  private frameTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: ComposerSparkleOptions) {}

  render(frame: string[], colors: SparkleColors): string[] {
    this.clearFrameTimer()
    if (!this.options.enabled || this.disposed || !this.options.visible()) return frame
    this.startedAt ??= performance.now()
    const elapsed = performance.now() - this.startedAt
    this.frameTimer = setTimeout(() => {
      this.frameTimer = undefined
      if (this.options.visible()) this.options.invalidate()
    }, FRAME_MS)
    return frame.map((line, row) => paintStars(line, row, elapsed, colors))
  }

  dispose(): void {
    this.disposed = true
    this.clearFrameTimer()
  }

  private clearFrameTimer(): void {
    if (this.frameTimer !== undefined) clearTimeout(this.frameTimer)
    this.frameTimer = undefined
  }
}

// oxlint-disable-next-line no-control-regex -- Split Editor-owned SGR without altering its bytes.
const SGR = /(\u001b\[[\d;]*m)/u

/** Styles, cursor cells and wide glyphs are occupied; only ordinary blank cells receive stars. */
function paintStars(line: string, row: number, elapsedMs: number, colors: SparkleColors): string {
  const cursorIndex = line.indexOf(CURSOR_MARKER)
  const cursorColumn = cursorIndex < 0 ? -1 : visibleWidth(line.slice(0, cursorIndex))
  const styles = new Set<number>()
  let column = 0
  return line.split(SGR).map(part => {
    if (part.startsWith('\u001b[')) {
      trackStyles(part, styles)
      return part
    }
    const painted = styles.size > 0 ? part : part.replace(/ +/gu, (spaces: string, index: number) => {
      const start = column + visibleWidth(part.slice(0, index))
      return Array.from(spaces, (_, offset) => start + offset === cursorColumn
        ? ' '
        : starAt(row, start + offset, elapsedMs / 1_000, colors)).join('')
    })
    column += visibleWidth(part)
    return painted
  }).join('')
}

/** The Editor emits SGR for its cursor and inline references; do not decorate their spaces. */
function trackStyles(sequence: string, styles: Set<number>): void {
  const codes = sequence.slice(2, -1).split(';').map(Number)
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index]!
    if (code === 0) styles.clear()
    else if (code === 39 || code === 49) styles.delete(code - 1)
    else if (code >= 21 && code <= 29) {
      styles.delete(code - 20)
      if (code === 22) styles.delete(1)
    } else if (code === 38 || code === 48) {
      styles.add(code)
      index += codes[index + 1] === 2 ? 4 : 2
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) styles.add(38)
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) styles.add(48)
    else styles.add(code)
  }
}

/** Codex CLI rust-v0.154.0 chat_composer/sparkle.rs coordinate field and brightness curve. */
function starAt(row: number, column: number, seconds: number, colors: SparkleColors): string {
  let hash = BigInt(row) * 65537n + BigInt(column)
  hash = BigInt.asUintN(64, (hash ^ (hash >> 16n)) * 0x45d9f3bn)
  hash = BigInt.asUintN(64, (hash ^ (hash >> 16n)) * 0x45d9f3bn)
  hash ^= hash >> 16n
  if (hash % 5n !== 0n) return ' '
  const phase = (seconds / (4 + Number(hash % 31n) / 10) + Number(hash % 997n) / 997) % 1
  const brightness = Math.sin(phase * Math.PI) ** 12 * 0.55
  if (brightness < 0.04) return ' '
  const color = (['r', 'g', 'b'] as const).map(channel => Math.floor(
    colors.foreground[channel] * brightness + colors.background[channel] * (1 - brightness),
  )).join(';')
  return `\u001b[38;2;${color}m${DOTS[Number((hash / 161n) % 8n)]!}\u001b[39m`
}

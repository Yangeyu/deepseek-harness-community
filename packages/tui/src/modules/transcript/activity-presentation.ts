import { truncateToWidth, visibleWidth, type RgbColor } from '@earendil-works/pi-tui'
import { formatDuration } from '../../presentation/primitives/duration.ts'
import type { TuiTheme } from '../../presentation/primitives/theme.ts'
import { executionStatus } from '../../runtime/execution/projection/index.ts'
import type { TranscriptActivityGroup } from './model.ts'

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Prepare the summary once; the view supplies frame time only for an enabled animation. */
export function activityTitle(
  activity: TranscriptActivityGroup,
  width: number,
  expanded: boolean,
  active: boolean,
  theme: TuiTheme,
): (elapsedMs?: number) => string {
  const marker = expanded ? '⌄' : '›'
  const thoughts = activity.items.filter(item => item.kind === 'thinking').length
  const tools = activity.items.length - thoughts
  const failed = activity.items.filter(item => executionStatus(item.execution) === 'failed').length
  const interrupted = activity.items.filter(item => executionStatus(item.execution) === 'interrupted').length
  const { startedAt, endedAt } = activity.execution
  const duration = !active && startedAt !== undefined && endedAt !== undefined && endedAt > startedAt
    ? formatDuration(endedAt - startedAt)
    : undefined
  const summary = truncateToWidth([
    'Activity',
    ...thoughts === 0 ? [] : [`${String(thoughts)} thought${thoughts === 1 ? '' : 's'}`],
    ...tools === 0 ? [] : [`${String(tools)} tool${tools === 1 ? '' : 's'}`],
    ...duration === undefined ? [] : [duration],
  ].join(' · '), Math.max(0, width - 2), '…')
  const outcomes = [
    ...failed === 0 ? [] : [theme.error(`${String(failed)} failed`)],
    ...interrupted === 0 ? [] : [theme.reasoning(`${String(interrupted)} interrupted`)],
  ].map(part => theme.reasoning(' · ') + part).join('')
  return elapsedMs => truncateToWidth(
    theme.reasoning(`${marker} `)
      + (elapsedMs !== undefined
        ? shimmer(summary, elapsedMs, theme.secondaryColor, theme.terminalBackground ?? { r: 0, g: 0, b: 0 })
        : theme.reasoning(summary))
      + outcomes,
    width,
    '…',
  )
}

/** A two-second dark band over bright text; glyphs and terminal column positions stay fixed. */
function shimmer(text: string, elapsedMs: number, foreground: RgbColor, background: RgbColor): string {
  const width = visibleWidth(text)
  const halfWidth = Math.max(4.5, width * 0.15)
  const position = (elapsedMs % 2_000) / 2_000 * (width + 2 * halfWidth) - halfWidth
  let column = 0
  return Array.from(graphemes.segment(text), ({ segment }) => {
    const glyphWidth = visibleWidth(segment)
    const center = column + glyphWidth / 2
    column += glyphWidth
    const distance = Math.min(1, Math.abs(center - position) / halfWidth)
    const intensity = 0.5 * (1 + Math.cos(Math.PI * distance))
    const alpha = 0.9 - 0.5 * intensity
    const color = (['r', 'g', 'b'] as const).map(channel => Math.round(
      foreground[channel] * alpha + background[channel] * (1 - alpha),
    )).join(';')
    return `\u001b[38;2;${color}m${segment}`
  }).join('') + '\u001b[39m'
}

import { sanitizeTerminalText } from '../../presentation/primitives/text.ts'
import type { ProviderUsage } from './contracts.ts'

function duration(seconds: number): string {
  if (seconds === 604800) return 'Weekly'
  if (seconds % 86400 === 0) return `${String(seconds / 86400)}d`
  if (seconds % 3600 === 0) return `${String(seconds / 3600)}h`
  if (seconds % 60 === 0) return `${String(seconds / 60)}m`
  return `${String(seconds)}s`
}

/** Format only reported windows; timestamps use the terminal's local timezone. */
export function formatUsage(usage: ProviderUsage): string {
  const time = (milliseconds: number) => new Date(milliseconds).toLocaleString(undefined, { timeZoneName: 'short' })
  return sanitizeTerminalText([
    `Subscription usage · ${usage.provider}${usage.plan === undefined ? '' : ` · ${usage.plan}`}`,
    `Updated: ${time(usage.checkedAt)}`,
    ...usage.groups.flatMap(group => [
      '', group.label,
      ...group.windows.map(window => {
        const remaining = Math.max(0, 100 - window.usedPercent)
        const reset = window.resetsAt === undefined ? 'reset time unavailable' : `resets ${time(window.resetsAt * 1000)}`
        return `  ${duration(window.durationSeconds)}: ${String(remaining)}% left · ${reset}`
      }),
    ]),
    ...usage.groups.length === 0 ? ['No quota windows reported.'] : [],
  ].join('\n'))
}

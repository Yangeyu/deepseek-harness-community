// Loads the session-title `SessionProjectionMap.title` augmentation for list rows.
import type {} from '@deepseek-ai/dsh-session-title'
import type { SessionSummary } from '@deepseek-ai/dsh-host-apiproxy'

export interface SessionListRow {
  sessionId: string
  updatedAt: string
  status: 'blank' | 'idle' | 'running'
  cwd?: string
  title?: string
  parentSessionId?: string
  origin?: 'subagent'
}

/** One resume-selector choice: root sessions only, title-first. */
export interface SessionChoice {
  value: string
  label: string
  description: string
}

export function sessionTitle(session: SessionSummary): string | undefined {
  const title = session.projections?.values.title
  if (title === null || title === undefined) return undefined
  const trimmed = title.trim()
  return trimmed === '' ? undefined : trimmed
}

function timestamp(value: number): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString()
}

export function sessionListRows(sessions: readonly SessionSummary[]): SessionListRow[] {
  return sessions.map(session => {
    const title = sessionTitle(session)
    return {
      sessionId: String(session.sessionId),
      updatedAt: timestamp(session.updatedAt),
      status: session.running ? 'running' : session.blank ? 'blank' : 'idle',
      ...session.cwd === undefined ? {} : { cwd: session.cwd },
      ...title === undefined ? {} : { title },
      ...session.parentSessionId === undefined ? {} : { parentSessionId: String(session.parentSessionId) },
      ...session.origin === undefined ? {} : { origin: session.origin },
    }
  })
}

/**
 * Resume-selector rows: subagent children stay out of the navigation surface
 * (they are lineage artifacts, not user conversations). The session id stays
 * the primary label, the working directory follows, and the durable `title`
 * projection appears third in the description line — additive, never
 * replacing the id.
 */
export function sessionChoices(
  sessions: readonly SessionSummary[],
  currentSessionId: string | undefined,
): SessionChoice[] {
  const current = currentSessionId
  return sessions
    .filter(session => session.origin !== 'subagent' && String(session.sessionId) !== current)
    .map(session => {
      const value = String(session.sessionId)
      const details = [session.cwd, sessionTitle(session)]
        .filter((part): part is string => part !== undefined)
      return {
        value,
        label: value,
        description: details.length === 0 ? value : details.join(' · '),
      }
    })
}

function table(rows: readonly SessionListRow[]): string {
  if (rows.length === 0) return 'No sessions found.\n'
  const values = [
    ['SESSION', 'UPDATED', 'STATUS', 'ORIGIN', 'CWD', 'TITLE'],
    ...rows.map(row => [row.sessionId, row.updatedAt, row.status, row.origin ?? 'root', row.cwd ?? '-', row.title ?? '-']),
  ]
  const widths = [0, 1, 2, 3, 4].map(column => Math.max(...values.map(row => row[column]?.length ?? 0)))
  return `${values.map(row => row.map((value, column) => (
    column < 5 ? (value ?? '').padEnd(widths[column] ?? 0) : value ?? ''
  )).join('  ')).join('\n')}\n`
}

export function formatSessionList(sessions: readonly SessionSummary[], json: boolean): string {
  const rows = sessionListRows(sessions)
  return json ? `${JSON.stringify(rows, null, 2)}\n` : table(rows)
}
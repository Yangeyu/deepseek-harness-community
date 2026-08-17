import type { SessionSummary } from '@deepseek-ai/dsh-host-apiproxy'

export interface SessionListRow {
  sessionId: string
  updatedAt: string
  status: 'blank' | 'idle' | 'running'
  cwd?: string
  parentSessionId?: string
  origin?: 'subagent'
}

function timestamp(value: number): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString()
}

export function sessionListRows(sessions: readonly SessionSummary[]): SessionListRow[] {
  return sessions.map(session => ({
    sessionId: String(session.sessionId),
    updatedAt: timestamp(session.updatedAt),
    status: session.running ? 'running' : session.blank ? 'blank' : 'idle',
    ...session.cwd === undefined ? {} : { cwd: session.cwd },
    ...session.parentSessionId === undefined ? {} : { parentSessionId: String(session.parentSessionId) },
    ...session.origin === undefined ? {} : { origin: session.origin },
  }))
}

function table(rows: readonly SessionListRow[]): string {
  if (rows.length === 0) return 'No sessions found.\n'
  const values = [
    ['SESSION', 'UPDATED', 'STATUS', 'ORIGIN', 'CWD'],
    ...rows.map(row => [row.sessionId, row.updatedAt, row.status, row.origin ?? 'root', row.cwd ?? '-']),
  ]
  const widths = [0, 1, 2, 3].map(column => Math.max(...values.map(row => row[column]?.length ?? 0)))
  return `${values.map(row => row.map((value, column) => (
    column < 4 ? (value ?? '').padEnd(widths[column] ?? 0) : value ?? ''
  )).join('  ')).join('\n')}\n`
}

export function formatSessionList(sessions: readonly SessionSummary[], json: boolean): string {
  const rows = sessionListRows(sessions)
  return json ? `${JSON.stringify(rows, null, 2)}\n` : table(rows)
}

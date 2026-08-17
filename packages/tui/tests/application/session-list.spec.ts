import type { SessionSummary } from '@deepseek-ai/dsh-host-apiproxy'
import { describe, expect, it } from 'vitest'
import { formatSessionList, sessionListRows } from '../../src/application/session-list.ts'

const sessions: SessionSummary[] = [{
  sessionId: 'running-session' as SessionSummary['sessionId'],
  updatedAt: Date.UTC(2026, 7, 17, 3, 0, 0),
  running: true,
  blank: false,
  cwd: '/workspace/app',
}, {
  sessionId: 'blank-session' as SessionSummary['sessionId'],
  parentSessionId: 'parent' as SessionSummary['sessionId'],
  updatedAt: Date.UTC(2026, 7, 16, 2, 0, 0),
  running: false,
  blank: true,
  origin: 'subagent',
}]

describe('session list output', () => {
  it('projects stable rows without leaking the variable projection payload', () => {
    expect(sessionListRows(sessions)).toEqual([{
      sessionId: 'running-session',
      updatedAt: '2026-08-17T03:00:00.000Z',
      status: 'running',
      cwd: '/workspace/app',
    }, {
      sessionId: 'blank-session',
      updatedAt: '2026-08-16T02:00:00.000Z',
      status: 'blank',
      parentSessionId: 'parent',
      origin: 'subagent',
    }])
  })

  it('renders human and JSON output from the same rows', () => {
    expect(formatSessionList(sessions, false)).toContain('SESSION          UPDATED')
    expect(formatSessionList(sessions, false)).toContain('running-session')
    expect(formatSessionList(sessions, false)).toContain('subagent')
    expect(JSON.parse(formatSessionList(sessions, true))).toEqual(sessionListRows(sessions))
    expect(formatSessionList([], false)).toBe('No sessions found.\n')
  })
})

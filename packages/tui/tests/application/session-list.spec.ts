import type { SessionSummary } from '@deepseek-ai/dsh-host-apiproxy'
import { describe, expect, it } from 'vitest'
import {
  formatSessionList,
  sessionChoices,
  sessionListRows,
  sessionTitle,
} from '../../src/application/session-list.ts'

const sessions: SessionSummary[] = [{
  sessionId: 'running-session' as SessionSummary['sessionId'],
  updatedAt: Date.UTC(2026, 7, 17, 3, 0, 0),
  running: true,
  blank: false,
  cwd: '/workspace/app',
  projections: { asOfSeq: 5, values: { title: 'Ship the auth flow' } },
}, {
  sessionId: 'blank-session' as SessionSummary['sessionId'],
  parentSessionId: 'running-session' as SessionSummary['sessionId'],
  updatedAt: Date.UTC(2026, 7, 16, 2, 0, 0),
  running: false,
  blank: true,
  origin: 'subagent',
  projections: { asOfSeq: 1, values: { title: null } },
}, {
  sessionId: 'untitled-session' as SessionSummary['sessionId'],
  updatedAt: Date.UTC(2026, 7, 15, 1, 0, 0),
  running: false,
  blank: false,
  cwd: '/workspace/tooling',
}]

describe('session list output', () => {
  it('projects stable rows and surfaces the durable title projection', () => {
    expect(sessionListRows(sessions)).toEqual([{
      sessionId: 'running-session',
      updatedAt: '2026-08-17T03:00:00.000Z',
      status: 'running',
      cwd: '/workspace/app',
      title: 'Ship the auth flow',
    }, {
      sessionId: 'blank-session',
      updatedAt: '2026-08-16T02:00:00.000Z',
      status: 'blank',
      parentSessionId: 'running-session',
      origin: 'subagent',
    }, {
      sessionId: 'untitled-session',
      updatedAt: '2026-08-15T01:00:00.000Z',
      status: 'idle',
      cwd: '/workspace/tooling',
    }])
  })

  it('reads titles defensively across the projection', () => {
    expect(sessionTitle(sessions[0]!)).toBe('Ship the auth flow')
    expect(sessionTitle(sessions[1]!)).toBeUndefined()
    expect(sessionTitle(sessions[2]!)).toBeUndefined()
  })

  it('renders human and JSON output from the same rows', () => {
    expect(formatSessionList(sessions, false)).toContain('SESSION')
    expect(formatSessionList(sessions, false)).toContain('TITLE')
    expect(formatSessionList(sessions, false)).toContain('Ship the auth flow')
    expect(formatSessionList(sessions, false)).toContain('subagent')
    expect(JSON.parse(formatSessionList(sessions, true))).toEqual(sessionListRows(sessions))
    expect(formatSessionList([], false)).toBe('No sessions found.\n')
  })
})

describe('resume session choices', () => {
  it('lists root sessions only, excluding the current session and subagent children', () => {
    expect(sessionChoices(sessions, 'running-session')).toEqual([{
      value: 'untitled-session',
      label: 'untitled-session',
      description: '/workspace/tooling',
    }])
  })

  it('keeps the session id first and appends the title after the working directory', () => {
    expect(sessionChoices([sessions[0]!, sessions[2]!], undefined)).toEqual([{
      value: 'running-session',
      label: 'running-session',
      description: '/workspace/app · Ship the auth flow',
    }, {
      value: 'untitled-session',
      label: 'untitled-session',
      description: '/workspace/tooling',
    }])
    const untitled = sessions[2]!
    const { cwd, ...withoutCwd } = untitled
    void cwd
    expect(sessionChoices([withoutCwd], undefined)).toEqual([{
      value: 'untitled-session',
      label: 'untitled-session',
      description: 'untitled-session',
    }])
  })

  it('annotates rewind lineage on both the fork and its abandoned parent', () => {
    const parent: SessionSummary = {
      sessionId: 'parent-session' as SessionSummary['sessionId'],
      updatedAt: 1,
      running: false,
      blank: false,
      cwd: '/workspace/app',
      projections: { asOfSeq: 5, values: { title: 'Ship the auth flow' } },
    }
    const fork: SessionSummary = {
      sessionId: 'fork-session' as SessionSummary['sessionId'],
      parentSessionId: 'parent-session' as SessionSummary['sessionId'],
      updatedAt: 2,
      running: false,
      blank: false,
      cwd: '/workspace/app',
      projections: { asOfSeq: 3, values: { title: 'Ship the auth flow' } },
    }
    expect(sessionChoices([parent, fork], undefined)).toEqual([
      {
        value: 'parent-session',
        label: 'parent-session',
        description: '/workspace/app · Ship the auth flow · continued in fork-session',
      },
      {
        value: 'fork-session',
        label: 'fork-session',
        description: '/workspace/app · Ship the auth flow · forked from parent-session',
      },
    ])
  })

  it('joins every non-subagent branch on the parent and never counts subagent children', () => {
    const parent: SessionSummary = {
      sessionId: 'parent-session' as SessionSummary['sessionId'],
      updatedAt: 1,
      running: false,
      blank: false,
      cwd: '/workspace/app',
    }
    const branches: SessionSummary[] = ['fork-a', 'fork-b'].map((id, index) => ({
      sessionId: id as SessionSummary['sessionId'],
      parentSessionId: 'parent-session' as SessionSummary['sessionId'],
      updatedAt: 2 + index,
      running: false,
      blank: false,
    }))
    expect(sessionChoices([parent, ...branches, sessions[1]!], undefined)
      .find(choice => choice.value === 'parent-session')?.description)
      .toBe('/workspace/app · continued in fork-a, fork-b')
  })

  it('labels fork lineage in the sessions table origin column', () => {
    const fork: SessionSummary = {
      sessionId: 'fork-session' as SessionSummary['sessionId'],
      parentSessionId: 'origin-session' as SessionSummary['sessionId'],
      updatedAt: 2,
      running: false,
      blank: false,
      cwd: '/workspace/app',
    }
    expect(formatSessionList([fork], false)).toContain('fork')
    expect(formatSessionList([fork], false)).not.toContain('fork of')
  })
})
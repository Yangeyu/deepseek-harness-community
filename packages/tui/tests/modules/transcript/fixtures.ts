import type { HistoryEntry, SessionSummary } from '../../../src/runtime/session/contracts.ts'
import type { RuntimeSessionSnapshot } from '../../../src/runtime/session/snapshot.ts'
import { buildExecutionSnapshot } from '../../../src/runtime/execution/projection/index.ts'

export function state(
  events: readonly HistoryEntry[],
  running = false,
  pendingSubmissions: RuntimeSessionSnapshot['pendingSubmissions'] = [],
  assistant?: RuntimeSessionSnapshot['assistant'],
): RuntimeSessionSnapshot {
  return {
    binding: { phase: 'active', sessionId: 'session-test' as SessionSummary['sessionId'], epoch: 0 },
    sessionId: 'session-test' as SessionSummary['sessionId'],
    cwd: '/workspace',
    runState: running ? 'running' : 'idle',
    connection: { events: 'online', control: 'online' },
    events,
    assistant,
    historyHasMore: false,
    queue: [],
    pendingSubmissions,
    execution: buildExecutionSnapshot({
      sessionId: 'session-test',
      epoch: 0,
      entries: events,
      assistant,
      sessionRunning: running,
      runtimeActivities: pendingSubmissions.flatMap((submission) => {
        const activity = submission.activity
        return activity?.kind === 'vision'
          ? [{ kind: 'vision' as const, analysisId: activity.analysisId, startedAt: activity.startedAt }]
          : []
      }),
    }),
    modelCatalog: undefined,
    projections: {},
    notice: undefined,
    error: undefined,
  }
}

export function entry(value: unknown): HistoryEntry {
  return value as HistoryEntry
}

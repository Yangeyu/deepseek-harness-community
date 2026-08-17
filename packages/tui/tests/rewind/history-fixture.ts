import type {
  RewindConversationHistory,
  RewindPointInput,
} from '../../src/rewind/index.ts'

/** Mutable Session-log stand-in. RewindService may read it but never owns it. */
export class TestRewindConversationHistory implements RewindConversationHistory {
  private readonly sessions = new Map<string, Map<string, RewindPointInput>>()

  record(point: RewindPointInput): void {
    const points = this.sessions.get(point.sessionId) ?? new Map<string, RewindPointInput>()
    points.set(point.pointId, point)
    this.sessions.set(point.sessionId, points)
  }

  list(sessionId: string): readonly RewindPointInput[] {
    return [...(this.sessions.get(sessionId)?.values() ?? [])]
      .sort((left, right) => left.promptSeq - right.promptSeq)
  }

  fork(sourceSessionId: string, targetSessionId: string, beforeTurn: number): void {
    for (const point of this.list(sourceSessionId)) {
      if (point.turn >= beforeTurn) continue
      this.record({ ...point, sessionId: targetSessionId })
    }
  }
}

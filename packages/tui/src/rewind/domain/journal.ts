import type {
  CanonicalWorkspaceMutation,
  RewindEffectInput,
  RewindEffectReference,
  RewindPointInput,
  WorkspaceMutation,
  WorkspaceMutationInput,
} from '../contracts.ts'

export interface RewindJournalLimits {
  readonly history: number
  readonly maxMutationBytes: number
  readonly maxSessionBytes: number
}

interface RewindPoint {
  readonly id: string
  readonly sessionId: string
  readonly turn: number
  readonly workspaceRoot: string
  readonly prompt: string
  readonly previousTurnEndSeq?: number
  readonly createdAt: number
  readonly workspaceMutations: WorkspaceMutation[]
  readonly effects: RewindEffectReference[]
}

export interface RewindPointSnapshot {
  readonly id: string
  readonly sessionId: string
  readonly turn: number
  readonly workspaceRoot: string
  readonly prompt: string
  readonly previousTurnEndSeq?: number
  readonly createdAt: number
  readonly workspaceMutations: readonly WorkspaceMutation[]
  readonly effects: readonly RewindEffectReference[]
}

export interface RewindSelection {
  readonly point: RewindPointSnapshot
  readonly workspaceMutations: readonly WorkspaceMutation[]
  readonly effects: readonly RewindEffectReference[]
}

function effectIds(points: readonly RewindPoint[]): RewindEffectReference[] {
  return points.flatMap(point => point.effects)
}

function snapshot(point: RewindPoint): RewindPointSnapshot {
  return {
    id: point.id,
    sessionId: point.sessionId,
    turn: point.turn,
    workspaceRoot: point.workspaceRoot,
    prompt: point.prompt,
    createdAt: point.createdAt,
    ...point.previousTurnEndSeq === undefined ? {} : { previousTurnEndSeq: point.previousTurnEndSeq },
    workspaceMutations: [...point.workspaceMutations],
    effects: [...point.effects],
  }
}

/** Process-local history of turn boundaries and source-attributed effect references. */
export class RewindJournal {
  private readonly points = new Map<string, RewindPoint[]>()

  constructor(private readonly limits: RewindJournalLimits) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`rewind ${name} limit must be a positive integer`)
    }
    if (limits.maxMutationBytes > limits.maxSessionBytes) {
      throw new Error('rewind mutation byte limit cannot exceed the session byte limit')
    }
  }

  beginTurn(input: RewindPointInput): RewindEffectReference[] {
    const existing = this.points.get(input.sessionId) ?? []
    if (existing.some(point => point.turn === input.turn) || (existing.at(-1)?.turn ?? 0) > input.turn) return []
    const next: RewindPoint = {
      id: globalThis.crypto.randomUUID(),
      ...input,
      createdAt: Date.now(),
      workspaceMutations: [],
      effects: [],
    }
    const all = [...existing, next]
    const dropped = all.slice(0, Math.max(0, all.length - this.limits.history))
    this.points.set(input.sessionId, all.slice(-this.limits.history))
    return effectIds(dropped)
  }

  workspaceRoot(sessionId: string, turn: number): string | undefined {
    return this.pointFor(sessionId, turn)?.workspaceRoot
  }

  recordWorkspaceMutation(
    input: WorkspaceMutationInput,
    canonical: CanonicalWorkspaceMutation,
  ): boolean {
    const point = this.pointFor(input.sessionId, input.turn)
    if (point === undefined || point.workspaceMutations.some(mutation => mutation.callId === input.callId)) return false
    const common = {
      id: globalThis.crypto.randomUUID(),
      sourceSessionId: input.sessionId,
      sourceTurn: input.turn,
      callId: input.callId,
      rootCallId: input.rootCallId,
      order: input.order,
      path: canonical.path,
      createdAt: Date.now(),
    }
    if (canonical.kind === 'unsupported') {
      point.workspaceMutations.push({ ...common, kind: 'unsupported', reason: canonical.reason })
      return true
    }
    const sessionBytes = this.sessionBytes(input.sessionId)
    const reason = canonical.bytes > this.limits.maxMutationBytes
      ? `The reversible edit exceeds the ${String(this.limits.maxMutationBytes)} byte mutation limit.`
      : sessionBytes + canonical.bytes > this.limits.maxSessionBytes
        ? `The session exceeds the ${String(this.limits.maxSessionBytes)} byte Rewind history limit.`
        : undefined
    if (reason !== undefined) {
      point.workspaceMutations.push({ ...common, kind: 'unsupported', reason })
      return true
    }
    point.workspaceMutations.push({
      ...common,
      kind: 'reversible',
      before: canonical.before,
      after: canonical.after,
      bytes: canonical.bytes,
    })
    return true
  }

  recordEffect(input: RewindEffectInput): 'recorded' | 'duplicate' | 'missing-point' {
    const retained = [...this.points.values()].some(points => points.some(candidate => candidate.effects.some(effect => (
      effect.participantId === input.participantId && effect.effectId === input.effectId
    ))))
    if (retained) return 'duplicate'
    const point = this.pointFor(input.sourceSessionId, input.sourceTurn)
    if (point === undefined) return 'missing-point'
    point.effects.push({ ...input })
    return 'recorded'
  }

  list(sessionId: string): RewindPointSnapshot[] {
    return this.requirePoints(sessionId).map(snapshot)
  }

  select(sessionId: string, pointId: string): RewindSelection {
    const points = this.requirePoints(sessionId)
    const pointIndex = points.findIndex(candidate => candidate.id === pointId)
    const point = points[pointIndex]
    if (point === undefined) throw new Error('the selected rewind point is no longer available')
    const selected = points.slice(pointIndex)
    return {
      point: snapshot(point),
      workspaceMutations: selected
        .flatMap(candidate => candidate.workspaceMutations)
        .sort((left, right) => left.order - right.order),
      effects: selected.flatMap(candidate => candidate.effects),
    }
  }

  continueFrom(sessionId: string, pointId: string, targetSessionId: string): RewindEffectReference[] {
    if (sessionId === targetSessionId) throw new Error('rewind must continue in a distinct conversation session')
    const points = this.points.get(sessionId)
    const selectedIndex = points?.findIndex(point => point.id === pointId) ?? -1
    if (selectedIndex === -1 || points === undefined) throw new Error('the restored rewind point is no longer available')
    const ancestors = points.slice(0, selectedIndex).map(point => ({ ...point, sessionId: targetSessionId }))
    const released = [
      ...effectIds(points.slice(selectedIndex)),
      ...effectIds(this.points.get(targetSessionId) ?? []),
    ]
    this.points.delete(sessionId)
    if (ancestors.length === 0) this.points.delete(targetSessionId)
    else this.points.set(targetSessionId, ancestors)
    return released
  }

  private sessionBytes(sessionId: string): number {
    return (this.points.get(sessionId) ?? []).reduce((total, point) => (
      total + point.workspaceMutations.reduce((pointTotal, mutation) => (
        pointTotal + (mutation.kind === 'reversible' ? mutation.bytes : 0)
      ), 0)
    ), 0)
  }

  private pointFor(sessionId: string, turn: number): RewindPoint | undefined {
    return this.points.get(sessionId)?.find(point => point.turn === turn)
  }

  private requirePoints(sessionId: string): RewindPoint[] {
    const points = this.points.get(sessionId)
    if (points !== undefined && points.length > 0) return points
    throw new Error('no rewind point is available for this session')
  }
}

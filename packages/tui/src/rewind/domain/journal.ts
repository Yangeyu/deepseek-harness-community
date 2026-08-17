import type {
  CanonicalWorkspaceMutation,
  RewindEffectInput,
  RewindEffectReference,
  RewindPointInput,
  RewindPromptInput,
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
  /** Session that originally admitted this Prompt. */
  readonly sessionId: string
  readonly turn: number
  readonly workspaceRoot: string
  input: RewindPromptInput
  readonly promptSeq: number
  readonly previousTurnEndSeq?: number
  readonly createdAt: number
  readonly workspaceMutations: WorkspaceMutation[]
  readonly effects: RewindEffectReference[]
}

interface RewindTimeline {
  readonly lineageId: string
  readonly workspaceRoot: string
  ownerSessionId: string
  cursor: number
  updatedAt: number
  readonly nodes: RewindPoint[]
}

export interface RewindPointSnapshot {
  readonly id: string
  readonly sessionId: string
  readonly turn: number
  readonly workspaceRoot: string
  readonly input: RewindPromptInput
  readonly promptSeq: number
  readonly previousTurnEndSeq?: number
  readonly createdAt: number
  readonly workspaceMutations: readonly WorkspaceMutation[]
  readonly effects: readonly RewindEffectReference[]
}

/** Version-independent domain state persisted through a Repository adapter. */
export interface RewindTimelineSnapshot {
  readonly lineageId: string
  readonly workspaceRoot: string
  readonly ownerSessionId: string
  /** Number of nodes whose effects are present in the current workspace state. */
  readonly cursor: number
  readonly updatedAt: number
  readonly nodes: readonly RewindPointSnapshot[]
}

export interface RewindSelection {
  readonly point: RewindPointSnapshot
  readonly workspaceMutations: readonly WorkspaceMutation[]
  readonly effects: readonly RewindEffectReference[]
}

export interface RewindJournalMutationResult {
  readonly recorded: boolean
  readonly workspaceRoot?: string
  readonly released: readonly RewindEffectReference[]
}

export interface RewindJournalPointResult {
  readonly changed: boolean
  readonly durable: boolean
  readonly workspaceRoot: string
  readonly released: readonly RewindEffectReference[]
}

function effectIds(points: readonly RewindPoint[]): RewindEffectReference[] {
  return points.flatMap(point => point.effects)
}

function copyInput(input: RewindPromptInput): RewindPromptInput {
  return {
    text: input.text,
    attachments: input.attachments.map(attachment => ({ ...attachment })),
  }
}

function snapshot(point: RewindPoint, sessionId = point.sessionId): RewindPointSnapshot {
  return {
    id: point.id,
    sessionId,
    turn: point.turn,
    workspaceRoot: point.workspaceRoot,
    input: copyInput(point.input),
    promptSeq: point.promptSeq,
    createdAt: point.createdAt,
    ...point.previousTurnEndSeq === undefined ? {} : { previousTurnEndSeq: point.previousTurnEndSeq },
    workspaceMutations: point.workspaceMutations.map(mutation => ({ ...mutation })),
    effects: point.effects.map(effect => ({ ...effect })),
  }
}

function mutablePoint(point: RewindPointSnapshot): RewindPoint {
  return {
    id: point.id,
    sessionId: point.sessionId,
    turn: point.turn,
    workspaceRoot: point.workspaceRoot,
    input: copyInput(point.input),
    promptSeq: point.promptSeq,
    createdAt: point.createdAt,
    ...point.previousTurnEndSeq === undefined ? {} : { previousTurnEndSeq: point.previousTurnEndSeq },
    workspaceMutations: point.workspaceMutations.map(mutation => ({ ...mutation })),
    effects: point.effects.map(effect => ({ ...effect })),
  }
}

function newPoint(input: RewindPointInput): RewindPoint {
  return {
    id: input.pointId,
    sessionId: input.sessionId,
    turn: input.turn,
    workspaceRoot: input.workspaceRoot,
    input: copyInput(input.input),
    promptSeq: input.promptSeq,
    createdAt: input.createdAt,
    ...input.previousTurnEndSeq === undefined ? {} : { previousTurnEndSeq: input.previousTurnEndSeq },
    workspaceMutations: [],
    effects: [],
  }
}

function validatePoint(input: RewindPointInput): void {
  if (input.pointId.trim() === '') throw new Error('rewind point identity must not be empty')
  if (input.sessionId.trim() === '') throw new Error('rewind point session identity must not be empty')
  if (input.workspaceRoot.trim() === '') throw new Error('rewind point workspace root must not be empty')
  if (!Number.isSafeInteger(input.turn) || input.turn < 1) throw new Error('rewind point turn must be a positive integer')
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new Error('rewind point creation time must be a non-negative integer')
  }
  if (!Number.isSafeInteger(input.promptSeq) || input.promptSeq < 0) {
    throw new Error('rewind point Prompt seq must be a non-negative integer')
  }
  if (input.previousTurnEndSeq !== undefined
    && (!Number.isSafeInteger(input.previousTurnEndSeq)
      || input.previousTurnEndSeq < 0
      || input.previousTurnEndSeq >= input.promptSeq)) {
    throw new Error('rewind point conversation boundary must precede its Prompt')
  }
  if (input.input.text.trim() === '') throw new Error('rewind point prompt text must not be empty')
  const attachmentIds = new Set<string>()
  for (const attachment of input.input.attachments) {
    const id = String(attachment.attachmentId)
    if (id.trim() === '' || attachmentIds.has(id)) throw new Error('rewind point attachment identity is invalid')
    attachmentIds.add(id)
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachment.mediaType)
      || !Number.isSafeInteger(attachment.bytes) || attachment.bytes < 1
      || !Number.isSafeInteger(attachment.width) || attachment.width < 1
      || !Number.isSafeInteger(attachment.height) || attachment.height < 1
      || (attachment.name !== undefined && attachment.name.trim() === '')) {
      throw new Error('rewind point attachment metadata is invalid')
    }
  }
}

function sameAttachment(
  left: RewindPromptInput['attachments'][number],
  right: RewindPromptInput['attachments'][number],
): boolean {
  return String(left.attachmentId) === String(right.attachmentId)
    && left.mediaType === right.mediaType
    && left.bytes === right.bytes
    && left.width === right.width
    && left.height === right.height
    && left.name === right.name
}

function enrichPoint(point: RewindPoint, input: RewindPointInput): boolean {
  if (point.id !== input.pointId
    || point.sessionId !== input.sessionId
    || point.turn !== input.turn
    || point.workspaceRoot !== input.workspaceRoot
    || point.promptSeq !== input.promptSeq
    || point.createdAt !== input.createdAt
    || point.previousTurnEndSeq !== input.previousTurnEndSeq
    || point.input.text !== input.input.text) {
    throw new Error('rewind point update conflicts with its admitted Prompt')
  }
  const attachments = new Map(point.input.attachments.map(attachment => [String(attachment.attachmentId), attachment]))
  let changed = false
  for (const attachment of input.input.attachments) {
    const id = String(attachment.attachmentId)
    const existing = attachments.get(id)
    if (existing !== undefined) {
      if (!sameAttachment(existing, attachment)) throw new Error('rewind point attachment metadata changed')
      continue
    }
    attachments.set(id, { ...attachment })
    changed = true
  }
  if (changed) point.input = { text: point.input.text, attachments: [...attachments.values()] }
  return changed
}

/**
 * One active, bounded editing timeline per workspace. Future nodes survive a
 * navigation until the restored session admits a new durable Prompt.
 */
export class RewindJournal {
  private readonly timelines = new Map<string, RewindTimeline>()
  private readonly pending = new Map<string, RewindPoint[]>()

  constructor(private readonly limits: RewindJournalLimits) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`rewind ${name} limit must be a positive integer`)
    }
    if (limits.maxMutationBytes > limits.maxSessionBytes) {
      throw new Error('rewind mutation byte limit cannot exceed the session byte limit')
    }
  }

  /** Restore one durable timeline without exposing its storage representation. */
  hydrate(input: RewindTimelineSnapshot): void {
    if (input.lineageId.trim() === ''
      || input.workspaceRoot.trim() === ''
      || input.ownerSessionId.trim() === '') {
      throw new Error('rewind timeline identity is invalid')
    }
    if (!Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0) {
      throw new Error('rewind timeline update time is invalid')
    }
    if (input.cursor < 0 || input.cursor > input.nodes.length || !Number.isSafeInteger(input.cursor)) {
      throw new Error('rewind timeline cursor is invalid')
    }
    if (input.nodes.some(point => point.workspaceRoot !== input.workspaceRoot)) {
      throw new Error('rewind timeline contains a foreign workspace root')
    }
    const pointIds = new Set<string>()
    const turnKeys = new Set<string>()
    for (const point of input.nodes) {
      validatePoint({
        pointId: point.id,
        sessionId: point.sessionId,
        turn: point.turn,
        workspaceRoot: point.workspaceRoot,
        input: point.input,
        promptSeq: point.promptSeq,
        createdAt: point.createdAt,
        ...point.previousTurnEndSeq === undefined ? {} : { previousTurnEndSeq: point.previousTurnEndSeq },
      })
      const turnKey = `${point.sessionId}\u0000${String(point.turn)}`
      if (pointIds.has(point.id) || turnKeys.has(turnKey)) {
        throw new Error('rewind timeline contains duplicate Prompt identity')
      }
      pointIds.add(point.id)
      turnKeys.add(turnKey)
    }
    const nodes = input.nodes.map(mutablePoint)
    let cursor = input.cursor
    const dropped = Math.max(0, nodes.length - this.limits.history)
    if (dropped > 0) {
      nodes.splice(0, dropped)
      cursor = Math.max(0, cursor - dropped)
    }
    this.timelines.set(input.workspaceRoot, {
      lineageId: input.lineageId,
      workspaceRoot: input.workspaceRoot,
      ownerSessionId: input.ownerSessionId,
      cursor,
      updatedAt: input.updatedAt,
      nodes,
    })
  }

  /** Snapshot all retained nodes, including the future segment after cursor. */
  snapshot(workspaceRoot: string): RewindTimelineSnapshot | undefined {
    const timeline = this.timelines.get(workspaceRoot)
    if (timeline === undefined) return undefined
    return {
      lineageId: timeline.lineageId,
      workspaceRoot: timeline.workspaceRoot,
      ownerSessionId: timeline.ownerSessionId,
      cursor: timeline.cursor,
      updatedAt: timeline.updatedAt,
      nodes: timeline.nodes.map(point => snapshot(point)),
    }
  }

  /** Register a prompt boundary, retaining it durably only for the active workspace owner. */
  recordPoint(input: RewindPointInput): RewindJournalPointResult {
    validatePoint(input)
    const timeline = this.timelines.get(input.workspaceRoot)
    if (timeline === undefined) {
      const created: RewindTimeline = {
        lineageId: globalThis.crypto.randomUUID(),
        workspaceRoot: input.workspaceRoot,
        ownerSessionId: input.sessionId,
        cursor: 0,
        updatedAt: Date.now(),
        nodes: [],
      }
      this.timelines.set(input.workspaceRoot, created)
      const released = this.append(created, input)
      return { changed: true, durable: true, workspaceRoot: input.workspaceRoot, released }
    }
    if (timeline.ownerSessionId === input.sessionId) {
      const applied = timeline.nodes.slice(0, timeline.cursor)
      const existing = applied.find(point => point.id === input.pointId
        || (point.sessionId === input.sessionId && point.turn === input.turn))
      if (existing !== undefined) {
        const changed = enrichPoint(existing, input)
        if (changed) timeline.updatedAt = Date.now()
        return { changed, durable: true, workspaceRoot: input.workspaceRoot, released: [] }
      }
      if ((applied.filter(point => point.sessionId === input.sessionId).at(-1)?.turn ?? 0) > input.turn) {
        return { changed: false, durable: true, workspaceRoot: input.workspaceRoot, released: [] }
      }
      const future = timeline.nodes.splice(timeline.cursor)
      const released = [...effectIds(future), ...this.append(timeline, input)]
      return { changed: true, durable: true, workspaceRoot: input.workspaceRoot, released }
    }

    const existing = this.pending.get(input.sessionId) ?? []
    const pendingPoint = existing.find(point => point.id === input.pointId || point.turn === input.turn)
    if (pendingPoint !== undefined) {
      return {
        changed: enrichPoint(pendingPoint, input),
        durable: false,
        workspaceRoot: input.workspaceRoot,
        released: [],
      }
    }
    if ((existing.at(-1)?.turn ?? 0) > input.turn) {
      return { changed: false, durable: false, workspaceRoot: input.workspaceRoot, released: [] }
    }
    const next = [...existing, newPoint(input)].slice(-this.limits.history)
    this.pending.set(input.sessionId, next)
    return { changed: true, durable: false, workspaceRoot: input.workspaceRoot, released: [] }
  }

  workspaceRoot(sessionId: string, turn: number): string | undefined {
    const timeline = this.timelineForOwner(sessionId)
    const active = timeline?.nodes.slice(0, timeline.cursor)
      .find(point => point.sessionId === sessionId && point.turn === turn)
    if (active !== undefined) return active.workspaceRoot
    return this.pending.get(sessionId)?.find(point => point.turn === turn)?.workspaceRoot
  }

  recordWorkspaceMutation(
    input: WorkspaceMutationInput,
    canonical: CanonicalWorkspaceMutation,
  ): RewindJournalMutationResult {
    const claimed = this.claimPending(input.sessionId)
    const point = this.pointFor(input.sessionId, input.turn)
    if (point === undefined || point.workspaceMutations.some(mutation => mutation.callId === input.callId)) {
      return { recorded: false, released: claimed.released, ...claimed.workspaceRoot === undefined ? {} : { workspaceRoot: claimed.workspaceRoot } }
    }
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
      this.touch(claimed.workspaceRoot)
      return { recorded: true, workspaceRoot: point.workspaceRoot, released: claimed.released }
    }
    const timeline = this.timelineForOwner(input.sessionId)
    const currentBytes = timeline === undefined ? 0 : this.timelineBytes(timeline)
    const reason = canonical.bytes > this.limits.maxMutationBytes
      ? `The reversible edit exceeds the ${String(this.limits.maxMutationBytes)} byte mutation limit.`
      : currentBytes + canonical.bytes > this.limits.maxSessionBytes
        ? `The timeline exceeds the ${String(this.limits.maxSessionBytes)} byte Rewind history limit.`
        : undefined
    if (reason !== undefined) {
      point.workspaceMutations.push({ ...common, kind: 'unsupported', reason })
    } else {
      point.workspaceMutations.push({
        ...common,
        kind: 'reversible',
        before: canonical.before,
        after: canonical.after,
        bytes: canonical.bytes,
      })
    }
    this.touch(point.workspaceRoot)
    return { recorded: true, workspaceRoot: point.workspaceRoot, released: claimed.released }
  }

  recordEffect(input: RewindEffectInput): RewindJournalMutationResult & { readonly status: 'recorded' | 'duplicate' | 'missing-point' } {
    const retained = [...this.timelines.values()].some(timeline => timeline.nodes.some(candidate => candidate.effects.some(effect => (
      effect.participantId === input.participantId && effect.effectId === input.effectId
    )))) || [...this.pending.values()].some(points => points.some(candidate => candidate.effects.some(effect => (
      effect.participantId === input.participantId && effect.effectId === input.effectId
    ))))
    if (retained) return { status: 'duplicate', recorded: false, released: [] }
    const claimed = this.claimPending(input.sourceSessionId)
    const point = this.pointFor(input.sourceSessionId, input.sourceTurn)
    if (point === undefined) {
      return { status: 'missing-point', recorded: false, released: claimed.released, ...claimed.workspaceRoot === undefined ? {} : { workspaceRoot: claimed.workspaceRoot } }
    }
    point.effects.push({ ...input })
    this.touch(point.workspaceRoot)
    return { status: 'recorded', recorded: true, workspaceRoot: point.workspaceRoot, released: claimed.released }
  }

  list(sessionId: string): RewindPointSnapshot[] {
    const timeline = this.requireTimeline(sessionId)
    const points = timeline.nodes.slice(0, timeline.cursor)
    if (points.length === 0) throw new Error('no rewind point is available for this session')
    return points.map(point => snapshot(point, sessionId))
  }

  select(sessionId: string, pointId: string): RewindSelection {
    const timeline = this.requireTimeline(sessionId)
    const applied = timeline.nodes.slice(0, timeline.cursor)
    const pointIndex = applied.findIndex(candidate => candidate.id === pointId)
    const point = applied[pointIndex]
    if (point === undefined) throw new Error('the selected rewind point is no longer available')
    const selected = applied.slice(pointIndex)
    return {
      point: snapshot(point, sessionId),
      workspaceMutations: selected
        .flatMap(candidate => candidate.workspaceMutations)
        .sort((left, right) => left.order - right.order),
      effects: selected.flatMap(candidate => candidate.effects),
    }
  }

  /** Move the cursor without deleting the future segment. */
  continueFrom(sessionId: string, pointId: string, targetSessionId: string): string {
    if (sessionId === targetSessionId) throw new Error('rewind must continue in a distinct conversation session')
    const timeline = this.requireTimeline(sessionId)
    const selectedIndex = timeline.nodes.slice(0, timeline.cursor).findIndex(point => point.id === pointId)
    if (selectedIndex === -1) throw new Error('the restored rewind point is no longer available')
    timeline.cursor = selectedIndex
    timeline.ownerSessionId = targetSessionId
    timeline.updatedAt = Date.now()
    this.pending.delete(targetSessionId)
    return timeline.workspaceRoot
  }

  timelineRoot(sessionId: string): string | undefined {
    return this.timelineForOwner(sessionId)?.workspaceRoot
  }

  allEffects(workspaceRoot: string): RewindEffectReference[] {
    return effectIds(this.timelines.get(workspaceRoot)?.nodes ?? [])
  }

  ownerSessionIds(): string[] {
    return [...new Set([...this.timelines.values()].map(timeline => timeline.ownerSessionId))]
  }

  private append(timeline: RewindTimeline, input: RewindPointInput): RewindEffectReference[] {
    timeline.nodes.push(newPoint(input))
    timeline.cursor = timeline.nodes.length
    timeline.updatedAt = Date.now()
    const dropped = Math.max(0, timeline.nodes.length - this.limits.history)
    if (dropped === 0) return []
    const removed = timeline.nodes.splice(0, dropped)
    timeline.cursor = Math.max(0, timeline.cursor - dropped)
    return effectIds(removed)
  }

  private claimPending(sessionId: string): { readonly workspaceRoot?: string; readonly released: readonly RewindEffectReference[] } {
    const pending = this.pending.get(sessionId)
    if (pending === undefined || pending.length === 0) {
      const workspaceRoot = this.timelineForOwner(sessionId)?.workspaceRoot
      return workspaceRoot === undefined ? { released: [] } : { workspaceRoot, released: [] }
    }
    const workspaceRoot = pending[0]?.workspaceRoot
    if (workspaceRoot === undefined || pending.some(point => point.workspaceRoot !== workspaceRoot)) {
      this.pending.delete(sessionId)
      return { released: [] }
    }
    const previous = this.timelines.get(workspaceRoot)
    const released = previous === undefined ? [] : effectIds(previous.nodes)
    this.timelines.set(workspaceRoot, {
      lineageId: globalThis.crypto.randomUUID(),
      workspaceRoot,
      ownerSessionId: sessionId,
      cursor: pending.length,
      updatedAt: Date.now(),
      nodes: pending,
    })
    this.pending.delete(sessionId)
    return { workspaceRoot, released }
  }

  private timelineForOwner(sessionId: string): RewindTimeline | undefined {
    return [...this.timelines.values()].find(timeline => timeline.ownerSessionId === sessionId)
  }

  private requireTimeline(sessionId: string): RewindTimeline {
    const timeline = this.timelineForOwner(sessionId)
    if (timeline !== undefined) return timeline
    throw new Error('no rewind point is available for this session')
  }

  private pointFor(sessionId: string, turn: number): RewindPoint | undefined {
    const timeline = this.timelineForOwner(sessionId)
    const active = timeline?.nodes.slice(0, timeline.cursor)
      .find(point => point.sessionId === sessionId && point.turn === turn)
    if (active !== undefined) return active
    return this.pending.get(sessionId)?.find(point => point.turn === turn)
  }

  private timelineBytes(timeline: RewindTimeline): number {
    return timeline.nodes.reduce((total, point) => total + point.workspaceMutations.reduce((pointTotal, mutation) => (
      pointTotal + (mutation.kind === 'reversible' ? mutation.bytes : 0)
    ), 0), 0)
  }

  private touch(workspaceRoot: string | undefined): void {
    const timeline = workspaceRoot === undefined ? undefined : this.timelines.get(workspaceRoot)
    if (timeline !== undefined) timeline.updatedAt = Date.now()
  }
}

import type {
  CanonicalWorkspaceMutation,
  RewindEffectInput,
  RewindEffectReference,
  RewindAction,
  RewindCodeScope,
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

export interface RewindEffectSelection {
  readonly codeScope: RewindCodeScope
  readonly codeReason?: string
  readonly lineageId?: string
  readonly workspaceRoot?: string
  readonly workspaceMutations: readonly WorkspaceMutation[]
  readonly effects: readonly RewindEffectReference[]
}

export interface RewindJournalClaimResult {
  readonly changed: boolean
  readonly workspaceRoot: string
  readonly released: readonly RewindEffectReference[]
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
 * One active, bounded reversible-effect lineage per workspace. Prompt visibility
 * belongs to the Session log; this journal only indexes checkpoints needed to
 * attribute, restore, and branch code or participant effects.
 */
export class RewindJournal {
  private readonly timelines = new Map<string, RewindTimeline>()

  constructor(private readonly limits: RewindJournalLimits) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`rewind ${name} limit must be a positive integer`)
    }
    if (limits.maxMutationBytes > limits.maxSessionBytes) {
      throw new Error('rewind mutation byte limit cannot exceed the session byte limit')
    }
  }

  /** Restore one durable effect lineage without making it a conversation source of truth. */
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

  /** Snapshot all effect checkpoints, including the retained future after the cursor. */
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

  /** Observe a Prompt only when it belongs to the active effect lineage. */
  recordPoint(input: RewindPointInput): RewindJournalPointResult {
    validatePoint(input)
    const timeline = this.timelines.get(input.workspaceRoot)
    if (timeline === undefined) {
      const created = this.timeline(input.sessionId, input.workspaceRoot, [input])
      this.timelines.set(input.workspaceRoot, created)
      return { changed: true, durable: true, workspaceRoot: input.workspaceRoot, released: [] }
    }
    if (timeline.ownerSessionId !== input.sessionId) {
      return { changed: false, durable: false, workspaceRoot: input.workspaceRoot, released: [] }
    }
    const retained = timeline.nodes.find(point => point.id === input.pointId)
    if (retained !== undefined) {
      const changed = retained.sessionId === input.sessionId && enrichPoint(retained, input)
      if (changed) timeline.updatedAt = Date.now()
      return { changed, durable: true, workspaceRoot: input.workspaceRoot, released: [] }
    }
    const applied = timeline.nodes.slice(0, timeline.cursor)
    const latestForSession = applied.filter(point => point.sessionId === input.sessionId).at(-1)
    if ((latestForSession?.turn ?? 0) > input.turn) {
      return { changed: false, durable: true, workspaceRoot: input.workspaceRoot, released: [] }
    }
    const future = timeline.nodes.splice(timeline.cursor)
    const released = [...effectIds(future), ...this.append(timeline, input)]
    return { changed: true, durable: true, workspaceRoot: input.workspaceRoot, released }
  }

  /** Atomically make one Session's canonical checkpoints the active effect lineage. */
  claim(sessionId: string, points: readonly RewindPointInput[]): RewindJournalClaimResult {
    if (points.length === 0) throw new Error('cannot claim a Rewind lineage without Prompt checkpoints')
    const ordered = [...points].sort((left, right) => left.promptSeq - right.promptSeq)
    for (const point of ordered) {
      validatePoint(point)
      if (point.sessionId !== sessionId) throw new Error('rewind lineage contains a foreign session')
    }
    const workspaceRoot = ordered[0]?.workspaceRoot
    if (workspaceRoot === undefined || ordered.some(point => point.workspaceRoot !== workspaceRoot)) {
      throw new Error('rewind lineage contains multiple workspace roots')
    }
    const current = this.timelines.get(workspaceRoot)
    if (current?.ownerSessionId === sessionId) {
      let changed = false
      const released: RewindEffectReference[] = []
      for (const point of ordered) {
        const recorded = this.recordPoint(point)
        changed = recorded.changed || changed
        released.push(...recorded.released)
      }
      return { changed, workspaceRoot, released }
    }
    const released = current === undefined ? [] : effectIds(current.nodes)
    this.timelines.set(workspaceRoot, this.timeline(sessionId, workspaceRoot, ordered))
    return { changed: true, workspaceRoot, released }
  }

  recordWorkspaceMutation(
    input: WorkspaceMutationInput,
    canonical: CanonicalWorkspaceMutation,
  ): RewindJournalMutationResult {
    const point = this.pointFor(input.sessionId, input.turn)
    if (point === undefined || point.workspaceMutations.some(mutation => mutation.callId === input.callId)) {
      return { recorded: false, released: [] }
    }
    const common = {
      id: globalThis.crypto.randomUUID(),
      sourceSessionId: input.sessionId,
      sourceTurn: input.turn,
      callId: input.callId,
      rootCallId: input.rootCallId,
      order: input.order,
      absolutePath: canonical.absolutePath,
      createdAt: Date.now(),
    }
    if (canonical.kind === 'unsupported') {
      point.workspaceMutations.push({ ...common, kind: 'unsupported', reason: canonical.reason })
      this.touch(point.workspaceRoot)
      return { recorded: true, workspaceRoot: point.workspaceRoot, released: [] }
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
    return { recorded: true, workspaceRoot: point.workspaceRoot, released: [] }
  }

  recordEffect(input: RewindEffectInput): RewindJournalMutationResult & { readonly status: 'recorded' | 'duplicate' | 'missing-point' } {
    const retained = [...this.timelines.values()].some(timeline => timeline.nodes.some(candidate => candidate.effects.some(effect => (
      effect.participantId === input.participantId && effect.effectId === input.effectId
    ))))
    if (retained) return { status: 'duplicate', recorded: false, released: [] }
    const point = this.pointFor(input.sourceSessionId, input.sourceTurn)
    if (point === undefined) return { status: 'missing-point', recorded: false, released: [] }
    point.effects.push({ ...input })
    this.touch(point.workspaceRoot)
    return { status: 'recorded', recorded: true, workspaceRoot: point.workspaceRoot, released: [] }
  }

  /** Active effect metadata used only to annotate canonical Session checkpoints. */
  activePoints(sessionId: string): RewindPointSnapshot[] {
    const timeline = this.timelineForOwner(sessionId)
    return (timeline?.nodes.slice(0, timeline.cursor) ?? []).map(point => snapshot(point))
  }

  selectEffects(sessionId: string, pointId: string): RewindEffectSelection {
    const timeline = this.timelineForOwner(sessionId)
    if (timeline === undefined) return { codeScope: 'none', workspaceMutations: [], effects: [] }
    const pointIndex = timeline.nodes.findIndex(candidate => candidate.id === pointId)
    if (pointIndex === -1) {
      return {
        codeScope: 'none',
        lineageId: timeline.lineageId,
        workspaceRoot: timeline.workspaceRoot,
        workspaceMutations: [],
        effects: [],
      }
    }
    if (pointIndex >= timeline.cursor) {
      return {
        codeScope: 'forward-unavailable',
        codeReason: 'The code checkpoint is ahead of the current Rewind cursor; forward code restore is not available yet.',
        lineageId: timeline.lineageId,
        workspaceRoot: timeline.workspaceRoot,
        workspaceMutations: [],
        effects: [],
      }
    }
    const selected = timeline.nodes.slice(pointIndex, timeline.cursor)
    const workspaceMutations = selected
      .flatMap(candidate => candidate.workspaceMutations)
      .sort((left, right) => left.order - right.order)
    const effects = selected.flatMap(candidate => candidate.effects)
    if (workspaceMutations.length === 0 && effects.length === 0) {
      return {
        codeScope: 'none',
        codeReason: 'No source-attributed code or participant effects are retained for this checkpoint.',
        lineageId: timeline.lineageId,
        workspaceRoot: timeline.workspaceRoot,
        workspaceMutations,
        effects,
      }
    }
    return {
      codeScope: 'backward',
      lineageId: timeline.lineageId,
      workspaceRoot: timeline.workspaceRoot,
      workspaceMutations,
      effects,
    }
  }

  /** Commit the independently selected conversation and code dimensions. */
  commit(
    sessionId: string,
    pointId: string,
    action: RewindAction,
    targetSessionId?: string,
    expectedLineageId?: string,
  ): string | undefined {
    const timeline = this.timelineForOwner(sessionId)
    if (timeline === undefined) {
      if (expectedLineageId !== undefined) {
        throw new Error('the active code lineage changed after the Rewind plan was prepared')
      }
      return undefined
    }
    if (expectedLineageId !== undefined && timeline.lineageId !== expectedLineageId) {
      throw new Error('the active code lineage changed after the Rewind plan was prepared')
    }
    const includesConversation = action !== 'code-only'
    const includesCode = action !== 'conversation-only'
    if (includesConversation) {
      if (targetSessionId === undefined || targetSessionId === sessionId) {
        throw new Error('conversation rewind must continue in a distinct session')
      }
      timeline.ownerSessionId = targetSessionId
    } else if (targetSessionId !== undefined) {
      throw new Error('code-only rewind must not replace the conversation session')
    }
    if (includesCode) {
      const selectedIndex = timeline.nodes.slice(0, timeline.cursor).findIndex(point => point.id === pointId)
      if (selectedIndex !== -1) timeline.cursor = selectedIndex
    }
    timeline.updatedAt = Date.now()
    return timeline.workspaceRoot
  }

  allEffects(workspaceRoot: string): RewindEffectReference[] {
    return effectIds(this.timelines.get(workspaceRoot)?.nodes ?? [])
  }

  ownerSessionIds(): string[] {
    return [...new Set([...this.timelines.values()].map(timeline => timeline.ownerSessionId))]
  }

  private timeline(
    ownerSessionId: string,
    workspaceRoot: string,
    points: readonly RewindPointInput[],
  ): RewindTimeline {
    const nodes = points.slice(-this.limits.history).map(newPoint)
    return {
      lineageId: globalThis.crypto.randomUUID(),
      workspaceRoot,
      ownerSessionId,
      cursor: nodes.length,
      updatedAt: Date.now(),
      nodes,
    }
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

  private timelineForOwner(sessionId: string): RewindTimeline | undefined {
    return [...this.timelines.values()].find(timeline => timeline.ownerSessionId === sessionId)
  }

  private pointFor(sessionId: string, turn: number): RewindPoint | undefined {
    const timeline = this.timelineForOwner(sessionId)
    return timeline?.nodes.slice(0, timeline.cursor)
      .find(point => point.sessionId === sessionId && point.turn === turn)
  }

  private timelineBytes(timeline: RewindTimeline): number {
    return timeline.nodes.reduce((total, point) => total + point.workspaceMutations.reduce((pointTotal, mutation) => (
      pointTotal + (mutation.kind === 'reversible' ? mutation.bytes : 0)
    ), 0), 0)
  }

  private touch(workspaceRoot: string): void {
    const timeline = this.timelines.get(workspaceRoot)
    if (timeline !== undefined) timeline.updatedAt = Date.now()
  }
}

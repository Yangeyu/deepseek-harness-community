import type {
  PreparedRewindParticipant,
  PreparedWorkspaceRewind,
  RewindAction,
  RewindCompensation,
  RewindConversationHistory,
  RewindEffectInput,
  RewindEffectReference,
  RewindEffectSink,
  RewindPointSink,
  RewindParticipant,
  RewindParticipantImpact,
  RewindPlan,
  RewindPlanState,
  RewindPointInput,
  RewindPointSummary,
  RewindPort,
  WorkspaceMutationInput,
  RewindWorkspaceSink,
  WorkspaceRewindBackend,
} from '../contracts.ts'
import { RewindJournal, type RewindEffectSelection } from '../domain/journal.ts'
import {
  type RewindRepository,
  RewindRepositoryConflictError,
  type StoredRewindTimeline,
  VolatileRewindRepository,
} from './repository.ts'

const DEFAULT_MAX_MUTATION_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_SESSION_BYTES = 64 * 1024 * 1024

export interface RewindServiceOptions {
  readonly history: number
  readonly maxMutationBytes?: number
  readonly maxSessionBytes?: number
  readonly onIngestionError?: (error: unknown) => void
  readonly onPersistenceError?: (error: unknown) => void
}

interface PreparedPlan {
  readonly plan: RewindPlan
  readonly workspace: PreparedWorkspaceRewind
  readonly participants: readonly PreparedRewindParticipant[]
  readonly lineageId?: string
}

function aggregateState(states: readonly RewindPlanState[]): RewindPlanState {
  if (states.includes('unsupported')) return 'unsupported'
  if (states.includes('conflict')) return 'conflict'
  if (states.includes('mergeable')) return 'mergeable'
  return 'safe'
}

async function compensate(compensations: readonly RewindCompensation[]): Promise<void> {
  const failures: unknown[] = []
  for (const compensation of [...compensations].reverse()) {
    try {
      await compensation()
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new Error(`rewind compensation failed: ${failures.map(String).join('; ')}`)
}

function immutableParticipant(plan: RewindParticipantImpact): RewindParticipantImpact {
  return Object.freeze({ ...plan })
}

/** Transport-neutral Rewind use case composed from a journal and explicit adapters. */
export class RewindService implements RewindPort, RewindPointSink, RewindWorkspaceSink, RewindEffectSink {
  private readonly journal: RewindJournal
  private readonly participants: readonly RewindParticipant[]
  private readonly participantsById: ReadonlyMap<string, RewindParticipant>
  private readonly prepared = new Map<string, PreparedPlan>()
  private readonly activatedRoots = new Set<string>()
  private readonly activationTasks = new Map<string, Promise<void>>()
  private readonly persistenceDisabled = new Set<string>()
  private readonly revisions = new Map<string, string | null>()
  private readonly ingestionTails = new Map<string, Promise<void>>()
  private writeTail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly options: RewindServiceOptions,
    private readonly conversationHistory: RewindConversationHistory,
    private readonly workspace: WorkspaceRewindBackend,
    participants: readonly RewindParticipant[] = [],
    private readonly repository: RewindRepository = new VolatileRewindRepository(),
  ) {
    this.journal = new RewindJournal({
      history: options.history,
      maxMutationBytes: options.maxMutationBytes ?? DEFAULT_MAX_MUTATION_BYTES,
      maxSessionBytes: options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES,
    })
    const ids = new Set<string>()
    for (const participant of participants) {
      if (ids.has(participant.id)) throw new Error(`duplicate Rewind participant: ${participant.id}`)
      ids.add(participant.id)
    }
    this.participants = [...participants]
    this.participantsById = new Map(participants.map(participant => [participant.id, participant]))
  }

  async activate(sessionId: string, workspaceRoot: string): Promise<void> {
    this.assertOpen()
    const root = this.workspace.canonicalizeRoot(workspaceRoot)
    if (this.activatedRoots.has(root)) return
    const existing = this.activationTasks.get(root)
    if (existing !== undefined) return existing
    const task = (async () => {
      const entry = await this.repository.load(root)
      if (entry !== undefined) {
        const stored = entry.value
        const hydrated: Array<{ readonly participant: RewindParticipant; readonly effectIds: readonly string[] }> = []
        try {
          for (const participant of stored.participants) {
            const adapter = this.participantsById.get(participant.participantId)
            if (adapter === undefined) throw new Error(`durable Rewind participant is unavailable: ${participant.participantId}`)
            adapter.hydrate(participant.effects)
            hydrated.push({ participant: adapter, effectIds: participant.effects.map(effect => effect.effectId) })
          }
          this.journal.hydrate(stored.timeline)
        } catch (error: unknown) {
          for (const entry of hydrated) entry.participant.release(entry.effectIds)
          throw error
        }
      }
      this.revisions.set(root, entry?.revision ?? null)
      this.activatedRoots.add(root)
    })().catch((error: unknown) => {
      this.persistenceDisabled.add(root)
      this.activatedRoots.add(root)
      this.options.onPersistenceError?.(error)
      throw error
    }).finally(() => {
      this.activationTasks.delete(root)
    })
    this.activationTasks.set(root, task)
    return task
  }

  recordPoint(input: RewindPointInput): Promise<void> {
    this.assertOpen()
    return this.enqueue(input.sessionId, () => this.ingestPoint(input))
  }

  recordWorkspaceMutation(input: WorkspaceMutationInput): void {
    this.assertOpen()
    void this.enqueue(input.sessionId, () => this.ingestWorkspaceMutation(input))
      .catch(error => { this.options.onIngestionError?.(error) })
  }

  recordEffect(input: RewindEffectInput): void {
    this.assertOpen()
    if (!this.participantsById.has(input.participantId)) {
      throw new Error(`unknown Rewind participant: ${input.participantId}`)
    }
    void this.enqueue(input.sourceSessionId, () => this.ingestEffect(input))
      .catch(error => { this.options.onIngestionError?.(error) })
  }

  async settle(sessionId: string): Promise<void> {
    this.assertOpen()
    await this.ingestion(sessionId)
    await Promise.all(this.participants.map(participant => participant.settle(sessionId)))
    await this.ingestion(sessionId)
    await this.writeTail
  }

  private async ingestPoint(input: RewindPointInput): Promise<void> {
    const root = this.workspace.canonicalizeRoot(input.workspaceRoot)
    try {
      await this.activate(input.sessionId, root)
    } catch {
      // Rewind durability is auxiliary and must not block prompt admission.
    }
    const result = this.journal.recordPoint({ ...input, workspaceRoot: root })
    this.release(result.released)
    if (!result.changed) return
    this.invalidatePrepared(input.sessionId)
    if (result.durable) void this.persist(result.workspaceRoot)
  }

  private async ingestWorkspaceMutation(input: WorkspaceMutationInput): Promise<void> {
    const history = this.points(input.sessionId)
    const point = history.find(candidate => candidate.turn === input.turn)
    if (point === undefined) return
    try {
      await this.activate(input.sessionId, point.workspaceRoot)
    } catch {
      // Keep process-local Rewind available when durable state cannot be loaded.
    }
    const canonical = this.workspace.canonicalizeMutation(input)
    const claimed = this.journal.claim(input.sessionId, history)
    this.release(claimed.released)
    const result = this.journal.recordWorkspaceMutation(input, canonical)
    this.release(result.released)
    if (claimed.changed || result.recorded) {
      this.prepared.clear()
      void this.persist(result.workspaceRoot ?? claimed.workspaceRoot)
    }
  }

  private async ingestEffect(input: RewindEffectInput): Promise<void> {
    const participant = this.participantsById.get(input.participantId)
    if (participant === undefined) throw new Error(`unknown Rewind participant: ${input.participantId}`)
    let history: readonly RewindPointInput[]
    try {
      history = this.points(input.sourceSessionId)
    } catch (error: unknown) {
      participant.release([input.effectId])
      throw error
    }
    const point = history.find(candidate => candidate.turn === input.sourceTurn)
    if (point === undefined) {
      participant.release([input.effectId])
      return
    }
    try {
      await this.activate(input.sourceSessionId, point.workspaceRoot)
    } catch {
      // Keep process-local Rewind available when durable state cannot be loaded.
    }
    const claimed = this.journal.claim(input.sourceSessionId, history)
    this.release(claimed.released)
    const result = this.journal.recordEffect(input)
    this.release(result.released)
    if (result.status === 'missing-point') {
      participant.release([input.effectId])
      return
    }
    if (claimed.changed || result.status === 'recorded') {
      this.prepared.clear()
      void this.persist(result.workspaceRoot ?? claimed.workspaceRoot)
    }
  }

  list(sessionId: string): RewindPointSummary[] {
    const points = this.points(sessionId)
    if (points.length === 0) throw new Error('no rewind point is available for this session')
    const effectsByPoint = new Map(this.journal.activePoints(sessionId).map(point => [point.id, point]))
    return points.map((point) => {
      const effects = effectsByPoint.get(point.pointId)
      return {
        pointId: point.pointId,
        sessionId: point.sessionId,
        turn: point.turn,
        prompt: point.input.text,
        imageCount: point.input.attachments.length,
        createdAt: point.createdAt,
        workspaceFiles: new Set(effects?.workspaceMutations.map(mutation => mutation.absolutePath) ?? []).size,
        unsupportedFiles: new Set((effects?.workspaceMutations ?? [])
          .filter(mutation => mutation.kind === 'unsupported')
          .map(mutation => mutation.absolutePath)).size,
        participants: this.participantSummaries(effects?.effects ?? []),
      }
    })
  }

  async plan(sessionId: string, pointId: string): Promise<RewindPlan> {
    this.invalidatePrepared(sessionId)
    const point = this.points(sessionId).find(candidate => candidate.pointId === pointId)
    if (point === undefined) throw new Error('the selected rewind point is no longer available')
    const selected = this.journal.selectEffects(sessionId, pointId)
    const code = this.codeSelection(point.workspaceRoot, selected)
    const workspace = await this.workspace.prepare(
      point.workspaceRoot,
      code.codeScope === 'backward' ? code.workspaceMutations : [],
    )
    const participantGroups = this.groupEffects(code.codeScope === 'backward' ? code.effects : [])
    const participants: PreparedRewindParticipant[] = []
    for (const participant of this.participants) {
      const ids = participantGroups.get(participant.id)
      if (ids !== undefined && ids.length > 0) participants.push(await participant.prepare(ids, 'backward'))
    }
    const files = Object.freeze(workspace.files.map(file => Object.freeze({ ...file })))
    const participantPlans = Object.freeze(participants.map(participant => immutableParticipant(participant.impact)))
    const plan: RewindPlan = Object.freeze({
      planId: globalThis.crypto.randomUUID(),
      pointId: point.pointId,
      sessionId,
      turn: point.turn,
      input: Object.freeze({
        text: point.input.text,
        attachments: Object.freeze(point.input.attachments.map(attachment => Object.freeze({ ...attachment }))),
      }),
      createdAt: point.createdAt,
      ...point.previousTurnEndSeq === undefined
        ? {}
        : { previousTurnEndSeq: point.previousTurnEndSeq },
      codeScope: code.codeScope,
      ...code.codeReason === undefined ? {} : { codeReason: code.codeReason },
      state: aggregateState([workspace.state, ...participantPlans.map(participant => participant.state)]),
      files,
      participants: participantPlans,
    })
    this.prepared.set(plan.planId, {
      plan,
      workspace,
      participants,
      ...code.lineageId === undefined ? {} : { lineageId: code.lineageId },
    })
    return plan
  }

  async restore(plan: RewindPlan): Promise<RewindCompensation> {
    const prepared = this.prepared.get(plan.planId)
    if (prepared === undefined || prepared.plan !== plan) throw new Error('the rewind plan is no longer available')
    if (plan.state === 'conflict' || plan.state === 'unsupported') {
      throw new Error(`the ${plan.state} rewind plan cannot be restored`)
    }
    const compensations: RewindCompensation[] = []
    try {
      compensations.push(await prepared.workspace.apply())
      for (const participant of prepared.participants) compensations.push(await participant.apply())
    } catch (error: unknown) {
      try {
        await compensate(compensations)
      } catch (compensationError: unknown) {
        throw new Error(`rewind failed (${String(error)}) and compensation also failed (${String(compensationError)})`)
      }
      throw error
    }
    return async () => compensate(compensations)
  }

  async commit(plan: RewindPlan, action: RewindAction, targetSessionId?: string): Promise<void> {
    const prepared = this.prepared.get(plan.planId)
    if (prepared === undefined || prepared.plan !== plan) throw new Error('the rewind plan is no longer available')
    if (action !== 'conversation-only' && plan.codeScope === 'forward-unavailable') {
      throw new Error('forward code restore is not available for this checkpoint')
    }
    if (action === 'code-only' && plan.codeScope === 'none') {
      throw new Error('this checkpoint has no retained code or participant effects')
    }
    if (action === 'code-only' && targetSessionId !== undefined) {
      throw new Error('code-only rewind must not replace the conversation session')
    }
    if (action !== 'code-only'
      && (targetSessionId === undefined || targetSessionId === plan.sessionId)) {
      throw new Error('conversation rewind must continue in a distinct session')
    }
    const workspaceRoot = prepared.lineageId === undefined
      ? undefined
      : this.journal.commit(
          plan.sessionId,
          plan.pointId,
          action,
          targetSessionId,
          prepared.lineageId,
        )
    this.prepared.clear()
    if (workspaceRoot !== undefined) await this.persist(workspaceRoot)
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.drainIngestion()
    await Promise.allSettled(this.activationTasks.values())
    const settlements = await Promise.allSettled(this.journal.ownerSessionIds().flatMap(sessionId => (
      this.participants.map(participant => participant.settle(sessionId))
    )))
    for (const settlement of settlements) {
      if (settlement.status === 'rejected') this.options.onPersistenceError?.(settlement.reason)
    }
    await this.drainIngestion()
    await this.writeTail
    try {
      await this.repository.close()
    } catch (error: unknown) {
      this.options.onPersistenceError?.(error)
    } finally {
      this.closed = true
    }
  }

  private points(sessionId: string): RewindPointInput[] {
    const unique = new Map<string, RewindPointInput>()
    for (const point of this.conversationHistory.list(sessionId)) {
      if (point.sessionId !== sessionId) {
        throw new Error('the active conversation history contains a foreign Rewind checkpoint')
      }
      unique.set(point.pointId, {
        ...point,
        workspaceRoot: this.workspace.canonicalizeRoot(point.workspaceRoot),
      })
    }
    return [...unique.values()]
      .sort((left, right) => left.promptSeq - right.promptSeq)
      .slice(-this.options.history)
  }

  private codeSelection(
    workspaceRoot: string,
    selection: RewindEffectSelection,
  ): RewindEffectSelection {
    if (selection.workspaceRoot !== undefined && selection.workspaceRoot !== workspaceRoot) {
      return {
        codeScope: 'none',
        codeReason: 'The retained code checkpoint belongs to another workspace.',
        workspaceMutations: [],
        effects: [],
      }
    }
    if (selection.codeScope !== 'none' || selection.codeReason !== undefined) return selection
    return {
      ...selection,
      codeReason: 'No source-attributed code or participant effects are retained for this checkpoint.',
    }
  }

  private participantSummaries(effects: readonly RewindEffectReference[]): RewindParticipantImpact[] {
    const groups = this.groupEffects(effects)
    return this.participants.flatMap((participant) => {
      const changes = groups.get(participant.id)?.length ?? 0
      return changes === 0 ? [] : [{ id: participant.id, label: participant.label, changes, state: 'safe' as const }]
    })
  }

  private groupEffects(effects: readonly RewindEffectReference[]): Map<string, string[]> {
    const groups = new Map<string, string[]>()
    for (const effect of effects) {
      const existing = groups.get(effect.participantId) ?? []
      existing.push(effect.effectId)
      groups.set(effect.participantId, existing)
    }
    return groups
  }

  private release(effects: readonly RewindEffectReference[]): void {
    for (const [participantId, ids] of this.groupEffects(effects)) {
      this.participantsById.get(participantId)?.release(ids)
    }
  }

  private invalidatePrepared(sessionId: string): void {
    for (const [planId, prepared] of this.prepared) {
      if (prepared.plan.sessionId === sessionId) this.prepared.delete(planId)
    }
  }

  private enqueue(sessionId: string, task: () => void | Promise<void>): Promise<void> {
    const previous = this.ingestionTails.get(sessionId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(task)
    this.ingestionTails.set(sessionId, current)
    void current.then(
      () => { if (this.ingestionTails.get(sessionId) === current) this.ingestionTails.delete(sessionId) },
      () => { if (this.ingestionTails.get(sessionId) === current) this.ingestionTails.delete(sessionId) },
    )
    return current
  }

  private ingestion(sessionId: string): Promise<void> {
    return this.ingestionTails.get(sessionId) ?? Promise.resolve()
  }

  private async drainIngestion(): Promise<void> {
    const results = await Promise.allSettled(this.ingestionTails.values())
    for (const result of results) {
      if (result.status === 'rejected') this.options.onIngestionError?.(result.reason)
    }
  }

  private persist(workspaceRoot: string): Promise<void> {
    if (this.persistenceDisabled.has(workspaceRoot)) return Promise.resolve()
    const timeline = this.journal.snapshot(workspaceRoot)
    if (timeline === undefined) return Promise.resolve()
    let stored: StoredRewindTimeline
    try {
      const groups = this.groupEffects(this.journal.allEffects(workspaceRoot))
      const participants = [...groups].map(([participantId, ids]) => {
        const participant = this.participantsById.get(participantId)
        if (participant === undefined) throw new Error(`unknown Rewind participant: ${participantId}`)
        const effects = participant.snapshot(ids)
        const available = new Set(effects.map(effect => effect.effectId))
        const missing = ids.find(id => !available.has(id))
        if (missing !== undefined) throw new Error(`Rewind participant "${participantId}" lost effect "${missing}"`)
        return { participantId, effects }
      })
      stored = { timeline, participants }
    } catch (error: unknown) {
      return this.queuePersistenceDisable(workspaceRoot, error)
    }
    const write = this.writeTail
      .catch(() => {})
      .then(async () => {
        if (this.persistenceDisabled.has(workspaceRoot)) return
        try {
          const revision = await this.repository.save(stored, this.revisions.get(workspaceRoot) ?? null)
          this.revisions.set(workspaceRoot, revision)
        } catch (error: unknown) {
          if (error instanceof RewindRepositoryConflictError) {
            this.persistenceDisabled.add(workspaceRoot)
            this.options.onPersistenceError?.(error)
          } else {
            await this.invalidatePersistedTimeline(workspaceRoot, error)
          }
        }
      })
    this.writeTail = write
    return write
  }

  private queuePersistenceDisable(workspaceRoot: string, error: unknown): Promise<void> {
    this.persistenceDisabled.add(workspaceRoot)
    this.options.onPersistenceError?.(error)
    const removal = this.writeTail
      .catch(() => {})
      .then(() => this.removePersistedTimeline(workspaceRoot))
    this.writeTail = removal
    return removal
  }

  private async invalidatePersistedTimeline(workspaceRoot: string, error: unknown): Promise<void> {
    this.persistenceDisabled.add(workspaceRoot)
    this.options.onPersistenceError?.(error)
    await this.removePersistedTimeline(workspaceRoot)
  }

  private async removePersistedTimeline(workspaceRoot: string): Promise<void> {
    try {
      const revision = this.revisions.get(workspaceRoot) ?? null
      if (await this.repository.remove(workspaceRoot, revision)) this.revisions.set(workspaceRoot, null)
    } catch (error: unknown) {
      this.options.onPersistenceError?.(new Error(`could not invalidate stale durable Rewind history: ${String(error)}`))
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Rewind service is closed')
  }
}

import type {
  PreparedRewindParticipant,
  PreparedWorkspaceRewind,
  RewindCompensation,
  RewindEffectInput,
  RewindEffectReference,
  RewindEffectSink,
  RewindLifecycleSink,
  RewindParticipant,
  RewindParticipantImpact,
  RewindPlan,
  RewindPlanState,
  RewindPointInput,
  RewindPointSummary,
  RewindPort,
  WorkspaceMutationInput,
  WorkspaceRewindBackend,
} from '../contracts.ts'
import { RewindJournal } from '../domain/journal.ts'
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
  readonly onPersistenceError?: (error: unknown) => void
}

interface PreparedPlan {
  readonly plan: RewindPlan
  readonly workspace: PreparedWorkspaceRewind
  readonly participants: readonly PreparedRewindParticipant[]
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
export class RewindService implements RewindPort, RewindLifecycleSink, RewindEffectSink {
  private readonly journal: RewindJournal
  private readonly participants: readonly RewindParticipant[]
  private readonly participantsById: ReadonlyMap<string, RewindParticipant>
  private readonly prepared = new Map<string, PreparedPlan>()
  private readonly activatedRoots = new Set<string>()
  private readonly activationTasks = new Map<string, Promise<void>>()
  private readonly persistenceDisabled = new Set<string>()
  private readonly revisions = new Map<string, string | null>()
  private writeTail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly options: RewindServiceOptions,
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

  async beginTurn(input: RewindPointInput): Promise<void> {
    this.assertOpen()
    const root = this.workspace.canonicalizeRoot(input.workspaceRoot)
    try {
      await this.activate(input.sessionId, root)
    } catch {
      // Rewind durability is auxiliary and must not block the Agent turn.
    }
    const result = this.journal.beginTurn({
      ...input,
      workspaceRoot: root,
    })
    this.release(result.released)
    if (result.changed) {
      this.invalidatePrepared(input.sessionId)
      if (result.durable) await this.persist(result.workspaceRoot)
    }
  }

  recordWorkspaceMutation(input: WorkspaceMutationInput): void {
    this.assertOpen()
    const pointRoot = this.journal.workspaceRoot(input.sessionId, input.turn)
    if (pointRoot === undefined) return
    const canonical = this.workspace.canonicalizeMutation(pointRoot, input)
    const result = this.journal.recordWorkspaceMutation(input, canonical)
    this.release(result.released)
    if (result.recorded) {
      this.invalidatePrepared(input.sessionId)
      if (result.workspaceRoot !== undefined) void this.persist(result.workspaceRoot)
    }
  }

  recordEffect(input: RewindEffectInput): void {
    this.assertOpen()
    const participant = this.participantsById.get(input.participantId)
    if (participant === undefined) throw new Error(`unknown Rewind participant: ${input.participantId}`)
    const result = this.journal.recordEffect(input)
    this.release(result.released)
    if (result.status === 'missing-point') {
      participant.release([input.effectId])
      return
    }
    if (result.status === 'duplicate') return
    this.invalidatePrepared(input.sourceSessionId)
    if (result.workspaceRoot !== undefined) void this.persist(result.workspaceRoot)
  }

  async settle(sessionId: string): Promise<void> {
    this.assertOpen()
    await Promise.all(this.participants.map(participant => participant.settle(sessionId)))
    await this.writeTail
  }

  list(sessionId: string): RewindPointSummary[] {
    return this.journal.list(sessionId).map(point => ({
      pointId: point.id,
      sessionId: point.sessionId,
      turn: point.turn,
      prompt: point.prompt,
      createdAt: point.createdAt,
      workspaceFiles: new Set(point.workspaceMutations.map(mutation => mutation.path)).size,
      unsupportedFiles: new Set(point.workspaceMutations
        .filter(mutation => mutation.kind === 'unsupported')
        .map(mutation => mutation.path)).size,
      participants: this.participantSummaries(point.effects),
    }))
  }

  async plan(sessionId: string, pointId: string): Promise<RewindPlan> {
    this.invalidatePrepared(sessionId)
    const selected = this.journal.select(sessionId, pointId)
    const workspace = await this.workspace.prepare(selected.point.workspaceRoot, selected.workspaceMutations)
    const participantGroups = this.groupEffects(selected.effects)
    const participants: PreparedRewindParticipant[] = []
    for (const participant of this.participants) {
      const ids = participantGroups.get(participant.id)
      if (ids !== undefined && ids.length > 0) participants.push(await participant.prepare(ids, 'backward'))
    }
    const files = Object.freeze(workspace.files.map(file => Object.freeze({ ...file })))
    const participantPlans = Object.freeze(participants.map(participant => immutableParticipant(participant.impact)))
    const plan: RewindPlan = Object.freeze({
      planId: globalThis.crypto.randomUUID(),
      pointId: selected.point.id,
      sessionId,
      turn: selected.point.turn,
      prompt: selected.point.prompt,
      createdAt: selected.point.createdAt,
      ...selected.point.previousTurnEndSeq === undefined
        ? {}
        : { previousTurnEndSeq: selected.point.previousTurnEndSeq },
      state: aggregateState([workspace.state, ...participantPlans.map(participant => participant.state)]),
      files,
      participants: participantPlans,
    })
    this.prepared.set(plan.planId, { plan, workspace, participants })
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

  async continueFrom(plan: RewindPlan, targetSessionId: string): Promise<void> {
    const workspaceRoot = this.journal.continueFrom(plan.sessionId, plan.pointId, targetSessionId)
    this.prepared.clear()
    await this.persist(workspaceRoot)
  }

  async close(): Promise<void> {
    if (this.closed) return
    await Promise.allSettled(this.activationTasks.values())
    const settlements = await Promise.allSettled(this.journal.ownerSessionIds().flatMap(sessionId => (
      this.participants.map(participant => participant.settle(sessionId))
    )))
    for (const settlement of settlements) {
      if (settlement.status === 'rejected') this.options.onPersistenceError?.(settlement.reason)
    }
    await this.writeTail
    try {
      await this.repository.close()
    } catch (error: unknown) {
      this.options.onPersistenceError?.(error)
    } finally {
      this.closed = true
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

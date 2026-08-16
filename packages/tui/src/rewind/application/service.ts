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

const DEFAULT_MAX_MUTATION_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_SESSION_BYTES = 64 * 1024 * 1024

export interface RewindServiceOptions {
  readonly history: number
  readonly maxMutationBytes?: number
  readonly maxSessionBytes?: number
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

  constructor(
    options: RewindServiceOptions,
    private readonly workspace: WorkspaceRewindBackend,
    participants: readonly RewindParticipant[] = [],
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

  beginTurn(input: RewindPointInput): void {
    const released = this.journal.beginTurn({
      ...input,
      workspaceRoot: this.workspace.canonicalizeRoot(input.workspaceRoot),
    })
    this.release(released)
    this.invalidatePrepared(input.sessionId)
  }

  recordWorkspaceMutation(input: WorkspaceMutationInput): void {
    const pointRoot = this.journal.workspaceRoot(input.sessionId, input.turn)
    if (pointRoot === undefined) return
    const canonical = this.workspace.canonicalizeMutation(pointRoot, input)
    if (this.journal.recordWorkspaceMutation(input, canonical)) this.invalidatePrepared(input.sessionId)
  }

  recordEffect(input: RewindEffectInput): void {
    const participant = this.participantsById.get(input.participantId)
    if (participant === undefined) throw new Error(`unknown Rewind participant: ${input.participantId}`)
    const result = this.journal.recordEffect(input)
    if (result === 'missing-point') {
      participant.release([input.effectId])
      return
    }
    if (result === 'duplicate') return
    this.invalidatePrepared(input.sourceSessionId)
  }

  async settle(sessionId: string): Promise<void> {
    await Promise.all(this.participants.map(participant => participant.settle(sessionId)))
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
      if (ids !== undefined && ids.length > 0) participants.push(await participant.prepare(ids))
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

  continueFrom(plan: RewindPlan, targetSessionId: string): void {
    const released = this.journal.continueFrom(plan.sessionId, plan.pointId, targetSessionId)
    this.release(released)
    this.prepared.clear()
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
}

import type { MemoryMutation, ProjectMemoryService } from '@vascent/deepseek-harness-memory'
import type {
  PreparedRewindParticipant,
  RewindEffectInput,
  RewindParticipant,
} from '../contracts.ts'

export const MEMORY_REWIND_PARTICIPANT = 'memory'

type MemoryRewindService = Pick<ProjectMemoryService, 'restore' | 'settle'>

async function reapply(
  service: MemoryRewindService,
  mutations: readonly MemoryMutation[],
): Promise<void> {
  const failures: unknown[] = []
  for (const mutation of [...mutations].reverse()) {
    try {
      await service.restore(mutation, 'after')
    } catch (error: unknown) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new Error(`memory compensation failed: ${failures.map(String).join('; ')}`)
}

/** Memory-specific payload adapter behind the generic Rewind participant contract. */
export class MemoryRewindParticipant implements RewindParticipant {
  readonly id = MEMORY_REWIND_PARTICIPANT
  readonly label = 'Memory'
  private readonly mutations = new Map<string, MemoryMutation>()

  constructor(private readonly service: MemoryRewindService) {}

  capture(mutation: MemoryMutation): RewindEffectInput | undefined {
    if (mutation.sourceSessionId === undefined || mutation.sourceTurn === undefined) return undefined
    this.mutations.set(mutation.id, mutation)
    return {
      participantId: this.id,
      effectId: mutation.id,
      sourceSessionId: mutation.sourceSessionId,
      sourceTurn: mutation.sourceTurn,
    }
  }

  settle(sessionId: string): Promise<void> {
    return this.service.settle(sessionId)
  }

  async prepare(effectIds: readonly string[]): Promise<PreparedRewindParticipant> {
    const mutations: MemoryMutation[] = []
    for (const id of effectIds) {
      const mutation = this.mutations.get(id)
      if (mutation === undefined) {
        return {
          impact: {
            id: this.id,
            label: this.label,
            changes: effectIds.length,
            state: 'conflict',
            reason: 'An attributed Memory update is no longer available.',
          },
          apply: async () => { throw new Error('the Memory rewind plan is incomplete') },
        }
      }
      mutations.push(mutation)
    }
    return {
      impact: { id: this.id, label: this.label, changes: mutations.length, state: 'safe' },
      apply: async () => {
        const reverted: MemoryMutation[] = []
        try {
          for (const mutation of [...mutations].reverse()) {
            await this.service.restore(mutation, 'before')
            reverted.push(mutation)
          }
        } catch (error: unknown) {
          try {
            await reapply(this.service, reverted)
          } catch (compensationError: unknown) {
            throw new Error(`memory rewind failed (${String(error)}) and compensation also failed (${String(compensationError)})`)
          }
          throw error
        }
        return async () => reapply(this.service, reverted)
      },
    }
  }

  release(effectIds: readonly string[]): void {
    for (const id of effectIds) this.mutations.delete(id)
  }
}

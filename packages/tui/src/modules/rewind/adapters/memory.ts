import type { MemoryFileMutation, MemoryMutation, ProjectMemoryService } from '@vascent/deepseek-harness-memory'
import type {
  PreparedRewindParticipant,
  RewindDirection,
  RewindEffectInput,
  RewindEffectPayload,
  RewindParticipant,
} from '../contracts.ts'

export const MEMORY_REWIND_PARTICIPANT = 'memory'

type MemoryRewindService = Pick<ProjectMemoryService, 'restore' | 'settle'>

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${label} must be a non-empty string`)
  return value
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null || typeof value === 'string') return value
  throw new Error(`${label} must be text or null`)
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`)
  return value
}

function memoryFile(value: unknown): MemoryFileMutation {
  const item = record(value, 'Memory file mutation')
  return {
    path: text(item.path, 'Memory mutation path'),
    before: nullableText(item.before, 'Memory mutation before-state'),
    after: nullableText(item.after, 'Memory mutation after-state'),
  }
}

function memoryMutation(value: unknown): MemoryMutation {
  const item = record(value, 'Memory mutation')
  if (item.scope !== 'global' && item.scope !== 'project') throw new Error('Memory mutation scope is invalid')
  if (item.operation !== 'write' && item.operation !== 'forget') throw new Error('Memory mutation operation is invalid')
  if (!Array.isArray(item.files)) throw new Error('Memory mutation files must be an array')
  return {
    id: text(item.id, 'Memory mutation id'),
    sourceSessionId: text(item.sourceSessionId, 'Memory mutation session'),
    sourceTurn: integer(item.sourceTurn, 'Memory mutation turn'),
    scope: item.scope,
    summary: text(item.summary, 'Memory mutation summary'),
    operation: item.operation,
    files: item.files.map(memoryFile),
    createdAt: integer(item.createdAt, 'Memory mutation timestamp'),
  }
}

function applicationOrder(mutations: readonly MemoryMutation[], direction: RewindDirection): MemoryMutation[] {
  return direction === 'backward' ? [...mutations].reverse() : [...mutations]
}

function opposite(direction: RewindDirection): 'before' | 'after' {
  return direction === 'backward' ? 'after' : 'before'
}

function target(direction: RewindDirection): 'before' | 'after' {
  return direction === 'backward' ? 'before' : 'after'
}

async function compensate(
  service: MemoryRewindService,
  applied: readonly MemoryMutation[],
  direction: RewindDirection,
): Promise<void> {
  const failures: unknown[] = []
  for (const mutation of [...applied].reverse()) {
    try {
      await service.restore(mutation, opposite(direction))
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

  async prepare(effectIds: readonly string[], direction: RewindDirection): Promise<PreparedRewindParticipant> {
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
        const applied: MemoryMutation[] = []
        try {
          for (const mutation of applicationOrder(mutations, direction)) {
            await this.service.restore(mutation, target(direction))
            applied.push(mutation)
          }
        } catch (error: unknown) {
          try {
            await compensate(this.service, applied, direction)
          } catch (compensationError: unknown) {
            throw new Error(`memory rewind failed (${String(error)}) and compensation also failed (${String(compensationError)})`)
          }
          throw error
        }
        return async () => compensate(this.service, applied, direction)
      },
    }
  }

  snapshot(effectIds: readonly string[]): readonly RewindEffectPayload[] {
    return effectIds.flatMap((effectId) => {
      const mutation = this.mutations.get(effectId)
      return mutation === undefined ? [] : [{ effectId, payload: mutation }]
    })
  }

  hydrate(payloads: readonly RewindEffectPayload[]): void {
    const mutations = payloads.map((stored) => {
      const mutation = memoryMutation(stored.payload)
      if (mutation.id !== stored.effectId) throw new Error('Memory mutation id does not match its Rewind effect')
      return { effectId: stored.effectId, mutation }
    })
    for (const { effectId, mutation } of mutations) {
      this.mutations.set(effectId, mutation)
    }
  }

  release(effectIds: readonly string[]): void {
    for (const id of effectIds) this.mutations.delete(id)
  }
}

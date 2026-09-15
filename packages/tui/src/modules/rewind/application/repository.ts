import type { RewindTimelineSnapshot } from '../domain/journal.ts'

/** Repository value independent from its on-disk schema and content layout. */
export interface StoredRewindTimeline {
  readonly timeline: RewindTimelineSnapshot
}

export interface RewindRepositoryEntry {
  readonly value: StoredRewindTimeline
  readonly revision: string
}

/** Raised when another process committed a newer workspace lineage. */
export class RewindRepositoryConflictError extends Error {
  constructor() {
    super('durable Rewind history changed in another process')
    this.name = 'RewindRepositoryConflictError'
  }
}

/** Durable boundary injected into RewindService. */
export interface RewindRepository {
  load(workspaceRoot: string): Promise<RewindRepositoryEntry | undefined>
  save(value: StoredRewindTimeline, expectedRevision: string | null): Promise<string>
  remove(workspaceRoot: string, expectedRevision: string | null): Promise<boolean>
  compact(): Promise<void>
  close(): Promise<void>
}

/** Explicit process-local fallback used by tests and embedders without storage. */
export class VolatileRewindRepository implements RewindRepository {
  async load(_workspaceRoot: string): Promise<undefined> {
    return undefined
  }

  async save(_value: StoredRewindTimeline, _expectedRevision: string | null): Promise<string> {
    return 'volatile'
  }

  async remove(_workspaceRoot: string, _expectedRevision: string | null): Promise<boolean> {
    return true
  }

  async compact(): Promise<void> {}

  async close(): Promise<void> {}
}

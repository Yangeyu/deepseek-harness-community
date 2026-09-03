import type { SkillEntry } from '../../runtime/session/contracts.ts'
import type { SkillCatalogSource, SkillSessionId } from './contracts.ts'

export type SkillCatalogStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error' | 'unavailable'

export interface SkillCatalogSnapshot {
  sessionId?: SkillSessionId
  entries: readonly SkillEntry[]
  status: SkillCatalogStatus
  error?: string
  fetchedAt?: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Session-bound, stale-while-refresh Skill catalog with stale-request rejection. */
export class SkillCatalog {
  private snapshot: SkillCatalogSnapshot = { entries: [], status: 'idle' }
  private requestVersion = 0
  private request: Promise<readonly SkillEntry[]> | undefined
  private requestAbort: AbortController | undefined

  constructor(
    private readonly source: SkillCatalogSource,
    private readonly onChange: (snapshot: Readonly<SkillCatalogSnapshot>) => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly staleAfterMs = 10_000,
  ) {}

  get current(): Readonly<SkillCatalogSnapshot> {
    return this.snapshot
  }

  /** Switch catalogs without carrying provider rows across sessions. */
  setSession(sessionId: SkillSessionId | undefined): void {
    if (sessionId === this.snapshot.sessionId) return
    this.requestVersion += 1
    this.requestAbort?.abort()
    this.requestAbort = undefined
    this.request = undefined
    this.publish({
      ...sessionId === undefined ? {} : { sessionId },
      entries: [],
      status: sessionId === undefined ? 'idle' : 'loading',
    })
    if (sessionId !== undefined) void this.refresh(true)
  }

  /** Refresh once per freshness window unless the caller explicitly forces it. */
  async refresh(force = false): Promise<readonly SkillEntry[]> {
    const sessionId = this.snapshot.sessionId
    if (sessionId === undefined) return []
    if (this.request !== undefined) return this.request
    const fetchedAt = this.snapshot.fetchedAt
    if (!force && fetchedAt !== undefined && this.now() - fetchedAt < this.staleAfterMs) {
      return this.snapshot.entries
    }

    const requestVersion = this.requestVersion
    const abort = new AbortController()
    this.requestAbort = abort
    const loading: SkillCatalogSnapshot = { ...this.snapshot, status: 'loading' }
    delete loading.error
    this.publish(loading)
    const request = this.source.list(sessionId, abort.signal).then((entries) => {
      if (requestVersion !== this.requestVersion || sessionId !== this.snapshot.sessionId || abort.signal.aborted) return []
      const ordered = [...entries].sort((left, right) => left.name.localeCompare(right.name))
      this.publish({ sessionId, entries: ordered, status: 'ready', fetchedAt: this.now() })
      return ordered
    }).catch((error: unknown) => {
      if (requestVersion !== this.requestVersion || sessionId !== this.snapshot.sessionId || abort.signal.aborted) return []
      const unavailable = /not found|unsupported|unavailable/i.test(errorMessage(error))
      this.publish({
        ...this.snapshot,
        status: unavailable ? 'unavailable' : this.snapshot.entries.length > 0 ? 'stale' : 'error',
        error: errorMessage(error),
      })
      return this.snapshot.entries
    }).finally(() => {
      if (this.request === request) this.request = undefined
      if (this.requestAbort === abort) this.requestAbort = undefined
    })
    this.request = request
    return request
  }

  dispose(): void {
    this.requestVersion += 1
    this.requestAbort?.abort()
    this.requestAbort = undefined
    this.request = undefined
  }

  private publish(snapshot: SkillCatalogSnapshot): void {
    this.snapshot = snapshot
    this.onChange(this.snapshot)
  }
}

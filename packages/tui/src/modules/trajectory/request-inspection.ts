import type { ModelRequestAvailability, ModelRequestDocument } from '../../runtime/execution/projection/model-call.ts'
import { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import { RequestDocument, type RequestField } from './request-document.ts'
import { searchRequest, type RequestSearchIndex, type SearchMatch } from './request-search.ts'

export type RequestPreparation =
  | { readonly phase: 'empty' }
  | { readonly phase: 'preparing' }
  | { readonly phase: 'ready'; readonly document: RequestDocument; readonly canonical: ModelRequestDocument }
  | { readonly phase: 'unavailable'; readonly availability: Exclude<ModelRequestAvailability, { status: 'available' }> }
  | { readonly phase: 'error'; readonly message: string }

export interface RequestSearchState {
  readonly phase: 'idle' | 'searching' | 'ready' | 'error'
  readonly query: string
  readonly totalMatches: number
  readonly scannedFields: number
  readonly selected: { readonly ordinal: number; readonly match: SearchMatch<RequestField> } | undefined
  readonly error?: string
}

const idleSearch = (query = ''): RequestSearchState => ({
  phase: 'idle', query, totalMatches: 0, scannedFields: 0, selected: undefined,
})
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** One current Request and its cancellable preparation/query/selection jobs, owned by the Surface lifetime. */
export class RequestInspection {
  private readonly scope: LifecycleScope
  private requestScope: LifecycleScope | undefined
  private searchScope: LifecycleScope | undefined
  private selectionScope: LifecycleScope | undefined
  private targetOrdinal: number | undefined
  private availability: ModelRequestAvailability | undefined
  private index: RequestSearchIndex<RequestField> | undefined
  private preparation: RequestPreparation = { phase: 'empty' }
  private preparationTask: Promise<void> = Promise.resolve()
  private searchState: RequestSearchState = idleSearch()

  constructor(parent: LifecycleScope, private readonly onChange: () => void) {
    this.scope = parent.fork('request-inspection')
    this.scope.onDispose(() => {
      this.preparation = { phase: 'empty' }
      this.searchState = idleSearch()
      this.targetOrdinal = undefined
      this.availability = undefined
      this.index = undefined
    })
  }

  get current(): RequestPreparation { return this.preparation }
  get search(): RequestSearchState { return this.searchState }
  get navigationOrdinal(): number | undefined { return this.targetOrdinal ?? this.searchState.selected?.ordinal }

  /** Same canonical revision retains its document/query; replay, epoch, or Request changes retire all jobs. */
  open(availability: ModelRequestAvailability): Promise<void> {
    if (!this.scope.active) return Promise.resolve()
    const previous = this.availability
    if (availability.status === 'available' && previous?.status === 'available'
      && availability.version === previous.version
      && availability.identity.sessionId === previous.identity.sessionId
      && availability.identity.epoch === previous.identity.epoch
      && availability.identity.stepKey === previous.identity.stepKey
      && availability.identity.throughSeq === previous.identity.throughSeq) return this.preparationTask
    void this.requestScope?.dispose()
    this.cancelSearch()
    this.availability = availability
    this.requestScope = undefined
    if (availability.status !== 'available') {
      this.preparation = { phase: 'unavailable', availability }
      this.onChange()
      return Promise.resolve()
    }
    const scope = this.scope.fork('document')
    this.requestScope = scope
    this.preparation = { phase: 'preparing' }
    this.onChange()
    this.preparationTask = this.prepare(scope, availability)
    return this.preparationTask
  }

  private async prepare(scope: LifecycleScope, availability: Extract<ModelRequestAvailability, { status: 'available' }>): Promise<void> {
    try {
      // Publish preparing and yield before reading; this is not a terminal paint
      // fence, nor a claim that synchronous Surface replay is preemptible.
      await new Promise<void>(resolve => setImmediate(resolve))
      scope.signal.throwIfAborted()
      const canonical = availability.read()
      const document = new RequestDocument(canonical)
      scope.signal.throwIfAborted()
      this.preparation = { phase: 'ready', document, canonical }
      this.onChange()
    } catch (error: unknown) {
      if (!scope.active) return
      this.preparation = { phase: 'error', message: errorMessage(error) }
      this.onChange()
    }
  }

  async find(query: string, options: { caseSensitive?: boolean; fields?: Iterable<RequestField> } = {}): Promise<void> {
    this.cancelSearch()
    if (this.preparation.phase !== 'ready' || !this.requestScope?.active) return
    const document = this.preparation.document
    const scope = this.requestScope.fork('query')
    this.searchScope = scope
    this.searchState = { ...idleSearch(query), phase: 'searching' }
    this.onChange()
    let publishedAt = performance.now()
    try {
      const index = await searchRequest(options.fields ?? document.fields(), query, {
        ...(options.caseSensitive === undefined ? {} : { caseSensitive: options.caseSensitive }),
        signal: scope.signal,
        onProgress: progress => {
          if (!scope.active) return
          this.searchState = { ...this.searchState, ...progress }
          const now = performance.now()
          if (now - publishedAt >= 32) {
            publishedAt = now
            this.onChange()
          }
        },
      })
      scope.signal.throwIfAborted()
      this.index = index
      this.searchState = { ...this.searchState, phase: 'ready', totalMatches: index.totalMatches }
      this.onChange()
      if (index.totalMatches > 0) await this.selectMatch(0)
    } catch (error: unknown) {
      if (!scope.active) return
      this.searchState = { ...this.searchState, phase: 'error', error: errorMessage(error) }
      this.onChange()
    }
  }

  async selectMatch(ordinal: number): Promise<void> {
    const index = this.index
    if (index === undefined || !this.searchScope?.active || this.searchState.phase !== 'ready') return
    // Advance key intent before yielding; repeated n/N must not reuse a stale committed match.
    this.targetOrdinal = ordinal
    void this.selectionScope?.dispose()
    const scope = this.searchScope.fork('selection')
    this.selectionScope = scope
    try {
      const match = await index.match(ordinal, scope.signal)
      scope.signal.throwIfAborted()
      if (match === undefined) return
      this.searchState = { ...this.searchState, selected: { ordinal, match } }
      this.onChange()
    } catch (error: unknown) {
      if (!scope.active) return
      this.searchState = { ...this.searchState, phase: 'error', error: errorMessage(error) }
      this.onChange()
    } finally {
      await scope.dispose()
    }
  }

  suspend(): void {
    void this.selectionScope?.dispose()
    this.selectionScope = undefined
    this.targetOrdinal = undefined
    if (this.searchState.phase === 'searching') this.cancelSearch()
    if (this.preparation.phase === 'preparing') {
      void this.requestScope?.dispose()
      this.requestScope = undefined
      this.availability = undefined
      this.preparation = { phase: 'empty' }
      this.onChange()
    }
  }

  cancelSearch(): void {
    void this.searchScope?.dispose()
    this.searchScope = undefined
    this.selectionScope = undefined
    this.targetOrdinal = undefined
    this.index = undefined
    this.searchState = idleSearch(this.searchState.query)
  }

  dispose(): Promise<void> { return this.scope.dispose() }
}

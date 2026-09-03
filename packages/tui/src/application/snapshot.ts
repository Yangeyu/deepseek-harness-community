import type { MemoryActivity } from '@vascent/deepseek-harness-memory'
import type { ComposerSnapshot } from '../modules/composer/process.ts'
import type { ConfigurationSnapshot } from '../modules/configuration/model.ts'
import type { InteractionSnapshot } from '../modules/interaction/process.ts'
import type { RewindSnapshot } from '../modules/rewind/process.ts'
import type { SessionCenterSnapshot } from '../modules/session-center/process.ts'
import type { SkillCatalogSnapshot } from '../modules/skills/catalog.ts'
import type { TaskSnapshot } from '../modules/task/model.ts'
import type { TrajectorySnapshot } from '../modules/trajectory/process.ts'
import type { TranscriptSnapshot } from '../modules/transcript/host.ts'
import type {
  FocusSnapshot,
  SurfaceSnapshot,
} from '../presentation/shell/surfaces/surface-host.ts'
import { AtomicSnapshotStore, type SnapshotListener } from '../runtime/dispatch/snapshot-store.ts'
import type { ApplicationLifecycleSnapshot } from '../runtime/lifecycle/application-machine.ts'
import type { RuntimeSessionSnapshot } from '../runtime/session/snapshot.ts'

/** One renderer-facing value spanning runtime, installed modules, and shell presentation. */
export interface TerminalSnapshot {
  readonly sequence: number
  readonly runtime: {
    readonly application: Readonly<ApplicationLifecycleSnapshot>
    readonly session: Readonly<RuntimeSessionSnapshot>
  }
  readonly modules: {
    readonly composer: Readonly<ComposerSnapshot>
    readonly interaction: Readonly<InteractionSnapshot>
    readonly rewind: Readonly<RewindSnapshot>
    readonly transcript: Readonly<TranscriptSnapshot>
    readonly trajectory: Readonly<TrajectorySnapshot>
    readonly configuration: Readonly<ConfigurationSnapshot>
    readonly task: Readonly<TaskSnapshot>
    readonly skills: Readonly<SkillCatalogSnapshot>
    readonly sessionCenter: Readonly<SessionCenterSnapshot>
    readonly memory: Readonly<MemoryActivity>
  }
  readonly presentation: {
    readonly surfaces: Readonly<SurfaceSnapshot>
    readonly focus: Readonly<FocusSnapshot>
  }
}

export interface TerminalSnapshotSources {
  readonly application: () => Readonly<ApplicationLifecycleSnapshot>
  readonly session: () => Readonly<RuntimeSessionSnapshot>
  readonly composer: () => Readonly<ComposerSnapshot>
  readonly interaction: () => Readonly<InteractionSnapshot>
  readonly rewind: () => Readonly<RewindSnapshot>
  readonly transcript: () => Readonly<TranscriptSnapshot>
  readonly trajectory: () => Readonly<TrajectorySnapshot>
  readonly configuration: () => Readonly<ConfigurationSnapshot>
  readonly task: () => Readonly<TaskSnapshot>
  readonly skills: () => Readonly<SkillCatalogSnapshot>
  readonly sessionCenter: () => Readonly<SessionCenterSnapshot>
  readonly memory: () => Readonly<MemoryActivity>
  readonly surfaces: () => Readonly<SurfaceSnapshot>
  readonly focus: () => Readonly<FocusSnapshot>
}

function compose(sources: TerminalSnapshotSources, sequence: number): TerminalSnapshot {
  return Object.freeze({
    sequence,
    runtime: Object.freeze({
      application: sources.application(),
      session: sources.session(),
    }),
    modules: Object.freeze({
      composer: sources.composer(),
      interaction: sources.interaction(),
      rewind: sources.rewind(),
      transcript: sources.transcript(),
      trajectory: sources.trajectory(),
      configuration: sources.configuration(),
      task: sources.task(),
      skills: sources.skills(),
      sessionCenter: sources.sessionCenter(),
      memory: sources.memory(),
    }),
    presentation: Object.freeze({
      surfaces: sources.surfaces(),
      focus: sources.focus(),
    }),
  })
}

/**
 * Coalesces synchronous slice mutations and publishes only a complete composed
 * value. No listener can observe a half-swapped Session feature set.
 */
export class TerminalSnapshotCoordinator {
  private readonly store: AtomicSnapshotStore<TerminalSnapshot>
  private scheduled = false
  private disposed = false

  constructor(private readonly sources: TerminalSnapshotSources) {
    this.store = new AtomicSnapshotStore(compose(sources, 0))
  }

  get current(): Readonly<TerminalSnapshot> { return this.store.current }

  subscribe(listener: SnapshotListener<TerminalSnapshot>, emitCurrent = false): () => void {
    return this.store.subscribe(listener, emitCurrent)
  }

  invalidate(): void {
    if (this.disposed || this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      if (this.disposed || !this.scheduled) return
      this.flush()
    })
  }

  /** Synchronous transaction boundary used by lifecycle acceptance tests and startup. */
  flush(): boolean {
    if (this.disposed) return false
    this.scheduled = false
    return this.store.replace(compose(this.sources, this.store.current.sequence + 1))
  }

  dispose(): void {
    this.disposed = true
    this.scheduled = false
  }
}

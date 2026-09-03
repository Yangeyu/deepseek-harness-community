import type { Component } from '@earendil-works/pi-tui'
import { AtomicSnapshotStore, type SnapshotListener } from '../../runtime/dispatch/snapshot-store.ts'
import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import type { SessionId } from '../../runtime/session/snapshot.ts'
import { ComponentSlot } from '../../presentation/primitives/component-slot.ts'
import { TranscriptProcess } from './process.ts'

export interface TranscriptSnapshot {
  readonly sessionId: SessionId | undefined
  readonly epoch: number | undefined
  readonly revision: number
}

/** Stable shell facade over a fresh Transcript projection/view per Session epoch. */
export class TranscriptHost implements Component {
  private readonly component = new ComponentSlot()
  private readonly store = new AtomicSnapshotStore<TranscriptSnapshot>({
    sessionId: undefined,
    epoch: undefined,
    revision: 0,
  })
  private process: TranscriptProcess | undefined

  get current(): Readonly<TranscriptSnapshot> { return this.store.current }

  subscribe(listener: SnapshotListener<TranscriptSnapshot>): () => void {
    return this.store.subscribe(listener)
  }

  bind(
    process: TranscriptProcess | undefined,
    identity?: { readonly sessionId: SessionId; readonly epoch: number },
    owner?: LifecycleScope,
  ): void {
    this.process = process
    this.component.replace(process)
    this.publish(identity?.sessionId, identity?.epoch)
    if (process !== undefined) owner?.onDispose(() => {
      if (this.process === process) this.bind(undefined)
    })
  }

  touch(): void {
    const current = this.store.current
    this.store.replace({ ...current, revision: current.revision + 1 })
  }

  setDetails(expanded: boolean): void {
    this.process?.setDetails(expanded)
    this.touch()
  }

  advanceAnimation(): void {
    this.process?.advanceAnimation()
    this.touch()
  }

  handlePointer(line: number, action: 'move' | 'click' | 'wheel-up' | 'wheel-down'): boolean {
    const changed = this.process?.handlePointer(line, action) ?? false
    if (changed) this.touch()
    return changed
  }

  isTrailingBlock(line: number): boolean { return this.process?.isTrailingBlock(line) ?? false }
  invalidate(): void { this.component.invalidate() }
  render(width: number): string[] { return this.component.render(width) }

  private publish(sessionId: SessionId | undefined, epoch: number | undefined): void {
    this.store.update(current => ({ sessionId, epoch, revision: current.revision + 1 }))
  }
}

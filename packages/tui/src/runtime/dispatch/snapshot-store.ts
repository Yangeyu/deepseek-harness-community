export type SnapshotListener<Snapshot> = (snapshot: Readonly<Snapshot>) => void

/** Publishes complete immutable-by-convention values through one synchronous commit boundary. */
export class AtomicSnapshotStore<Snapshot> {
  private value: Snapshot
  private readonly listeners = new Set<SnapshotListener<Snapshot>>()

  constructor(initial: Snapshot) {
    this.value = initial
  }

  get current(): Readonly<Snapshot> {
    return this.value
  }

  replace(next: Snapshot): boolean {
    if (Object.is(next, this.value)) return false
    this.value = next
    for (const listener of this.listeners) listener(next)
    return true
  }

  update(update: (current: Readonly<Snapshot>) => Snapshot): boolean {
    return this.replace(update(this.value))
  }

  subscribe(listener: SnapshotListener<Snapshot>, emitCurrent = false): () => void {
    this.listeners.add(listener)
    if (emitCurrent) listener(this.value)
    return () => { this.listeners.delete(listener) }
  }
}

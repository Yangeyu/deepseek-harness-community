export type ResourceRelease<T> = (resource: T) => void

/** Exclusive owner for one synchronously replaceable resource. */
export class ResourceSlot<T> {
  private resource: T | undefined
  private closed = false

  constructor(private readonly release: ResourceRelease<T>) {}

  get current(): T | undefined {
    return this.resource
  }

  replace(next: T): T {
    if (this.closed) throw new Error('Cannot replace a resource in a disposed slot.')
    if (this.resource === next) return next
    this.clear()
    this.resource = next
    return next
  }

  clear(): void {
    const current = this.resource
    if (current === undefined) return
    this.resource = undefined
    this.release(current)
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.clear()
  }
}

import type { DisposableResource } from './lifecycle/scope.ts'

export type ScheduleRenderFrame = (render: () => void) => () => void

const scheduleMicrotask: ScheduleRenderFrame = (render) => {
  let cancelled = false
  queueMicrotask(() => {
    if (!cancelled) render()
  })
  return () => { cancelled = true }
}

/** Coalesces snapshot and presentation invalidations behind one render boundary. */
export class RenderScheduler implements DisposableResource {
  private cancelPending: (() => void) | undefined
  private disposed = false

  constructor(
    private readonly render: () => void,
    private readonly schedule: ScheduleRenderFrame = scheduleMicrotask,
  ) {}

  invalidate(): void {
    if (this.disposed || this.cancelPending !== undefined) return
    this.cancelPending = this.schedule(() => {
      this.cancelPending = undefined
      if (!this.disposed) this.render()
    })
  }

  /** Render immediately when a synchronous terminal transition requires it. */
  flush(): void {
    if (this.disposed) return
    this.cancelPending?.()
    this.cancelPending = undefined
    this.render()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelPending?.()
    this.cancelPending = undefined
  }
}

export interface ApplicationRuntime {
  start(): Promise<void>
  dispose(): Promise<void>
}

/** Public lifecycle facade over the statically constructed terminal runtime. */
export class TuiApplication {
  constructor(private readonly runtime: ApplicationRuntime) {}

  start(): Promise<void> {
    return this.runtime.start()
  }

  dispose(): Promise<void> {
    return this.runtime.dispose()
  }
}

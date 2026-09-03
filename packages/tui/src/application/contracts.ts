/** Launcher-owned process capabilities used by the interactive terminal. */
export interface TuiRuntime {
  exit(code: number): void
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  stderr: NodeJS.WriteStream
}

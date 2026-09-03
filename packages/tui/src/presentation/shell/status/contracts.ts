import type { RuntimeSessionSnapshot } from '../../../runtime/session/snapshot.ts'

export type GitBranchSource = (
  cwd: string,
  onChange: (branch: string | undefined) => void,
) => () => void

export interface ShellStatusSessionPort {
  readonly current: Readonly<RuntimeSessionSnapshot>
  subscribe(listener: (snapshot: Readonly<RuntimeSessionSnapshot>) => void): () => void
}

export interface ShellStatusComposerPort {
  readonly current: {
    readonly input: {
      readonly rewindArmed: boolean
      readonly draftRecovery: 'none' | 'stored' | 'restored'
    }
  }
  subscribe(listener: () => void): () => void
}

export interface ShellCommandActivity {
  readonly line: string
  readonly startedAt: number
}

export type ShellMemoryActivity =
  | { readonly state: 'idle' | 'updated' }
  | { readonly state: 'learning' }
  | { readonly state: 'error'; readonly message: string }

export interface ShellInterruptionStatus {
  readonly target: string | undefined
  readonly interruptingKey: string | undefined
}

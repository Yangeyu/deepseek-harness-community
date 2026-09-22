import type { SessionSummary, SkillEntry } from '../../runtime/session/contracts.ts'

type SessionId = SessionSummary['sessionId']

/** Toolkit-neutral command metadata used by help and autocomplete surfaces. */
export interface TerminalCommandDescriptor {
  name: string
  description: string
  argumentHint?: string
}

/** TUI-owned command with aliases and a local interaction handler. */
export interface TerminalCommandDefinition extends TerminalCommandDescriptor {
  aliases?: readonly string[]
  /** Opt into status-bar activity while the handler is pending; interaction surfaces omit this. */
  activityLabel?: string
  handler(argument: string): void | Promise<void>
}

export interface HostCommandResult {
  kind: 'success' | 'error'
  text?: string
  sourceEventSeq?: number
}

/** TUI behavior attached to an existing Host command without replacing it. */
export interface TerminalCommandDecoration {
  name: string
  onBare(): void | Promise<void>
  /** Runs only after the canonical Host command succeeds. */
  afterHostSuccess?(argument: string): void | Promise<void>
}

/** Host-backed command discovery and execution without leaking Cordis into the application. */
export interface HostCommandSource {
  list(sessionId: SessionId | undefined): readonly TerminalCommandDescriptor[]
  execute(sessionId: SessionId, line: string, signal: AbortSignal): Promise<HostCommandResult | undefined>
  subscribe(listener: () => void): () => void
}

export type SlashCandidate =
  | ({ kind: 'command' } & TerminalCommandDescriptor)
  | ({ kind: 'skill' } & SkillEntry)

export type SlashResolution =
  | { kind: 'none' }
  | { kind: 'command'; candidate: Extract<SlashCandidate, { kind: 'command' }> }
  | { kind: 'skill'; candidate: Extract<SlashCandidate, { kind: 'skill' }> }
  | { kind: 'unknown'; name: string }

import type { SkillEntry } from '../runtime/session/contracts.ts'
import type { LifecycleScope } from '../runtime/lifecycle/scope.ts'
import type { RuntimeSessionSnapshot } from '../runtime/session/snapshot.ts'
import type { TerminalCommandDirectory } from '../runtime/commands.ts'
import {
  mergeSlashCatalog,
  resolveLeadingSlash,
  slashAutocompleteRows,
  slashHelpText,
  type SlashCandidate,
} from './slash-catalog.ts'

export interface CommandRouterSessionPort {
  readonly current: Readonly<RuntimeSessionSnapshot>
  subscribe(listener: (snapshot: Readonly<RuntimeSessionSnapshot>) => void): () => void
}

export interface CommandRouterSkillsPort {
  readonly current: {
    readonly entries: readonly SkillEntry[]
    readonly status: 'idle' | 'loading' | 'ready' | 'stale' | 'error' | 'unavailable'
  }
  refresh(force?: boolean): Promise<readonly SkillEntry[]>
}

export interface CommandActivity {
  readonly label: string
  readonly startedAt: number
}

export interface CommandRouterOptions {
  readonly directory: TerminalCommandDirectory
  readonly session: CommandRouterSessionPort
  readonly skills: CommandRouterSkillsPort
  readonly refreshAutocomplete: () => void
  readonly onActivity: () => void
  readonly scope: LifecycleScope
  readonly now?: () => number
}

/** Owns Slash resolution, command activity, and Session-scoped discovery. */
export class CommandRouter {
  private readonly activities = new Set<CommandActivity>()
  private readonly now: () => number

  constructor(private readonly options: CommandRouterOptions) {
    this.now = options.now ?? Date.now
    options.scope.own(options.directory)
    options.scope.onDispose(() => { this.activities.clear() })
    options.scope.onDispose(options.directory.subscribe(() => {
      options.refreshAutocomplete()
    }))
    options.scope.onDispose(options.session.subscribe(snapshot => { this.bindSession(snapshot) }))
    this.bindSession(options.session.current)
  }

  get activity(): Readonly<CommandActivity> | undefined {
    // Show the latest pending command, returning to older work when the latest completes.
    return [...this.activities].at(-1)
  }

  get candidates(): readonly SlashCandidate[] {
    return mergeSlashCatalog(
      this.options.directory.descriptors,
      this.options.skills.current.entries,
      this.options.directory.resolutionNames,
    )
  }

  autocompleteRows() {
    return slashAutocompleteRows(this.candidates)
  }

  helpText(): string {
    return slashHelpText(this.candidates)
  }

  async dispatch(text: string): Promise<boolean> {
    this.bindSession(this.options.session.current)
    const name = text.replace(/^\//u, '').trim().split(/\s+/u)[0] ?? ''
    const label = this.options.directory.activityLabel(name)
    const activity = label === undefined ? undefined : { label, startedAt: this.now() }
    if (activity !== undefined) {
      this.activities.add(activity)
      this.options.onActivity()
    }
    try {
      const handled = await this.options.directory.dispatch(text)
      if (handled) return true
      let resolution = resolveLeadingSlash(text, this.candidates)
      if (resolution.kind === 'unknown' && this.options.session.current.sessionId !== undefined) {
        await this.options.skills.refresh(true)
        resolution = resolveLeadingSlash(text, this.candidates)
      }
      const catalogSettled = this.options.skills.current.status === 'ready'
        || this.options.skills.current.status === 'stale'
      if (resolution.kind === 'unknown' && catalogSettled) {
        throw new Error(`Unknown command or Skill "/${resolution.name}". Use /help or /skills to discover available entries.`)
      }
      return false
    } finally {
      if (activity !== undefined) {
        this.activities.delete(activity)
        if (this.options.scope.active) this.options.onActivity()
      }
    }
  }

  private bindSession(snapshot: Readonly<RuntimeSessionSnapshot>): void {
    if (this.options.directory.setSession(snapshot.sessionId)) {
      this.options.refreshAutocomplete()
    }
  }
}

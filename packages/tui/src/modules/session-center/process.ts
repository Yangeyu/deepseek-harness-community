import type { Component } from '@earendil-works/pi-tui'
import type { SessionSummary } from '@deepseek-ai/dsh-host-apiproxy'
import { ChoiceDialog } from '../../presentation/primitives/widgets/dialogs.ts'
import type { TuiTheme } from '../../presentation/primitives/theme.ts'
import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import type { RuntimeSessionSnapshot } from '../../runtime/session/snapshot.ts'
import { ScopedEffectRunner } from '../../runtime/dispatch/effect-runner.ts'
import { sessionChoices } from './model.ts'

export type SessionResumeTarget =
  | { readonly kind: 'last' }
  | { readonly kind: 'session'; readonly sessionId: string }

export interface SessionCenterSessionPort {
  readonly current: Readonly<RuntimeSessionSnapshot>
  sessions(): Promise<SessionSummary[]>
  resume(sessionId: string): Promise<void>
  notice(message: string): void
}

export interface SessionCenterSurfaceHandle {
  close(): boolean
}

export interface SessionCenterSurfacePort {
  readonly active: boolean
  open(descriptor: { readonly placement: 'readable'; readonly component: Component }): SessionCenterSurfaceHandle
}

export interface SessionCenterProcessOptions {
  readonly session: SessionCenterSessionPort
  readonly surfaces: SessionCenterSurfacePort
  readonly theme: TuiTheme
  readonly scope: LifecycleScope
  readonly invalidate?: () => void
}

export interface SessionCenterSnapshot {
  readonly phase: 'idle' | 'loading' | 'open'
  readonly choices: number
}

/** Owns root-session discovery, startup resolution, and resume selection. */
export class SessionCenterProcess {
  private snapshot: SessionCenterSnapshot = { phase: 'idle', choices: 0 }
  private readonly effects: ScopedEffectRunner
  private openTask: Promise<void> | undefined

  constructor(private readonly options: SessionCenterProcessOptions) {
    this.effects = new ScopedEffectRunner(options.scope, (error) => {
      options.session.notice(error instanceof Error ? error.message : String(error))
    })
  }

  get current(): Readonly<SessionCenterSnapshot> { return this.snapshot }

  async resolveStartup(target: SessionResumeTarget | undefined): Promise<string | undefined> {
    if (target === undefined) return undefined
    if (target.kind === 'session') return target.sessionId
    const latest = (await this.options.session.sessions())
      .find(session => !session.blank && session.origin !== 'subagent')
    if (latest === undefined) throw new Error('no non-blank root session is available to resume')
    return String(latest.sessionId)
  }

  async resume(sessionId: string): Promise<void> {
    await this.options.session.resume(sessionId)
  }

  open(): Promise<void> {
    if (this.options.surfaces.active) return Promise.resolve()
    if (this.openTask !== undefined) return this.openTask
    const task = this.openOnce()
    const tracked = task.finally(() => {
      if (this.openTask === tracked) this.openTask = undefined
    })
    this.openTask = tracked
    return tracked
  }

  private async openOnce(): Promise<void> {
    this.publish({ phase: 'loading', choices: 0 })
    let sessions: SessionSummary[]
    try {
      sessions = await this.options.session.sessions()
    } catch (error: unknown) {
      this.publish({ phase: 'idle', choices: 0 })
      throw error
    }
    if (!this.options.scope.active) return
    if (this.options.surfaces.active) {
      this.publish({ phase: 'idle', choices: 0 })
      return
    }
    const current = this.options.session.current.sessionId
    const items = sessionChoices(sessions, current === undefined ? undefined : String(current))
    if (items.length === 0) {
      this.publish({ phase: 'idle', choices: 0 })
      this.options.session.notice('No other sessions are available.')
      return
    }
    let surface!: SessionCenterSurfaceHandle
    const close = (): void => {
      if (surface.close()) this.publish({ phase: 'idle', choices: 0 })
    }
    const dialog = new ChoiceDialog(
      'Resume session',
      items,
      this.options.theme,
      item => {
        close()
        void this.run(() => this.options.session.resume(item.value))
      },
      close,
    )
    surface = this.options.surfaces.open({ placement: 'readable', component: dialog })
    this.publish({ phase: 'open', choices: items.length })
  }

  private publish(snapshot: SessionCenterSnapshot): void {
    this.snapshot = snapshot
    this.options.invalidate?.()
  }

  private async run(action: () => Promise<void>): Promise<void> {
    await this.effects.run(async () => { await action() })
  }
}

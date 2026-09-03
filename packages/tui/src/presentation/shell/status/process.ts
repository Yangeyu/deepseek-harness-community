import { Text } from '@earendil-works/pi-tui'
import { composerExecutionActivity, previousTurnDuration } from '../../../modules/composer/execution-activity.ts'
import { sessionControlSummary } from '../../../modules/configuration/model.ts'
import { goalTaskSummary } from '../../../modules/task/model.ts'
import { ResourceSlot } from '../../../runtime/lifecycle/resource-slot.ts'
import type { LifecycleScope } from '../../../runtime/lifecycle/scope.ts'
import type { RuntimeSessionSnapshot } from '../../../runtime/session/snapshot.ts'
import { formatDuration } from '../../primitives/duration.ts'
import { spinnerGlyph } from '../../primitives/spinner.ts'
import type { TuiTheme } from '../../primitives/theme.ts'
import { ComposerFooter } from './footer.ts'
import { composerStats } from './stats.ts'
import type {
  GitBranchSource,
  ShellCommandActivity,
  ShellInterruptionStatus,
  ShellMemoryActivity,
  ShellStatusComposerPort,
  ShellStatusSessionPort,
} from './contracts.ts'

export interface ShellStatusProcessOptions {
  readonly title: string
  readonly theme: TuiTheme
  readonly session: ShellStatusSessionPort
  readonly composer: ShellStatusComposerPort
  readonly commandActivity: () => Readonly<ShellCommandActivity> | undefined
  readonly memoryActivity: () => Readonly<ShellMemoryActivity>
  readonly interruption: (state: Readonly<RuntimeSessionSnapshot>) => ShellInterruptionStatus
  readonly followsTranscript: () => boolean
  readonly advanceTranscriptAnimation: () => void
  readonly gitBranch: GitBranchSource
  readonly invalidate: () => void
  readonly scope: LifecycleScope
  readonly now?: () => number
}

/** Owns shell header/footer projection, activity status, clocks, and Git observation. */
export class ShellStatusProcess {
  readonly header = new Text('', 0, 0)
  readonly status = new Text('', 0, 0)
  readonly footer: ComposerFooter

  private readonly spinnerTimer: ResourceSlot<ReturnType<typeof setInterval>>
  private readonly gitBranchWatcher: ResourceSlot<() => void>
  private readonly now: () => number
  private spinnerFrame = 0
  private workingStartedAt: number | undefined
  private workingActivityKey: string | undefined
  private gitBranchCwd: string | undefined
  private branch: string | undefined
  private started = false

  constructor(private readonly options: ShellStatusProcessOptions) {
    this.footer = new ComposerFooter(options.theme)
    this.now = options.now ?? Date.now
    this.spinnerTimer = options.scope.own(new ResourceSlot(timer => { clearInterval(timer) }))
    this.gitBranchWatcher = options.scope.own(new ResourceSlot(remove => { remove() }))
  }

  start(): void {
    if (this.started) throw new Error('ShellStatusProcess has already started.')
    this.started = true
    this.options.scope.onDispose(this.options.session.subscribe(state => { this.refresh(state) }))
    this.options.scope.onDispose(this.options.composer.subscribe(() => { this.refresh() }))
    this.refresh()
  }

  refresh(state: Readonly<RuntimeSessionSnapshot> = this.options.session.current): void {
    if (!this.options.scope.active) return
    this.header.setText([
      this.options.theme.bold(this.options.theme.accent(`✦ ${this.options.title}`)),
      this.options.theme.dim(`${state.cwd}${state.sessionId === undefined ? '' : ` · ${String(state.sessionId)}`}`),
    ].join('\n'))
    this.observeGitBranch(state.cwd)
    this.updateFooter(state)
    this.updateStatus(state)
    this.options.invalidate()
  }

  private observeGitBranch(cwd: string): void {
    if (this.gitBranchCwd === cwd) return
    this.gitBranchWatcher.clear()
    this.gitBranchCwd = cwd
    this.branch = undefined
    this.gitBranchWatcher.replace(this.options.gitBranch(cwd, (branch) => {
      if (!this.options.scope.active || this.gitBranchCwd !== cwd || this.branch === branch) return
      this.branch = branch
      this.updateFooter(this.options.session.current)
      this.options.invalidate()
    }))
  }

  private updateFooter(state: Readonly<RuntimeSessionSnapshot>): void {
    const selection = state.models?.current
    const model = selection === undefined
      ? 'model unavailable'
      : `${selection.provider}/${selection.model}${selection.reasoningEffort === undefined ? '' : ` · ${selection.reasoningEffort}`}`
    this.footer.setSnapshot({
      model,
      cwd: state.cwd,
      ...this.gitBranchCwd === state.cwd && this.branch !== undefined
        ? { branch: this.branch }
        : {},
      task: goalTaskSummary(state.projections),
      stats: composerStats(state.projections),
    })
  }

  private ensureSpinner(): void {
    if (this.spinnerTimer.current !== undefined) return
    this.spinnerTimer.replace(setInterval(() => {
      if (!this.options.scope.active) return
      this.spinnerFrame += 1
      this.updateStatus(this.options.session.current)
      this.options.advanceTranscriptAnimation()
      this.options.invalidate()
    }, 160))
  }

  private updateStatus(state: Readonly<RuntimeSessionSnapshot>): void {
    const history = this.options.followsTranscript() ? '' : ' · Viewing history · PageDown to follow'
    const policy = sessionControlSummary(state.projections)
    const policyStatus = policy === '' ? '' : ` · ${policy}`
    const memoryActivity = this.options.memoryActivity()
    const activity = composerExecutionActivity(state)
    const commandActivity = this.options.commandActivity()
    if (activity !== undefined || commandActivity !== undefined) {
      if (activity !== undefined && activity.key !== this.workingActivityKey) {
        const hostHandoff = this.workingActivityKey?.startsWith('submission:') === true
          && activity.key.startsWith('session:')
        this.workingActivityKey = activity.key
        this.workingStartedAt = activity.startedAt
          ?? (hostHandoff ? this.workingStartedAt : undefined)
          ?? this.now()
      }
      this.ensureSpinner()
      const glyph = spinnerGlyph(this.spinnerFrame)
      const startedAt = activity?.startedAt ?? commandActivity?.startedAt ?? this.workingStartedAt ?? this.now()
      const elapsed = formatDuration(this.now() - startedAt, 'elapsed')
      const label = activity?.kind === 'vision'
        ? `Vision · Analyzing ${String(activity.imageCount)} image${activity.imageCount === 1 ? '' : 's'}`
        : activity === undefined && commandActivity !== undefined
          ? `Running ${commandActivity.line}`
          : 'Working'
      const interruption = this.options.interruption(state)
      const interruptHint = interruption.target === undefined
        ? ''
        : interruption.interruptingKey === interruption.target
          ? 'Ctrl+C again to exit'
          : 'esc to interrupt'
      const hint = interruptHint === '' ? '' : ` · ${interruptHint}`
      this.status.setText([
        this.options.theme.accent(glyph),
        this.options.theme.secondary(` ${label} (${elapsed}${hint}${history})`),
      ].join(''))
      return
    }
    this.workingStartedAt = undefined
    this.workingActivityKey = undefined
    if (memoryActivity.state === 'learning') {
      this.ensureSpinner()
      const glyph = spinnerGlyph(this.spinnerFrame)
      this.status.setText(this.options.theme.accent(`${glyph} Learning project memory…${history}`))
      return
    }
    this.spinnerTimer.clear()
    const composerInput = this.options.composer.current.input
    if (composerInput.rewindArmed) {
      const recovery = composerInput.draftRecovery === 'stored' ? ' · ↑ to restore draft' : ''
      this.status.setText(this.options.theme.warning(`Press Esc again to open Rewind history${recovery}${history}`))
      return
    }
    if (memoryActivity.state === 'error') {
      this.status.setText(this.options.theme.warning(`Memory learning failed: ${memoryActivity.message}${history}`))
      return
    }
    if (composerInput.draftRecovery === 'stored') {
      this.status.setText(this.options.theme.secondary(`Input cleared · ↑ to restore${history}`))
      return
    }
    const previousTurn = previousTurnDuration(state)
    const lastTurn = previousTurn === undefined
      ? ''
      : ` · last ${formatDuration(previousTurn)}`
    const muxReady = state.connection.mux === 'online'
    const hostFailed = state.connection.host === 'reconnecting' || state.connection.host === 'offline'
    const ready = muxReady && !hostFailed
    const hostPending = state.connection.host === 'connecting' ? ' · host awaiting activity' : ''
    const connectionLabel = [
      state.connection.mux === 'online' ? undefined : `mux ${state.connection.mux}`,
      state.connection.host === 'online' ? undefined : `host ${state.connection.host}`,
    ].filter((value): value is string => value !== undefined).join(' · ')
    this.status.setText(ready
      ? `${this.options.theme.bold(this.options.theme.success('Ready'))}${this.options.theme.secondary(`${hostPending}${lastTurn}${policyStatus}${history}`)}`
      : this.options.theme.warning(`${connectionLabel === '' ? 'Connecting' : connectionLabel}…${history}`))
  }
}

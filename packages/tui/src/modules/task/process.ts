import type { Component, TUI } from '@earendil-works/pi-tui'
import type { TuiTheme } from '../../presentation/primitives/theme.ts'
import { TextInputDialog } from '../../presentation/primitives/widgets/dialogs.ts'
import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import type { RuntimeSessionSnapshot } from '../../runtime/session/snapshot.ts'
import { ScopedEffectRunner } from '../../runtime/dispatch/effect-runner.ts'
import type { GoalPort } from './contracts.ts'
import { taskSnapshot } from './model.ts'
import type { TaskSnapshot } from './model.ts'
import { TaskView, type GoalAction } from './view.ts'

export interface TaskSessionPort {
  readonly current: Readonly<RuntimeSessionSnapshot>
  subscribe(listener: (snapshot: Readonly<RuntimeSessionSnapshot>) => void): () => void
  cancel(): Promise<void>
  notice(message: string): void
}

export interface TaskSurfaceHandle {
  close(): boolean
}

export interface TaskSurfacePort {
  readonly active: boolean
  open(descriptor: { readonly placement: 'readable'; readonly component: Component }): TaskSurfaceHandle
}

export interface TaskProcessOptions {
  readonly session: TaskSessionPort
  readonly goals: GoalPort
  readonly surfaces: TaskSurfacePort
  readonly tui: TUI
  readonly theme: TuiTheme
  readonly visibleRows: () => number
  readonly invalidate: () => void
  readonly scope: LifecycleScope
}

/** Owns Task inspection, Goal mutations, and their complete surface workflow. */
export class TaskProcess {
  private readonly effects: ScopedEffectRunner
  private view: TaskView | undefined
  private surface: TaskSurfaceHandle | undefined

  constructor(private readonly options: TaskProcessOptions) {
    this.effects = new ScopedEffectRunner(options.scope, (error) => {
      options.session.notice(error instanceof Error ? error.message : String(error))
    })
    options.scope.onDispose(options.session.subscribe(snapshot => {
      this.view?.setSnapshot(taskSnapshot(snapshot.projections, snapshot.runState !== 'idle', snapshot.queue.length))
    }))
    options.scope.onDispose(() => { this.close() })
  }

  get activeView(): TaskView | undefined {
    return this.view
  }

  get current(): Readonly<TaskSnapshot> {
    const state = this.options.session.current
    return taskSnapshot(state.projections, state.runState !== 'idle', state.queue.length)
  }

  open(): void {
    if (this.options.surfaces.active) return
    const state = this.options.session.current
    const view = new TaskView(
      taskSnapshot(state.projections, state.runState !== 'idle', state.queue.length),
      this.options.theme,
      this.options.visibleRows,
      action => { this.handleGoalAction(action) },
      () => { void this.run(() => this.options.session.cancel()) },
      () => { this.close() },
    )
    this.view = view
    this.surface = this.options.surfaces.open({ placement: 'readable', component: view })
  }

  private close(): void {
    this.surface?.close()
    this.surface = undefined
    this.view = undefined
  }

  private handleGoalAction(action: GoalAction): void {
    const state = this.options.session.current
    const projection = taskSnapshot(state.projections, state.runState !== 'idle', state.queue.length).goal
    if (action === 'create') {
      this.openObjectiveInput('Create Goal', '', async (objective) => {
        this.openRoundInput(
          'Goal round limit (blank uses profile default)',
          '',
          rounds => this.options.goals.create(objective, rounds),
          true,
        )
      })
      return
    }
    if (projection === undefined || projection === null) {
      this.options.session.notice('The current Goal changed; reopen /task and try again.')
      return
    }
    if (action === 'edit') {
      this.openObjectiveInput(
        'Edit Goal',
        projection.goal.objective,
        objective => this.options.goals.edit(projection.goal, objective),
      )
      return
    }
    if (action === 'rounds') {
      this.openRoundInput(
        'Edit Goal round limit',
        String(projection.goal.maxGoalRounds),
        rounds => this.options.goals.edit(projection.goal, undefined, rounds),
        false,
      )
      return
    }
    const mutation = action === 'pause'
      ? () => this.options.goals.pause(projection.goal)
      : action === 'resume'
        ? () => this.options.goals.resume(projection.goal)
        : action === 'complete'
          ? () => this.options.goals.complete(projection.goal)
          : () => this.options.goals.clear(projection.goal)
    void this.run(async () => { await mutation() })
  }

  private openObjectiveInput(
    title: string,
    initial: string,
    submit: (objective: string) => Promise<unknown>,
  ): void {
    let surface!: TaskSurfaceHandle
    const close = (): void => { surface.close() }
    const dialog = new TextInputDialog(
      this.options.tui,
      title,
      this.options.theme,
      (objective) => {
        if (objective.trim() === '') return
        close()
        void this.run(async () => { await submit(objective.trim()) })
      },
      close,
      initial,
    )
    surface = this.options.surfaces.open({ placement: 'readable', component: dialog })
  }

  private openRoundInput(
    title: string,
    initial: string,
    submit: (rounds: number | undefined) => Promise<unknown>,
    optional: boolean,
  ): void {
    let surface!: TaskSurfaceHandle
    const close = (): void => { surface.close() }
    const dialog = new TextInputDialog(
      this.options.tui,
      title,
      this.options.theme,
      (value) => {
        const normalized = value.trim()
        const rounds = normalized === '' && optional ? undefined : Number(normalized)
        close()
        void this.run(async () => {
          if (rounds !== undefined && (!Number.isSafeInteger(rounds) || rounds <= 0)) {
            throw new Error('Goal round limit must be a positive integer')
          }
          await submit(rounds)
        })
      },
      close,
      initial,
    )
    surface = this.options.surfaces.open({ placement: 'readable', component: dialog })
  }

  private async run(action: () => Promise<void>): Promise<void> {
    await this.effects.run(async () => {
      await action()
      this.options.invalidate()
    })
  }
}

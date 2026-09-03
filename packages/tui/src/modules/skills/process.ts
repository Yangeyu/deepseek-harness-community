import type { Component, TUI } from '@earendil-works/pi-tui'
import type { SkillEntry } from '../../runtime/session/contracts.ts'
import type { RuntimeSessionSnapshot } from '../../runtime/session/snapshot.ts'
import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import { ScopedEffectRunner } from '../../runtime/dispatch/effect-runner.ts'
import type { TuiTheme } from '../../presentation/primitives/theme.ts'
import { TextInputDialog } from '../../presentation/primitives/widgets/dialogs.ts'
import { SkillAuthoringCoordinator } from './authoring.ts'
import { SkillCatalog, type SkillCatalogSnapshot } from './catalog.ts'
import type {
  LocalSkillEditorPort,
  SkillAuthoringPort,
  SkillCatalogSource,
} from './contracts.ts'
import { SkillAuthoringWizard } from './view/authoring-wizard.ts'
import { SkillsView } from './view/catalog-view.ts'

export interface SkillsSessionPort {
  readonly current: Readonly<RuntimeSessionSnapshot>
  notice(message: string): void
}

export interface SkillsSurfaceHandle {
  close(): boolean
}

export interface SkillsSurfacePort {
  readonly active: boolean
  open(descriptor: { readonly placement: 'readable'; readonly component: Component }): SkillsSurfaceHandle
}

export interface SkillsCommandPort {
  has(name: string): boolean
}

export interface SkillsComposerPort {
  setText(text: string): void
  refreshAutocomplete(): void
}

export interface SkillsProcessOptions {
  readonly session: SkillsSessionPort
  readonly source: SkillCatalogSource
  readonly authoring: SkillAuthoringPort
  readonly editor: LocalSkillEditorPort
  readonly commands: SkillsCommandPort
  readonly composer: SkillsComposerPort
  readonly surfaces: SkillsSurfacePort
  readonly tui: TUI
  readonly theme: TuiTheme
  readonly visibleRows: () => number
  readonly invalidate: () => void
  readonly scope: LifecycleScope
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/** Owns effective Skill discovery, authoring, editing, and their surfaces. */
export class SkillsProcess {
  private readonly catalog: SkillCatalog
  private readonly coordinator: SkillAuthoringCoordinator
  private view: SkillsView | undefined
  private surface: SkillsSurfaceHandle | undefined
  private readonly effects: ScopedEffectRunner

  constructor(private readonly options: SkillsProcessOptions) {
    this.effects = new ScopedEffectRunner(options.scope, (error) => {
      options.session.notice(error instanceof Error ? error.message : String(error))
    })
    this.catalog = new SkillCatalog(options.source, snapshot => this.handleCatalogChange(snapshot))
    this.coordinator = new SkillAuthoringCoordinator(
      options.authoring,
      this.catalog,
      options.editor,
      message => options.session.notice(message),
      milliseconds => abortableDelay(milliseconds, options.scope.signal),
    )
    options.scope.own(this.catalog)
    options.scope.onDispose(() => { this.close() })
    this.catalog.setSession(options.session.current.sessionId)
  }

  get current(): Readonly<SkillCatalogSnapshot> {
    return this.catalog.current
  }

  get activeView(): SkillsView | undefined {
    return this.view
  }

  refresh(force = false): Promise<readonly SkillEntry[]> {
    return this.catalog.refresh(force)
  }

  open(): void {
    if (this.options.surfaces.active) return
    const view = new SkillsView(
      this.catalog.current,
      this.options.theme,
      this.options.visibleRows,
      (name) => {
        this.close()
        this.options.composer.setText(`/${name} `)
      },
      query => this.openSearch(query),
      () => { this.beginCreation() },
      name => { void this.run(() => this.coordinator.edit(this.options.session.current.cwd, name)) },
      () => { void this.catalog.refresh(true) },
      () => { this.close() },
    )
    this.view = view
    this.surface = this.options.surfaces.open({ placement: 'readable', component: view })
    void this.catalog.refresh()
  }

  private close(): void {
    this.surface?.close()
    this.surface = undefined
    this.view = undefined
  }

  private handleCatalogChange(snapshot: Readonly<SkillCatalogSnapshot>): void {
    if (!this.options.scope.active) return
    this.view?.setSnapshot(snapshot)
    this.options.composer.refreshAutocomplete()
    this.options.invalidate()
  }

  private openSearch(initial: string): void {
    let surface!: SkillsSurfaceHandle
    const close = (): void => { surface.close() }
    const dialog = new TextInputDialog(
      this.options.tui,
      'Filter Skills',
      this.options.theme,
      (query) => {
        close()
        this.view?.setQuery(query)
        this.options.invalidate()
      },
      close,
      initial,
    )
    surface = this.options.surfaces.open({ placement: 'readable', component: dialog })
  }

  private beginCreation(): void {
    void this.run(async () => {
      const targets = await this.coordinator.targets(this.options.session.current.cwd)
      if (!this.options.scope.active) return
      new SkillAuthoringWizard(
        this.options.tui,
        { open: component => this.options.surfaces.open({ placement: 'readable', component }) },
        this.options.theme,
        targets,
        name => this.nameConflict(name),
        request => { void this.run(() => this.coordinator.create(request)) },
        message => this.options.session.notice(message),
      ).start()
    })
  }

  private nameConflict(name: string): string | undefined {
    if (this.options.commands.has(name)) {
      return `/${name} is already a Command or alias and would shadow the Skill. Choose another name.`
    }
    if (!this.catalog.current.entries.some(entry => entry.name === name)) return undefined
    return `/${name} is already an effective Skill. Use e in /skills to edit a local definition.`
  }

  private async run(action: () => Promise<void>): Promise<void> {
    await this.effects.run(async () => { await action() })
  }
}

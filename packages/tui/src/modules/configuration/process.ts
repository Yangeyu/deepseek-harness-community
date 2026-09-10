import type { Component, TUI } from '@earendil-works/pi-tui'
import type { ModelSelection } from '../../runtime/session/contracts.ts'
import type { VisionStatus } from '@vascent/deepseek-harness-vision'
import type { CommunityWebStatus } from '@vascent/deepseek-harness-web'
import { ModelDialog } from './view/model-dialog.ts'
import type { TuiTheme } from '../../presentation/primitives/theme.ts'
import { sanitizeTerminalText } from '../../presentation/primitives/text.ts'
import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import type { RuntimeSessionSnapshot } from '../../runtime/session/snapshot.ts'
import type { SessionEffectScope, SessionEffectScopeSource } from '../../runtime/session/effect-scope.ts'
import { ScopedEffectRunner } from '../../runtime/dispatch/effect-runner.ts'
import { configurationSnapshot, modelDirectorySnapshot } from './model.ts'
import type { ConfigurationSnapshot } from './model.ts'
import type {
  ConfigurationCommandPort,
  ModelDirectorySnapshot,
  ModelPort,
  VisionConfigurationPort,
  WebConfigurationPort,
} from './contracts.ts'
import { ConfigView, type ConfigEntryStage } from './view/config-view.ts'
import { VisionConfigView } from './view/vision-view.ts'
import { WebConfigView } from './view/web-view.ts'

export interface ConfigurationSessionPort extends SessionEffectScopeSource {
  readonly current: Readonly<RuntimeSessionSnapshot>
  subscribe(listener: (snapshot: Readonly<RuntimeSessionSnapshot>) => void): () => void
  notice(message: string): void
}

export interface ConfigurationSurfaceHandle {
  close(): boolean
}

export interface ConfigurationSurfacePort {
  readonly active: boolean
  open(descriptor: { readonly placement: 'readable'; readonly component: Component }): ConfigurationSurfaceHandle
}

export interface ConfigurationProcessOptions {
  readonly session: ConfigurationSessionPort
  readonly models: ModelPort
  readonly commands: ConfigurationCommandPort
  readonly surfaces: ConfigurationSurfacePort
  readonly tui: TUI
  readonly theme: TuiTheme
  readonly visibleRows: () => number
  readonly imageSubmissionBusy: () => boolean
  readonly setTranscriptDetails: (expanded: boolean) => void
  readonly invalidate: () => void
  readonly scope: LifecycleScope
  readonly vision?: VisionConfigurationPort
  readonly web?: WebConfigurationPort
}

/** Owns model, policy, Vision, Web, and TUI-detail configuration workflows. */
export class ConfigurationProcess {
  private readonly effects: ScopedEffectRunner
  private configView: ConfigView | undefined
  private visionView: VisionConfigView | undefined
  private webView: WebConfigView | undefined
  private visionStatus: VisionStatus | undefined
  private webStatus: CommunityWebStatus | undefined
  private detailsExpanded = false

  constructor(private readonly options: ConfigurationProcessOptions) {
    this.effects = new ScopedEffectRunner(options.scope, (error) => {
      options.session.notice(error instanceof Error ? error.message : String(error))
    })
    this.visionStatus = options.vision === undefined ? undefined : {
      config: options.vision.config,
      proxyRegistered: false,
      proxySupportsImages: false,
    }
    options.scope.onDispose(options.session.subscribe(snapshot => {
      this.configView?.setSnapshot(this.snapshot(snapshot))
    }))
  }

  get details(): boolean {
    return this.detailsExpanded
  }

  get current(): Readonly<ConfigurationSnapshot> {
    return this.snapshot()
  }

  get activeConfigView(): ConfigView | undefined {
    return this.configView
  }

  get activeVisionView(): VisionConfigView | undefined {
    return this.visionView
  }

  get activeWebView(): WebConfigView | undefined {
    return this.webView
  }

  openPermission(): void {
    if (this.snapshot().permissions === undefined) {
      this.options.session.notice('Permission configuration is unavailable in this profile.')
      return
    }
    this.open('permissions')
  }

  openRoute(argument: string): void | Promise<void> {
    const route = argument.trim().toLowerCase()
    if (route === '') return this.open()
    if (route === 'model') return this.openModelSelector()
    if (route === 'reasoning' || route === 'effort') return this.open('reasoning')
    if (route === 'permission' || route === 'permissions') return this.openPermission()
    if (route === 'plan') return this.open('plan')
    if (route === 'vision') return this.openVision()
    if (route === 'web') return this.openWeb()
    if (route === 'interface' || route === 'details') return this.open()
    throw new Error(`Unknown config section "${sanitizeTerminalText(argument.trim())}". Use model, reasoning, permission, plan, vision, web, or interface.`)
  }

  open(initialStage: ConfigEntryStage = 'root'): void {
    if (this.options.surfaces.active) return
    let surface!: ConfigurationSurfaceHandle
    const close = (): void => {
      if (!surface.close()) return
      this.configView = undefined
    }
    const state = this.options.session.current
    const view = new ConfigView(
      this.snapshot(state),
      this.options.theme,
      () => {
        close()
        void this.run(() => this.openModelSelector())
      },
      effort => { void this.run(() => this.selectReasoningEffort(effort)) },
      (value) => {
        if (initialStage === 'permissions') close()
        void this.run(async () => {
          if (!await this.options.commands.dispatch(`/permission ${value}`)) {
            throw new Error('Permission configuration is unavailable in this session.')
          }
        })
      },
      active => {
        void this.run(() => this.options.commands.dispatchHost(active ? '/plan' : '/plan off'))
      },
      expanded => { this.setDetails(expanded) },
      close,
      initialStage,
      () => {
        close()
        void this.run(() => this.openVision())
      },
      () => {
        close()
        void this.run(() => this.openWeb())
      },
    )
    this.configView = view
    surface = this.options.surfaces.open({ placement: 'readable', component: view })
    if ((initialStage === 'root' || initialStage === 'reasoning')
      && state.modelCatalog === undefined
      && state.sessionId !== undefined) {
      void this.run(async () => { await this.options.models.refresh() })
    }
    if (initialStage === 'root' && this.options.web !== undefined && this.webStatus === undefined) {
      void this.run(async () => { await this.refreshWebStatus() })
    }
  }

  async openModelSelector(): Promise<void> {
    if (this.options.surfaces.active) return
    const session = this.options.session.captureSession()
    const catalog = await this.options.models.refresh()
    const models = modelDirectorySnapshot(catalog, this.options.session.current.projections)
    if (this.options.surfaces.active || !this.options.scope.active || !session.active) return
    if (models === undefined) throw new Error('Model state is unavailable for the active session.')
    let surface!: ConfigurationSurfaceHandle
    const close = (): void => { surface.close() }
    const dialog = new ModelDialog(
      models,
      this.options.visibleRows,
      this.options.theme,
      selected => {
        close()
        void this.run(() => this.selectModel(selected, session))
      },
      close,
    )
    surface = this.options.surfaces.open({ placement: 'readable', component: dialog })
  }

  async selectNamedModel(name: string, reasoningEffort?: string): Promise<void> {
    const session = this.options.session.captureSession()
    const catalog = await this.options.models.refresh()
    const matches = catalog.groups.flatMap(group => group.models
      .filter(model => `${group.id}/${model.id}` === name || model.id === name)
      .map(model => ({ provider: group.id, model: model.id })))
    if (matches.length !== 1) throw new Error(matches.length === 0
      ? `model "${name}" was not found`
      : `model "${name}" is ambiguous; use provider/model`)
    await this.selectModel({
      ...matches[0] as ModelSelection,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    }, session)
  }

  async cycleReasoningEffort(): Promise<void> {
    const models = await this.currentModelDirectory()
    const current = models.current
    const model = models.groups.find(group => group.id === current.provider)
      ?.models.find(candidate => candidate.id === current.model)
    const efforts = model?.reasoning?.efforts
    if (efforts === undefined || efforts.length === 0) {
      this.options.session.notice('The current model does not expose selectable reasoning efforts.')
      return
    }
    const values: Array<string | undefined> = [undefined, ...efforts.map(effort => effort.id)]
    const index = values.indexOf(current.reasoningEffort)
    await this.selectReasoningEffort(values[(index + 1) % values.length])
  }

  private async openVision(): Promise<void> {
    if (this.options.surfaces.active) return
    const vision = this.options.vision
    if (vision === undefined) throw new Error('Vision is unavailable in this profile.')
    const status = await this.refreshVisionStatus()
    if (this.options.surfaces.active || !this.options.scope.active) return
    let surface!: ConfigurationSurfaceHandle
    const close = (): void => {
      if (!surface.close()) return
      this.visionView = undefined
    }
    const view = new VisionConfigView(
      status,
      this.options.theme,
      mode => {
        void this.run(async () => {
          await vision.setMode(mode)
          await this.refreshVisionStatus()
        })
      },
      close,
    )
    this.visionView = view
    surface = this.options.surfaces.open({ placement: 'readable', component: view })
  }

  private async openWeb(): Promise<void> {
    if (this.options.surfaces.active) return
    const web = this.options.web
    if (web === undefined) throw new Error('Web providers are unavailable in this profile.')
    const status = await this.refreshWebStatus()
    if (this.options.surfaces.active || !this.options.scope.active) return
    let surface!: ConfigurationSurfaceHandle
    const close = (): void => {
      if (!surface.close()) return
      this.webView = undefined
    }
    const view = new WebConfigView(
      status,
      this.options.theme,
      provider => {
        void this.run(async () => {
          await web.setSearchProvider(provider)
          await this.refreshWebStatus()
          this.options.session.notice(`Web search provider changed to ${provider}.`)
        })
      },
      () => { void this.run(async () => { await this.refreshWebStatus() }) },
      close,
    )
    this.webView = view
    surface = this.options.surfaces.open({ placement: 'readable', component: view })
  }

  private async refreshVisionStatus(): Promise<VisionStatus> {
    const vision = this.options.vision
    if (vision === undefined) throw new Error('Vision is unavailable in this profile.')
    const status = await vision.status(this.options.scope.signal)
    this.visionStatus = status
    this.visionView?.setStatus(status)
    this.refreshSurface()
    this.options.invalidate()
    return status
  }

  private async refreshWebStatus(): Promise<CommunityWebStatus> {
    const web = this.options.web
    if (web === undefined) throw new Error('Web providers are unavailable in this profile.')
    const status = await web.status(this.options.scope.signal)
    this.webStatus = status
    this.webView?.setStatus(status)
    this.refreshSurface()
    this.options.invalidate()
    return status
  }

  async selectReasoningEffort(reasoningEffort: string | undefined): Promise<void> {
    const session = this.options.session.captureSession()
    const models = await this.currentModelDirectory()
    const current = models.current
    await this.selectModel({
      provider: current.provider,
      model: current.model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    }, session)
  }

  private async selectModel(selection: ModelSelection, session: SessionEffectScope): Promise<void> {
    if (!this.options.scope.active || !session.active) throw new Error('Session changed; model selection cancelled.')
    if (this.options.imageSubmissionBusy()) {
      throw new Error('Wait for Vision analysis to finish before changing models.')
    }
    await this.options.models.select(selection)
  }

  setDetails(expanded: boolean): void {
    this.detailsExpanded = expanded
    this.options.setTranscriptDetails(expanded)
    this.refreshSurface()
    this.options.invalidate()
  }

  private snapshot(state: Readonly<RuntimeSessionSnapshot> = this.options.session.current) {
    return configurationSnapshot(
      state.modelCatalog,
      state.projections,
      this.detailsExpanded,
      this.visionStatus,
      this.options.web === undefined ? undefined : this.webStatus ?? null,
    )
  }

  private async currentModelDirectory(): Promise<ModelDirectorySnapshot> {
    const before = this.options.session.current
    const catalog = before.modelCatalog ?? await this.options.models.refresh()
    const state = this.options.session.current
    const models = modelDirectorySnapshot(catalog, state.projections)
    if (models === undefined) throw new Error('Model state is unavailable for the active session.')
    return models
  }

  private refreshSurface(): void {
    this.configView?.setSnapshot(this.snapshot())
  }

  private async run(action: () => Promise<void>): Promise<void> {
    await this.effects.run(async () => { await action() })
  }
}

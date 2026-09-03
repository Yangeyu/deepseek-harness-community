import type { TuiStartupOptions } from './cli.ts'
import type { TuiRuntime } from './contracts.ts'
import type { LifecycleScope } from '../runtime/lifecycle/scope.ts'

export interface StartupTerminalPort {
  setTitle(title: string): void
  drainInput(quietPeriodMs: number, maximumWaitMs: number): Promise<void>
}

export interface StartupScreenPort {
  start(): void
  stop(): void
}

export interface StartupSessionPort {
  start(sessionId?: string): Promise<void>
}

export interface StartupSessionCenterPort {
  resolveStartup(target: TuiStartupOptions['resume']): Promise<string | undefined>
}

export interface StartupConfigurationPort {
  selectNamedModel(model: string, reasoningEffort?: string): Promise<void>
  selectReasoningEffort(reasoningEffort: string): Promise<void>
}

export interface StartupCommandPort {
  dispatchHost(command: string): Promise<void>
}

export interface StartupComposerPort {
  readonly current: { readonly attachments: readonly unknown[] }
  readonly editor: {
    getExpandedText(): string
    setText(text: string): void
    addToHistory(text: string): void
  }
  loadImagePaths(paths: readonly string[]): Promise<void>
  submit(prompt: string): Promise<void>
}

export interface ApplicationStartupOptions {
  readonly title: string
  readonly intent: TuiStartupOptions
  readonly runtime: TuiRuntime
  readonly terminal: StartupTerminalPort
  readonly screen: StartupScreenPort
  readonly terminalScope: LifecycleScope
  readonly attachInput: () => () => void
  readonly session: StartupSessionPort
  readonly sessionCenter: StartupSessionCenterPort
  readonly configuration: StartupConfigurationPort
  readonly commands: StartupCommandPort
  readonly composer: StartupComposerPort
}

/** Applies exactly one parsed startup intent after terminal ownership is established. */
export class ApplicationStartup {
  constructor(private readonly options: ApplicationStartupOptions) {}

  async run(): Promise<void> {
    const { intent, runtime, terminal, screen, terminalScope } = this.options
    if (!runtime.stdin.isTTY || !runtime.stdout.isTTY) {
      throw new Error('deepseek-harness-tui requires an interactive TTY')
    }
    terminal.setTitle(this.options.title)
    terminalScope.onDispose(async () => {
      screen.stop()
      await terminal.drainInput(250, 30)
    })
    terminalScope.onDispose(this.options.attachInput())
    screen.start()

    await this.options.session.start(await this.options.sessionCenter.resolveStartup(intent.resume))
    if (intent.model !== undefined) {
      await this.options.configuration.selectNamedModel(intent.model, intent.reasoningEffort)
    } else if (intent.reasoningEffort !== undefined) {
      await this.options.configuration.selectReasoningEffort(intent.reasoningEffort)
    }
    if (intent.permissionMode !== undefined) {
      await this.options.commands.dispatchHost(`/permission ${intent.permissionMode}`)
    }
    if (intent.plan) await this.options.commands.dispatchHost('/plan')
    await this.options.composer.loadImagePaths(intent.imagePaths)
    if (intent.prompt === undefined) return

    const markers = this.options.composer.editor.getExpandedText().trim()
    const prompt = markers === '' ? intent.prompt : `${markers} ${intent.prompt}`
    const hasAttachments = this.options.composer.current.attachments.length > 0
    this.options.composer.editor.setText('')
    if (!hasAttachments) this.options.composer.editor.addToHistory(prompt)
    await this.options.composer.submit(prompt)
  }
}

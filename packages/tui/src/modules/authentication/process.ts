import type { Component, TUI } from '@earendil-works/pi-tui'
import type { AuthorizationPrompt } from '@deepseek-ai/dsh-authorization/types'
import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import type { TuiTheme } from '../../presentation/primitives/theme.ts'
import { ChoiceDialog, TextInputDialog } from '../../presentation/primitives/widgets/dialogs.ts'
import type { ProviderConnection, ProviderAuthenticationPort } from './contracts.ts'
import { AuthorizationView } from './view.ts'

interface AuthenticationOptions {
  port: ProviderAuthenticationPort
  surfaces: { readonly active: boolean; open(descriptor: { placement: 'readable'; component: Component }): { close(): boolean } }
  tui: TUI
  theme: TuiTheme
  scope: LifecycleScope
  invalidate(): void
  openUrl(url: string): Promise<void>
}

/** Presents Host authorization within the current Harness session and terminal. */
export class AuthenticationProcess {
  private pending: { controller: AbortController; done: Promise<boolean> } | undefined

  constructor(private readonly options: AuthenticationOptions) {
    options.scope.onDispose(async () => { this.pending?.controller.abort(); await this.pending?.done.catch(() => {}) })
  }

  async connect(provider?: string): Promise<boolean> {
    if (this.options.surfaces.active) return false
    return this.run(async signal => {
      const accounts = await this.options.port.list()
      signal.throwIfAborted()
      if (accounts.length === 0) throw new Error('No sign-in connections are available in this profile.')
      const account = provider === undefined
        ? await this.choose(accounts, signal)
        : accounts.find(account => account.provider === provider)
      if (account === undefined) {
        if (provider !== undefined) throw new Error(`No subscription sign-in for ${provider}`)
        return false
      }
      return this.authorize(account, signal)
    })
  }

  private async run(action: (signal: AbortSignal) => Promise<boolean>): Promise<boolean> {
    if (this.pending !== undefined) throw new Error('A provider sign-in is already in progress')
    this.options.scope.signal.throwIfAborted()
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.options.scope.signal])
    const done = Promise.resolve().then(() => action(signal))
    this.pending = { controller, done }
    try { return await done }
    finally { controller.abort(); this.pending = undefined }
  }

  private async choose(accounts: readonly ProviderConnection[], signal: AbortSignal): Promise<ProviderConnection | undefined> {
    signal.throwIfAborted()
    const { promise, resolve } = Promise.withResolvers<ProviderConnection | undefined>()
    const cancel = () => resolve(undefined)
    const dialog = new ChoiceDialog('Connect model provider', accounts.map(account => ({
      value: account.provider, label: account.label,
    })), this.options.theme, selected => resolve(accounts.find(account => account.provider === selected.value)), cancel)
    const surface = this.options.surfaces.open({ placement: 'readable', component: dialog })
    signal.addEventListener('abort', cancel, { once: true })
    try {
      return await promise
    } finally {
      signal.removeEventListener('abort', cancel)
      surface.close()
    }
  }

  private async authorize(account: ProviderConnection, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    const view = new AuthorizationView(account.label, this.options.theme, () => this.pending?.controller.abort())
    const surface = this.options.surfaces.open({ placement: 'readable', component: view })
    const opened = new Set<string>()
    try { return await this.options.port.authorize(account.provider, {
      notify: notice => {
        if (signal.aborted) return
        view.notify(notice)
        this.options.invalidate()
        const url = notice.url
        if (url !== undefined && !opened.has(url)) {
          opened.add(url)
          void Promise.resolve().then(() => { if (!signal.aborted) return this.options.openUrl(url) }).catch(() => {
            if (signal.aborted) return
            view.notify({ message: 'Open the displayed URL manually to continue.' })
            this.options.invalidate()
          })
        }
      },
      prompt: prompt => this.prompt(view, prompt, signal),
    }, signal) } finally { surface.close() }
  }

  private prompt(view: AuthorizationView, prompt: AuthorizationPrompt, attempt: AbortSignal): Promise<string> {
    const signal = prompt.signal === undefined ? attempt : AbortSignal.any([attempt, prompt.signal])
    signal.throwIfAborted()
    if (prompt.kind === 'secret') return Promise.reject(new Error('This subscription flow requires a secret-input surface that is not supported.'))
    return new Promise((resolve, reject) => {
      const finish = (value?: string) => {
        signal.removeEventListener('abort', cancel)
        view.prompt = undefined
        this.options.invalidate()
        if (value === undefined) reject(signal.reason ?? new Error('Authorization prompt withdrawn'))
        else resolve(value)
      }
      const cancel = () => finish()
      signal.addEventListener('abort', cancel, { once: true })
      view.prompt = prompt.kind === 'select'
        ? new ChoiceDialog(prompt.message, prompt.options.map(option => ({ value: option.id, label: option.label, ...option.description === undefined ? {} : { description: option.description } })), this.options.theme, item => finish(item.value), () => this.pending?.controller.abort())
        : new TextInputDialog(this.options.tui, prompt.message, this.options.theme, value => finish(value), () => this.pending?.controller.abort())
      view.focused = true
      this.options.invalidate()
    })
  }
}

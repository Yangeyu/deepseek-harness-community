import type { Component, SelectItem, TUI } from '@earendil-works/pi-tui'
import {
  ChoiceDialog,
  TextInputDialog,
} from '../../presentation/primitives/widgets/dialogs.ts'
import type { TuiTheme } from '../../presentation/primitives/theme.ts'
import { ApprovalDialog, MultiSelectDialog } from './dialogs.ts'
import type {
  ApprovalPrompt,
  InteractionResolution,
  QuestionPrompt,
} from '../../runtime/session/interactions.ts'
import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'

export interface InteractionPort {
  answerApproval(prompt: ApprovalPrompt, outcome: 'allowed-once' | 'rejected'): Promise<void>
  answerQuestions(
    prompt: QuestionPrompt,
    answers: Array<{ id: string; selected: string[]; custom?: string }>,
  ): Promise<void>
  cancel(): Promise<void>
  notice(message: string): void
}

export interface InteractionSurfaceHandle {
  close(): boolean
}

export interface InteractionSurfacePort {
  open(component: Component): InteractionSurfaceHandle
}

interface QueuedInteraction {
  key: string
  open(): void
}

interface ActiveInteraction extends QueuedInteraction {
  close: (() => void) | undefined
  phase: 'open' | 'responding' | 'cancelling'
}

export interface InteractionSnapshot {
  readonly activeKey: string | undefined
  readonly phase: ActiveInteraction['phase'] | 'idle'
  readonly queued: number
}

function approvalKey(prompt: ApprovalPrompt): string {
  return `approval:${String(prompt.sessionId)}:${prompt.requestId}`
}

function questionKey(prompt: QuestionPrompt): string {
  return `question:${String(prompt.sessionId)}:${prompt.requestId}`
}

function resolutionKey(resolution: InteractionResolution): string {
  return resolution.type === 'approval/resolved'
    ? `approval:${String(resolution.sessionId)}:${resolution.requestId}`
    : `question:${String(resolution.sessionId)}:${resolution.requestId}`
}

function questionTitle(question: QuestionPrompt['questions'][number]): string {
  return [question.header, question.question].filter(Boolean).join(' · ')
}

/** Session interaction process: FIFO ownership, response phases, and question collection. */
export class InteractionProcess {
  private activeInteraction: ActiveInteraction | undefined
  private readonly queue: QueuedInteraction[] = []

  constructor(
    private readonly port: InteractionPort,
    private readonly surfaces: InteractionSurfacePort,
    private readonly tui: TUI,
    private readonly theme: TuiTheme,
    private readonly visibleRows: () => number,
    private readonly onChange: () => void,
    scope: LifecycleScope,
  ) {
    scope.onDispose(() => {
      this.retireLocalState()
    })
  }

  get active(): boolean {
    return this.activeInteraction !== undefined
  }

  get activeKey(): string | undefined {
    return this.activeInteraction?.key
  }

  get current(): Readonly<InteractionSnapshot> {
    return {
      activeKey: this.activeInteraction?.key,
      phase: this.activeInteraction?.phase ?? 'idle',
      queued: this.queue.length,
    }
  }

  requestApproval(prompt: ApprovalPrompt): void {
    const key = approvalKey(prompt)
    this.enqueue({ key, open: () => this.showApproval(prompt, key) })
  }

  requestQuestions(prompt: QuestionPrompt): void {
    const key = questionKey(prompt)
    this.enqueue({ key, open: () => this.showQuestion(prompt, key, 0, []) })
  }

  resolve(resolution: InteractionResolution): void {
    this.complete(resolutionKey(resolution))
  }

  cancel(): boolean {
    const active = this.activeInteraction
    if (active === undefined) return false
    if (active.phase === 'cancelling') return true
    const key = active.key
    active.phase = 'cancelling'
    this.onChange()
    void this.port.cancel().then(
      () => { this.complete(key) },
      (error: unknown) => { this.reopen(key, 'cancelling', error) },
    )
    return true
  }

  private retireLocalState(): void {
    this.queue.splice(0)
    this.activeInteraction?.close?.()
    this.activeInteraction = undefined
  }

  private enqueue(interaction: QueuedInteraction): void {
    if (this.activeInteraction?.key === interaction.key
      || this.queue.some(candidate => candidate.key === interaction.key)) return
    this.queue.push(interaction)
    this.startNext()
    this.onChange()
  }

  private startNext(): void {
    if (this.activeInteraction !== undefined) return
    const next = this.queue.shift()
    if (next === undefined) return
    this.activeInteraction = { ...next, close: undefined, phase: 'open' }
    next.open()
  }

  private setSurface(key: string, close: () => void): void {
    const active = this.activeInteraction
    if (active?.key !== key) {
      close()
      return
    }
    active.close?.()
    active.close = close
  }

  private hideSurface(key: string): void {
    const active = this.activeInteraction
    if (active?.key !== key) return
    active.close?.()
    active.close = undefined
  }

  private complete(key: string): void {
    const active = this.activeInteraction
    if (active?.key !== key) {
      const queued = this.queue.findIndex(candidate => candidate.key === key)
      if (queued >= 0) this.queue.splice(queued, 1)
      return
    }
    active.close?.()
    this.activeInteraction = undefined
    this.startNext()
    this.onChange()
  }

  private respond(key: string, action: () => Promise<void>): void {
    const active = this.activeInteraction
    if (active?.key !== key || active.phase !== 'open') return
    active.phase = 'responding'
    this.onChange()
    void action().then(
      () => { this.complete(key) },
      (error: unknown) => { this.reopen(key, 'responding', error) },
    )
  }

  private reopen(key: string, phase: ActiveInteraction['phase'], error: unknown): void {
    const active = this.activeInteraction
    if (active?.key !== key || active.phase !== phase) return
    active.phase = 'open'
    this.port.notice(error instanceof Error ? error.message : String(error))
    this.onChange()
  }

  private showApproval(prompt: ApprovalPrompt, key: string): void {
    const dialog = new ApprovalDialog(
      prompt.toolName,
      prompt.reason,
      this.theme,
      outcome => { this.respond(key, () => this.port.answerApproval(prompt, outcome)) },
      () => { this.cancel() },
    )
    const surface = this.surfaces.open(dialog)
    this.setSurface(key, () => { surface.close() })
  }

  private showQuestion(
    prompt: QuestionPrompt,
    key: string,
    index: number,
    answers: Array<{ id: string; selected: string[]; custom?: string }>,
  ): void {
    const question = prompt.questions[index]
    if (question === undefined) {
      this.respond(key, () => this.port.answerQuestions(prompt, answers))
      return
    }
    const close = (): void => { this.hideSurface(key) }
    const next = (answer: { id: string; selected: string[]; custom?: string }): void => {
      const completed = [...answers, answer]
      if (index + 1 >= prompt.questions.length) {
        this.respond(key, () => this.port.answerQuestions(prompt, completed))
        return
      }
      close()
      this.showQuestion(prompt, key, index + 1, completed)
    }
    const custom = (selected: string[]): void => {
      close()
      const input = new TextInputDialog(
        this.tui,
        `${questionTitle(question)} · Other`,
        this.theme,
        text => {
          if (text.trim() !== '') next({ id: question.id, selected, custom: text })
        },
        () => { this.cancel() },
      )
      const surface = this.surfaces.open(input)
      this.setSurface(key, () => { surface.close() })
    }
    const options: SelectItem[] = (question.options ?? []).map(option => ({
      value: option.label,
      label: option.label,
      ...option.description === undefined ? {} : { description: option.description },
    }))
    const cancel = (): void => { this.cancel() }
    let dialog: Component
    if (question.multiSelect) {
      dialog = new MultiSelectDialog(
        questionTitle(question),
        options,
        this.visibleRows,
        this.theme,
        selected => { next({ id: question.id, selected }) },
        custom,
        cancel,
      )
    } else if (options.length === 0) {
      dialog = new TextInputDialog(
        this.tui,
        questionTitle(question),
        this.theme,
        text => {
          if (text.trim() !== '') next({ id: question.id, selected: [], custom: text })
        },
        cancel,
      )
    } else {
      const customValue = '__dsh_tui_custom__'
      dialog = new ChoiceDialog(
        questionTitle(question),
        [...options, { value: customValue, label: 'Other…' }],
        this.theme,
        item => {
          if (item.value === customValue) custom([])
          else next({ id: question.id, selected: [item.value] })
        },
        cancel,
        question.detail,
      )
    }
    const surface = this.surfaces.open(dialog)
    this.setSurface(key, () => { surface.close() })
  }
}

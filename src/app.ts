import {
  CombinedAutocompleteProvider,
  Editor,
  Key,
  ProcessTerminal,
  Text,
  TuiMainScreen,
  matchesKey,
  type OverlayHandle,
  type SlashCommand,
} from '@earendil-works/pi-tui'
import type {
  IApiClient,
  ModelSelection,
  SessionSummary,
} from '@deepseek-ai/dsh-host-apiproxy'
import type { ResolvedConfig } from './config.ts'
import {
  HarnessController,
  type ApprovalPrompt,
  type QuestionPrompt,
  type TuiControllerSink,
  type TuiState,
} from './controller.ts'
import {
  ChoiceDialog,
  ModelDialog,
  MultiSelectDialog,
  RewindDialog,
  TextInputDialog,
} from './dialogs.ts'
import { sanitizeTerminalText } from './text.ts'
import { createTheme, type TuiTheme } from './theme.ts'
import { composerStats } from './stats.ts'
import { DiffLineLocator } from './diff-location.ts'
import { TranscriptComponent } from './transcript.ts'
import { ComposerAnchoredLayout } from './layout.ts'
import type { RewindPreview, WorkspaceCheckpointStore } from './checkpoint.ts'
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  parseMouseReport,
  type MouseReport,
} from './mouse.ts'

const DOUBLE_ESCAPE_MS = 600

const COMMANDS: SlashCommand[] = [
  { name: 'help', description: 'Show terminal commands' },
  { name: 'new', description: 'Create a new session' },
  { name: 'resume', description: 'Switch to another session', argumentHint: '[session-id]' },
  { name: 'model', description: 'Select model and provider', argumentHint: '[provider/model]' },
  { name: 'details', description: 'Toggle expanded tool output' },
  { name: 'status', description: 'Show current session status' },
  { name: 'rewind', description: 'Rewind the last turn when the checkpoint provider is installed' },
  { name: 'exit', description: 'Exit the terminal client' },
]

/** Launcher-owned exit function used instead of calling process.exit from raw mode. */
export interface TuiRuntime {
  exit(code: number): void
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  stderr: NodeJS.WriteStream
}

function sessionDescription(session: SessionSummary): string {
  return session.cwd ?? String(session.sessionId)
}

function questionTitle(question: QuestionPrompt['questions'][number]): string {
  return [question.header, question.question].filter(Boolean).join(' · ')
}

/** Main-screen pi-tui application for one in-process Harness API client. */
export class TuiApplication implements TuiControllerSink {
  private readonly terminal = new ProcessTerminal()
  private readonly tui: TuiMainScreen
  private readonly theme: TuiTheme
  private readonly controller: HarnessController
  private readonly header: Text
  private readonly status = new Text('', 0, 0)
  private readonly footer = new Text('', 0, 0)
  private readonly editor: Editor
  private readonly transcript: TranscriptComponent
  private readonly diffLineLocator = new DiffLineLocator()
  private readonly layout: ComposerAnchoredLayout
  private removeInputListener?: () => void
  private spinner: ReturnType<typeof setInterval> | undefined
  private spinnerFrame = 0
  private showDetails = false
  private lastEscapeAt = 0
  private disposed = false
  private exiting = false
  private interactionActive = false
  private composerModalActive = false
  private readonly interactionQueue: Array<() => void> = []
  private autocompleteCwd: string

  constructor(
    api: IApiClient,
    private readonly config: ResolvedConfig,
    private readonly runtime: TuiRuntime,
    private readonly checkpoints: WorkspaceCheckpointStore,
  ) {
    this.theme = createTheme(config.color)
    this.tui = new TuiMainScreen(this.terminal, config.showHardwareCursor)
    const initial: TuiState = {
      sessionId: undefined,
      cwd: config.cwd,
      running: false,
      connected: false,
      events: [],
      queue: [],
      models: undefined,
      projections: {},
      notice: undefined,
      error: undefined,
    }
    this.controller = new HarnessController(api, this, config.cwd, config.historyMessages)
    this.header = new Text('', 0, 0)
    this.transcript = new TranscriptComponent(
      initial,
      this.theme,
      config.showReasoning,
      config.maxToolOutputLines,
      config.thinkingMaxLines,
    )
    this.editor = new Editor(this.tui, this.theme.editor, { paddingX: 1, autocompleteMaxVisible: 10 })
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, config.cwd))
    this.autocompleteCwd = config.cwd
    this.editor.onSubmit = text => { void this.submit(text) }
    this.layout = new ComposerAnchoredLayout(
      this.header,
      this.transcript,
      this.status,
      this.editor,
      this.footer,
      () => this.terminal.rows,
    )
    this.tui.addChild(this.layout)
    this.tui.setFocus(this.editor)
  }

  /** Start raw-mode rendering and bind or resume the configured session. */
  async start(): Promise<void> {
    if (!this.runtime.stdin.isTTY || !this.runtime.stdout.isTTY) {
      throw new Error('deepseek-harness-tui requires an interactive TTY')
    }
    this.terminal.setTitle(this.config.title)
    this.removeInputListener = this.tui.addInputListener(data => this.handleGlobalInput(data))
    this.tui.start()
    this.terminal.write(ENABLE_MOUSE_TRACKING)
    await this.controller.start(this.config.sessionId)
  }

  /** Restore the terminal and stop controller streams. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.controller.dispose()
    if (this.spinner !== undefined) clearInterval(this.spinner)
    this.terminal.write(DISABLE_MOUSE_TRACKING)
    this.removeInputListener?.()
    this.tui.stop()
    await this.terminal.drainInput(250, 30)
  }

  render(state: Readonly<TuiState>): void {
    if (this.disposed) return
    this.transcript.setState(state)
    this.diffLineLocator.resolve(state, () => {
      if (this.disposed || this.controller.current.sessionId !== state.sessionId) return
      this.transcript.setDiffLineStarts(this.diffLineLocator.current)
      this.tui.requestRender()
    })
    this.transcript.setDiffLineStarts(this.diffLineLocator.current)
    this.header.setText([
      this.theme.bold(this.theme.accent(`✦ ${this.config.title}`)),
      this.theme.dim(`${state.cwd}${state.sessionId === undefined ? '' : ` · ${String(state.sessionId)}`}`),
    ].join('\n'))
    this.updateStatus(state)
    const selection = state.models?.current
    const model = selection === undefined
      ? 'model unavailable'
      : `${selection.provider}/${selection.model}${selection.reasoningEffort === undefined ? '' : ` · ${selection.reasoningEffort}`}`
    const stats = composerStats(state.projections)
    this.footer.setText([
      this.theme.dim(`${model} · Ctrl+O details · Shift+Tab effort · /help`),
      ...stats === '' ? [] : [this.theme.dim(stats)],
    ].join('\n'))
    if (state.cwd !== this.autocompleteCwd) {
      this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, state.cwd))
      this.autocompleteCwd = state.cwd
    }
    this.tui.requestRender()
  }

  requestApproval(prompt: ApprovalPrompt): void {
    this.enqueueInteraction(() => this.showApproval(prompt))
  }

  requestQuestions(prompt: QuestionPrompt): void {
    this.enqueueInteraction(() => this.showQuestion(prompt, 0, []))
  }

  private updateStatus(state: Readonly<TuiState>): void {
    if (state.running) {
      if (this.spinner === undefined) {
        this.spinner = setInterval(() => {
          this.spinnerFrame += 1
          this.updateStatus(this.controller.current)
          this.tui.requestRender()
        }, 160)
      }
      const frames = ['·', '✢', '✳', '✦']
      const glyph = frames[this.spinnerFrame % frames.length] ?? '·'
      this.status.setText(this.theme.accent(`${glyph} Working · Enter steer · Alt+Enter queue · Esc cancel`))
      return
    }
    if (this.spinner !== undefined) {
      clearInterval(this.spinner)
      this.spinner = undefined
    }
    this.status.setText(state.connected
      ? this.theme.dim('Ready · Enter send · Esc Esc rewind')
      : this.theme.warning('Connecting…'))
  }

  private handleGlobalInput(data: string): { consume?: boolean } | undefined {
    const mouse = parseMouseReport(data)
    if (mouse !== undefined) {
      this.handleMouse(mouse)
      return { consume: true }
    }
    if (this.composerModalActive) return undefined
    if (matchesKey(data, Key.ctrl('c'))) {
      if (this.controller.current.running) void this.runAction(() => this.controller.cancel())
      else void this.requestExit(0)
      return { consume: true }
    }
    if (matchesKey(data, Key.alt(Key.enter))) {
      void this.submitEditor('queue')
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('o'))) {
      this.showDetails = !this.showDetails
      this.transcript.setDetails(this.showDetails)
      this.tui.requestRender()
      return { consume: true }
    }
    if (matchesKey(data, Key.shift(Key.tab))) {
      void this.cycleReasoningEffort()
      return { consume: true }
    }
    if (matchesKey(data, Key.escape) && !this.tui.hasOverlay()) {
      if (this.controller.current.running) {
        void this.runAction(() => this.controller.cancel())
        return { consume: true }
      }
      if (this.editor.getExpandedText() === '') {
        const now = Date.now()
        if (now - this.lastEscapeAt <= DOUBLE_ESCAPE_MS) {
          this.lastEscapeAt = 0
          this.requestRewind()
        } else {
          this.lastEscapeAt = now
          this.controller.notice('Press Escape again to rewind the last turn.')
        }
        return { consume: true }
      }
    }
    return undefined
  }

  private handleMouse(mouse: MouseReport): void {
    const blocked = this.composerModalActive || this.tui.hasOverlay()
    const renderState = this.tui.captureRenderState()
    const transcriptLine = blocked
      ? -1
      : this.layout.transcriptRowAt(mouse.y, renderState.previousViewportTop, this.terminal.columns)
    let changed = this.transcript.handlePointer(transcriptLine, 'move')
    if (!blocked && (mouse.button & 64) !== 0) {
      changed = this.transcript.handlePointer(
        transcriptLine,
        (mouse.button & 1) === 0 ? 'wheel-up' : 'wheel-down',
      ) || changed
    } else if (!blocked && mouse.button === 0 && !mouse.release) {
      changed = this.transcript.handlePointer(transcriptLine, 'click') || changed
    }
    if (changed) this.tui.requestRender()
  }

  private async submitEditor(mode: 'queue' | 'steer'): Promise<void> {
    const text = this.editor.getExpandedText()
    if (text.trim() === '') return
    this.editor.setText('')
    this.editor.addToHistory(text)
    await this.submit(text, mode)
  }

  private async submit(value: string, forcedMode?: 'queue' | 'steer'): Promise<void> {
    const text = value.trim()
    if (text === '') return
    try {
      if (await this.handleCommand(text)) return
      const mode = forcedMode ?? (this.controller.current.running ? 'steer' : 'queue')
      await this.controller.prompt(value, mode)
    } catch (error: unknown) {
      if (this.editor.getExpandedText() === '') this.editor.setText(value)
      this.controller.notice(error instanceof Error ? error.message : String(error))
    }
  }

  private async handleCommand(text: string): Promise<boolean> {
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)
    if (match === null) return false
    const command = match[1]?.toLowerCase()
    const argument = match[2]?.trim() ?? ''
    switch (command) {
      case 'help':
        this.controller.notice([
          '/new · new session',
          '/resume [id] · switch session',
          '/model [provider/model] · select model',
          '/details · expand or collapse tool output',
          '/status · current session details',
          '/rewind · restore the previous turn checkpoint',
          '/exit · leave the TUI',
        ].join('\n'))
        return true
      case 'new':
        await this.controller.newSession()
        return true
      case 'resume':
        if (argument !== '') await this.controller.resume(argument)
        else await this.openSessionSelector()
        return true
      case 'model':
        if (argument !== '') await this.selectNamedModel(argument)
        else await this.openModelSelector()
        return true
      case 'details':
        this.showDetails = !this.showDetails
        this.transcript.setDetails(this.showDetails)
        this.tui.requestRender()
        return true
      case 'status': {
        const state = this.controller.current
        this.controller.notice([
          `Session: ${state.sessionId === undefined ? 'none' : String(state.sessionId)}`,
          `Directory: ${state.cwd}`,
          `State: ${state.running ? 'running' : 'idle'}`,
          `Stream: ${state.connected ? 'connected' : 'reconnecting'}`,
          `Queued: ${state.queue.length}`,
        ].join('\n'))
        return true
      }
      case 'rewind':
        this.requestRewind()
        return true
      case 'exit':
      case 'quit':
        await this.requestExit(0)
        return true
      default:
        return false
    }
  }

  private requestRewind(): void {
    void this.runAction(() => this.openRewind())
  }

  private async openRewind(): Promise<void> {
    if (this.tui.hasOverlay() || this.composerModalActive) return
    const sessionId = this.controller.current.sessionId
    if (sessionId === undefined) throw new Error('no terminal session is active')
    const preview = await this.checkpoints.preview(String(sessionId))
    const close = (): void => {
      this.layout.setComposerOverride(undefined)
      this.composerModalActive = false
      this.tui.setFocus(this.editor)
      this.tui.requestRender()
    }
    const dialog = new RewindDialog(
      preview,
      this.theme,
      () => {
        close()
        void this.runAction(() => this.performRewind(preview))
      },
      close,
    )
    this.composerModalActive = true
    this.layout.setComposerOverride(dialog)
    this.tui.setFocus(dialog)
    this.tui.requestRender()
  }

  private async performRewind(preview: RewindPreview): Promise<void> {
    const rollback = await this.checkpoints.restore(preview)
    try {
      await this.controller.rewind(preview)
    } catch (error: unknown) {
      try {
        await rollback()
      } catch (rollbackError: unknown) {
        throw new Error(`rewind failed (${String(error)}) and workspace rollback also failed (${String(rollbackError)})`)
      }
      throw error
    }
    this.checkpoints.consume(preview.sessionId)
    this.editor.setText(preview.prompt)
    this.tui.requestRender()
  }

  private async openSessionSelector(): Promise<void> {
    if (this.tui.hasOverlay() || this.composerModalActive) return
    const sessions = await this.controller.sessions()
    const current = this.controller.current.sessionId
    const items = sessions
      .filter(session => session.sessionId !== current)
      .map(session => ({
        value: String(session.sessionId),
        label: String(session.sessionId),
        description: sessionDescription(session),
      }))
    if (items.length === 0) {
      this.controller.notice('No other sessions are available.')
      return
    }
    let handle: OverlayHandle
    const close = (): void => { handle.hide() }
    const dialog = new ChoiceDialog(
      'Resume session',
      items,
      this.theme,
      item => {
        close()
        void this.runAction(() => this.controller.resume(item.value))
      },
      close,
    )
    handle = this.tui.showOverlay(dialog, { width: '85%', maxHeight: '80%', margin: 1 })
  }

  private async openModelSelector(): Promise<void> {
    if (this.tui.hasOverlay() || this.composerModalActive) return
    const models = await this.controller.refreshModels()
    const close = (): void => {
      this.layout.setComposerOverride(undefined)
      this.composerModalActive = false
      this.tui.setFocus(this.editor)
      this.tui.requestRender()
    }
    const dialog = new ModelDialog(
      models,
      this.theme,
      selected => {
        close()
        void this.runAction(() => this.controller.selectModel(selected))
      },
      close,
    )
    this.composerModalActive = true
    this.layout.setComposerOverride(dialog)
    this.tui.setFocus(dialog)
    this.tui.requestRender()
  }

  private async selectNamedModel(name: string): Promise<void> {
    const models = await this.controller.refreshModels()
    const matches = models.groups.flatMap(group => group.models
      .filter(model => `${group.id}/${model.id}` === name || model.id === name)
      .map(model => ({ provider: group.id, model: model.id })))
    if (matches.length !== 1) throw new Error(matches.length === 0
      ? `model "${name}" was not found`
      : `model "${name}" is ambiguous; use provider/model`)
    await this.controller.selectModel(matches[0] as ModelSelection)
  }

  private async cycleReasoningEffort(): Promise<void> {
    const models = this.controller.current.models ?? await this.controller.refreshModels()
    const current = models.current
    const model = models.groups.find(group => group.id === current.provider)
      ?.models.find(candidate => candidate.id === current.model)
    const efforts = model?.reasoning?.efforts
    if (efforts === undefined || efforts.length === 0) {
      this.controller.notice('The current model does not expose selectable reasoning efforts.')
      return
    }
    const values: Array<string | undefined> = [undefined, ...efforts.map(effort => effort.id)]
    const index = values.indexOf(current.reasoningEffort)
    const next = values[(index + 1) % values.length]
    await this.controller.selectModel({
      provider: current.provider,
      model: current.model,
      ...next === undefined ? {} : { reasoningEffort: next },
    })
  }

  private enqueueInteraction(job: () => void): void {
    this.interactionQueue.push(job)
    this.startNextInteraction()
  }

  private startNextInteraction(): void {
    if (this.interactionActive) return
    const next = this.interactionQueue.shift()
    if (next === undefined) return
    this.interactionActive = true
    next()
  }

  private completeInteraction(): void {
    this.interactionActive = false
    this.startNextInteraction()
  }

  private showApproval(prompt: ApprovalPrompt): void {
    let handle: OverlayHandle
    const settle = (outcome: 'allowed-once' | 'rejected'): void => {
      handle.hide()
      void this.runAction(() => this.controller.answerApproval(prompt, outcome))
        .finally(() => this.completeInteraction())
    }
    const dialog = new ChoiceDialog(
      `Allow ${sanitizeTerminalText(prompt.toolName)}?`,
      [
        {
          value: 'allowed-once',
          label: 'Allow once',
          ...prompt.reason === undefined ? {} : { description: prompt.reason },
        },
        { value: 'rejected', label: 'Reject' },
      ],
      this.theme,
      item => settle(item.value === 'allowed-once' ? 'allowed-once' : 'rejected'),
      () => settle('rejected'),
      prompt.reason,
    )
    handle = this.tui.showOverlay(dialog, { width: '80%', maxHeight: '70%', margin: 1 })
  }

  private showQuestion(
    prompt: QuestionPrompt,
    index: number,
    answers: Array<{ id: string; selected: string[]; custom?: string }>,
  ): void {
    const question = prompt.questions[index]
    if (question === undefined) {
      void this.runAction(() => this.controller.answerQuestions(prompt, answers))
        .finally(() => this.completeInteraction())
      return
    }
    let handle: OverlayHandle
    const close = (): void => { handle.hide() }
    const next = (answer: { id: string; selected: string[]; custom?: string }): void => {
      close()
      this.showQuestion(prompt, index + 1, [...answers, answer])
    }
    const cancel = (): void => {
      close()
      void this.runAction(() => this.controller.cancelQuestions(prompt))
        .finally(() => this.completeInteraction())
    }
    const custom = (selected: string[]): void => {
      close()
      let inputHandle: OverlayHandle
      const input = new TextInputDialog(
        this.tui,
        `${questionTitle(question)} · Other`,
        this.theme,
        text => {
          if (text.trim() === '') return
          inputHandle.hide()
          this.showQuestion(prompt, index + 1, [
            ...answers,
            { id: question.id, selected, custom: text },
          ])
        },
        () => {
          inputHandle.hide()
          cancel()
        },
      )
      inputHandle = this.tui.showOverlay(input, { width: '85%', maxHeight: '70%', margin: 1 })
    }
    const options = (question.options ?? []).map(option => ({
      value: option.label,
      label: option.label,
      ...option.description === undefined ? {} : { description: option.description },
    }))
    if (question.multiSelect) {
      const dialog = new MultiSelectDialog(
        questionTitle(question),
        options,
        this.theme,
        selected => next({ id: question.id, selected }),
        custom,
        cancel,
      )
      handle = this.tui.showOverlay(dialog, { width: '85%', maxHeight: '80%', margin: 1 })
      return
    }
    if (options.length === 0) {
      handle = this.tui.showOverlay(new TextInputDialog(
        this.tui,
        questionTitle(question),
        this.theme,
        text => {
          if (text.trim() === '') return
          next({ id: question.id, selected: [], custom: text })
        },
        cancel,
      ), { width: '85%', maxHeight: '70%', margin: 1 })
      return
    }
    const customValue = '__dsh_tui_custom__'
    const dialog = new ChoiceDialog(
      questionTitle(question),
      [...options, { value: customValue, label: 'Other…' }],
      this.theme,
      item => item.value === customValue
        ? custom([])
        : next({ id: question.id, selected: [item.value] }),
      cancel,
      question.detail,
    )
    handle = this.tui.showOverlay(dialog, { width: '85%', maxHeight: '80%', margin: 1 })
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    try {
      await action()
    } catch (error: unknown) {
      this.controller.notice(error instanceof Error ? error.message : String(error))
    }
  }

  private async requestExit(code: number): Promise<void> {
    if (this.exiting) return
    this.exiting = true
    await this.dispose()
    this.runtime.exit(code)
  }
}

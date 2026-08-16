import {
  CombinedAutocompleteProvider,
  Editor,
  Key,
  ProcessTerminal,
  Text,
  TuiMainScreen,
  matchesKey,
  type OverlayHandle,
} from '@earendil-works/pi-tui'
import type {
  IApiClient,
  ModelSelection,
  SessionSummary,
} from '@deepseek-ai/dsh-host-apiproxy'
import type {
  MemoryActivity,
  MemoryMutation,
  ProjectMemoryService,
} from '@vascent/deepseek-harness-memory'
import type { ResolvedConfig } from './config.ts'
import {
  HarnessController,
  type ApprovalPrompt,
  type QuestionPrompt,
  type TuiControllerSink,
  type TuiState,
} from '../runtime/controller.ts'
import {
  ChoiceDialog,
  MemoryDialog,
  ModelDialog,
  MultiSelectDialog,
  RewindCheckpointDialog,
  RewindDialog,
  TextInputDialog,
} from '../presentation/dialogs.ts'
import { sanitizeTerminalText } from '../text.ts'
import { createTheme, type TuiTheme } from '../presentation/theme.ts'
import { composerStats } from '../presentation/stats.ts'
import { DiffLineLocator } from '../presentation/diff-location.ts'
import { TranscriptComponent } from '../presentation/transcript.ts'
import { ComposerAnchoredLayout } from '../presentation/layout.ts'
import { TrajectoryView } from '../trajectory/view.ts'
import type {
  RewindCheckpointSummary,
  RewindPreview,
  WorkspaceCheckpointStore,
} from '../checkpoint.ts'
import {
  DISABLE_MOUSE_TRACKING,
  ENABLE_MOUSE_TRACKING,
  parseMouseReport,
  type MouseReport,
} from '../presentation/mouse.ts'
import {
  TerminalCommandDirectory,
  type HostCommandSource,
  type TerminalCommandDefinition,
} from '../runtime/commands.ts'
import {
  configurationSnapshot,
  sessionControlSummary,
  taskSnapshot,
} from '../runtime/session-controls.ts'
import {
  ConfigView,
  type ConfigEntryStage,
} from '../presentation/config/config-view.ts'
import {
  TaskView,
  type GoalAction,
} from '../presentation/task/task-view.ts'
import {
  SkillCatalog,
  apiSkillCatalogSource,
  type SkillCatalogSnapshot,
} from '../runtime/skill-catalog.ts'
import {
  mergeSlashCatalog,
  resolveLeadingSlash,
  slashAutocompleteRows,
  slashHelpText,
} from '../runtime/slash-catalog.ts'
import { SkillsView } from '../presentation/skills.ts'
import {
  LocalSkillAuthoring,
  type LocalSkillDocument,
} from './skill-authoring.ts'
import { SkillAuthoringCoordinator } from './skill-authoring-coordinator.ts'
import { SkillAuthoringWizard } from '../presentation/skill-authoring.ts'
import {
  externalEditorCommand,
  runExternalEditor,
} from './external-editor.ts'
import { AttachmentDraftStore } from './attachments/drafts.ts'
import { imageDraftFromPath } from './attachments/files.ts'
import {
  imageDraftFromClipboard,
  type ClipboardImageLoader,
} from './attachments/clipboard.ts'
import {
  AttachmentCoordinator,
  type VisionGateway,
} from './attachments/coordinator.ts'
import {
  AttachmentComposerFrame,
  AttachmentRail,
} from '../presentation/attachments.ts'
import { VisionConfigView } from '../presentation/config/vision-view.ts'
import type { VisionStatus } from '@vascent/deepseek-harness-vision'
import { KeymapView } from '../presentation/config/keymap-view.ts'
import {
  memoryKeymapGateway,
  type KeymapSettingsGateway,
} from './keymap-settings.ts'
import {
  resolveKeymapInput,
  type KeymapAction,
} from '../input/keymap.ts'

const DOUBLE_ESCAPE_MS = 600

/** Launcher-owned exit function used instead of calling process.exit from raw mode. */
export interface TuiRuntime {
  exit(code: number): void
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  stderr: NodeJS.WriteStream
}

/** Optional composition ports kept separate from the stable application core. */
export interface TuiApplicationDependencies {
  commandSource?: HostCommandSource
  vision?: VisionGateway
  keymap?: KeymapSettingsGateway
  initialImagePaths?: readonly string[]
  clipboardImage?: ClipboardImageLoader
}

function sessionDescription(session: SessionSummary): string {
  return session.cwd ?? String(session.sessionId)
}

function questionTitle(question: QuestionPrompt['questions'][number]): string {
  return [question.header, question.question].filter(Boolean).join(' · ')
}

function shellArgument(value: string): string {
  if (/^[A-Za-z0-9._:-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

function resumeHint(sessionId: TuiState['sessionId']): string | undefined {
  if (sessionId === undefined) return undefined
  return `\nResume this session with:\n  dsh-tui --resume ${shellArgument(String(sessionId))}\n\n`
}

function isWorking(state: Readonly<TuiState>): boolean {
  return state.running || state.pendingSubmissions.some(submission => submission.intent === 'working')
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
  private readonly attachmentRail: AttachmentRail
  private readonly attachmentComposer: AttachmentComposerFrame
  private readonly attachmentDrafts = new AttachmentDraftStore()
  private readonly attachmentCoordinator: AttachmentCoordinator | undefined
  private readonly vision: VisionGateway | undefined
  private readonly diffLineLocator = new DiffLineLocator()
  private readonly layout: ComposerAnchoredLayout
  private trajectoryView: TrajectoryView | undefined
  private configView: ConfigView | undefined
  private visionConfigView: VisionConfigView | undefined
  private keymapView: KeymapView | undefined
  private taskView: TaskView | undefined
  private skillsView: SkillsView | undefined
  private removeInputListener?: () => void
  private spinner: ReturnType<typeof setInterval> | undefined
  private spinnerFrame = 0
  private workingStartedAt: number | undefined
  private workingSessionId: TuiState['sessionId'] = undefined
  private showDetails = false
  private lastEscapeAt = 0
  private rewindArmTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private exiting = false
  private interactionActive = false
  private composerModalActive = false
  private rewindProgress: Text | undefined
  private rewindSummaries: RewindCheckpointSummary[] | undefined
  private rewindCheckpointDialog: RewindCheckpointDialog | undefined
  private rewindSurfaceGeneration = 0
  private memoryActivity: MemoryActivity = { state: 'idle' }
  private readonly removeMemoryActivity: () => void
  private readonly interactionQueue: Array<() => void> = []
  private readonly commands: TerminalCommandDirectory
  private readonly skillCatalog: SkillCatalog
  private readonly skillAuthoring: SkillAuthoringCoordinator
  private autocompleteCwd: string
  private attachmentSessionId: TuiState['sessionId'] = undefined
  private readonly removeAttachmentListener: () => void
  private readonly keymap: KeymapSettingsGateway
  private readonly removeKeymapListener: () => void
  private visionStatus: VisionStatus | undefined
  private attachmentRailFocused = false
  private readonly initialImagePaths: readonly string[]
  private readonly clipboardImage: ClipboardImageLoader
  private clipboardPastePending = false

  constructor(
    api: IApiClient,
    private readonly config: ResolvedConfig,
    private readonly runtime: TuiRuntime,
    private readonly checkpoints: WorkspaceCheckpointStore,
    private readonly memory: ProjectMemoryService,
    dependencies: TuiApplicationDependencies = {},
  ) {
    const {
      commandSource,
      vision,
      keymap,
      initialImagePaths = [],
      clipboardImage = imageDraftFromClipboard,
    } = dependencies
    this.initialImagePaths = initialImagePaths
    this.clipboardImage = clipboardImage
    this.theme = createTheme(config.color)
    this.tui = new TuiMainScreen(this.terminal, config.showHardwareCursor)
    const initial: TuiState = {
      sessionId: undefined,
      cwd: config.cwd,
      running: false,
      connected: false,
      events: [],
      historyHasMore: false,
      queue: [],
      pendingSubmissions: [],
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
    this.attachmentRail = new AttachmentRail(
      this.theme,
      index => { this.attachmentDrafts.removeAt(index) },
      () => this.leaveAttachmentRail(),
    )
    this.vision = vision
    this.keymap = keymap ?? memoryKeymapGateway({ keymap: config.keymap })
    this.visionStatus = vision === undefined ? undefined : {
      config: vision.config,
      proxyRegistered: false,
      proxySupportsImages: false,
    }
    this.attachmentCoordinator = vision === undefined
      ? undefined
      : new AttachmentCoordinator(this.attachmentDrafts, vision)
    this.editor = new Editor(this.tui, this.theme.editor, { paddingX: 1, autocompleteMaxVisible: 10 })
    this.attachmentComposer = new AttachmentComposerFrame(this.editor, this.theme)
    this.commands = new TerminalCommandDirectory(
      this.localCommands(),
      commandSource,
      () => this.refreshAutocomplete(),
      [{ name: 'permission', handler: () => this.openPermissionConfig() }],
    )
    this.skillCatalog = new SkillCatalog(
      apiSkillCatalogSource(api),
      snapshot => this.handleSkillCatalogChange(snapshot),
    )
    this.skillAuthoring = new SkillAuthoringCoordinator(
      new LocalSkillAuthoring(),
      this.skillCatalog,
      { open: (document, created) => this.openSkillDocument(document, created) },
      message => this.controller.notice(message),
    )
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(
      slashAutocompleteRows(this.slashCandidates()),
      config.cwd,
    ))
    this.autocompleteCwd = config.cwd
    this.editor.onSubmit = text => {
      this.editor.addToHistory(text)
      void this.submit(text)
    }
    this.layout = new ComposerAnchoredLayout(
      this.header,
      this.transcript,
      this.status,
      this.attachmentComposer,
      this.footer,
      () => this.terminal.rows,
      this.attachmentRail,
    )
    this.tui.addChild(this.layout)
    this.tui.setFocus(this.editor)
    this.removeMemoryActivity = this.memory.onActivity((activity) => {
      if (this.disposed) return
      this.memoryActivity = activity
      this.updateStatus(this.controller.current)
      this.tui.requestRender()
    })
    this.removeAttachmentListener = this.attachmentDrafts.onChange((drafts) => {
      if (this.disposed) return
      this.attachmentRail.setDrafts(drafts)
      this.attachmentComposer.setDrafts(drafts)
      if (drafts.length === 0 && this.attachmentRailFocused) this.leaveAttachmentRail()
      this.tui.requestRender()
    })
    this.removeKeymapListener = this.keymap.subscribe((settings) => {
      if (this.disposed) return
      this.keymapView?.setPreset(settings.keymap)
      this.refreshConfigurationSurface()
      this.updateStatus(this.controller.current)
      this.tui.requestRender()
    })
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
    await this.loadInitialImages()
  }

  /** Restore the terminal and stop controller streams. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.controller.dispose()
    if (this.spinner !== undefined) clearInterval(this.spinner)
    if (this.rewindArmTimer !== undefined) clearTimeout(this.rewindArmTimer)
    this.commands.dispose()
    this.skillCatalog.dispose()
    this.removeMemoryActivity()
    this.removeAttachmentListener()
    this.removeKeymapListener()
    this.attachmentCoordinator?.cancel(false)
    this.terminal.write(DISABLE_MOUSE_TRACKING)
    this.removeInputListener?.()
    this.tui.stop()
    await this.terminal.drainInput(250, 30)
  }

  render(state: Readonly<TuiState>): void {
    if (this.disposed) return
    if (this.attachmentSessionId !== undefined && this.attachmentSessionId !== state.sessionId) {
      this.attachmentCoordinator?.cancel(false)
      this.attachmentDrafts.clear()
    }
    this.attachmentSessionId = state.sessionId
    const commandsChanged = this.commands.setSession(state.sessionId)
    this.skillCatalog.setSession(state.sessionId)
    this.transcript.setState(state)
    this.trajectoryView?.setState(state)
    this.configView?.setSnapshot(this.configurationSnapshot(state))
    this.taskView?.setSnapshot(taskSnapshot(state.projections, state.running, state.queue.length))
    this.skillsView?.setSnapshot(this.skillCatalog.current)
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
      this.theme.dim(model),
      ...(stats === '' ? [] : [this.theme.dim(stats)]),
    ].join('\n'))
    if (state.cwd !== this.autocompleteCwd || commandsChanged) {
      this.refreshAutocomplete(state.cwd, false)
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
    const history = this.layout.followsTranscriptTail ? '' : ' · Viewing history · PageDown to follow'
    const task = sessionControlSummary(state.projections)
    const taskStatus = task === '' ? '' : ` · ${task}`
    const visionActivity = state.pendingSubmissions.find(submission => submission.activity?.kind === 'vision')?.activity
    if (visionActivity?.kind === 'vision') {
      this.workingStartedAt = undefined
      this.workingSessionId = undefined
      if (this.spinner === undefined) {
        this.spinner = setInterval(() => {
          this.spinnerFrame += 1
          this.updateStatus(this.controller.current)
          this.tui.requestRender()
        }, 160)
      }
      const frames = ['·', '✢', '✳', '✦']
      const glyph = frames[this.spinnerFrame % frames.length] ?? '·'
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - visionActivity.startedAt) / 1_000))
      const images = `${String(visionActivity.imageCount)} image${visionActivity.imageCount === 1 ? '' : 's'}`
      this.status.setText([
        this.theme.accent(glyph),
        this.theme.dim(` Vision · Analyzing ${images} (${String(elapsedSeconds)}s · esc to interrupt${history})`),
      ].join(''))
      return
    }
    const working = isWorking(state)
    if (working) {
      if (this.workingStartedAt === undefined || this.workingSessionId !== state.sessionId) {
        this.workingStartedAt = Date.now()
        this.workingSessionId = state.sessionId
      }
      if (this.spinner === undefined) {
        this.spinner = setInterval(() => {
          this.spinnerFrame += 1
          this.updateStatus(this.controller.current)
          this.tui.requestRender()
        }, 160)
      }
      const frames = ['·', '✢', '✳', '✦']
      const glyph = frames[this.spinnerFrame % frames.length] ?? '·'
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.workingStartedAt) / 1_000))
      this.status.setText([
        this.theme.accent(glyph),
        this.theme.dim(` Working (${elapsedSeconds}s · esc to interrupt${history})`),
      ].join(''))
      return
    }
    this.workingStartedAt = undefined
    this.workingSessionId = undefined
    if (this.memoryActivity.state === 'learning') {
      if (this.spinner === undefined) {
        this.spinner = setInterval(() => {
          this.spinnerFrame += 1
          this.updateStatus(this.controller.current)
          this.tui.requestRender()
        }, 160)
      }
      const frames = ['·', '✢', '✳', '✦']
      const glyph = frames[this.spinnerFrame % frames.length] ?? '·'
      this.status.setText(this.theme.accent(`${glyph} Learning project memory…${history}`))
      return
    }
    if (this.spinner !== undefined) {
      clearInterval(this.spinner)
      this.spinner = undefined
    }
    if (this.lastEscapeAt !== 0) {
      this.status.setText(this.theme.warning(`Press Esc again to open rewind checkpoints${history}`))
      return
    }
    if (this.memoryActivity.state === 'error') {
      this.status.setText(this.theme.warning(`Memory learning failed: ${this.memoryActivity.message}${history}`))
      return
    }
    this.status.setText(state.connected
      ? this.theme.dim(`Ready${taskStatus}${history}`)
      : this.theme.warning(`Connecting…${history}`))
  }

  private handleGlobalInput(data: string): { consume?: boolean } | undefined {
    const mouse = parseMouseReport(data)
    if (mouse !== undefined) {
      this.handleMouse(mouse)
      return { consume: true }
    }
    if (this.composerModalActive) return undefined
    if (this.attachmentRailFocused) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
        this.leaveAttachmentRail()
        return { consume: true }
      }
      return undefined
    }
    const escape = matchesKey(data, Key.escape)
    if (!escape && this.lastEscapeAt !== 0) this.disarmRewind()
    const resolution = resolveKeymapInput(data, {
      working: isWorking(this.controller.current),
      hasAttachments: this.attachmentDrafts.snapshot.length > 0,
    }, this.keymap.current().keymap)
    if (resolution.kind !== 'unmatched') {
      if (resolution.kind === 'action') this.handleKeymapAction(resolution.action)
      return { consume: true }
    }
    const cursor = this.editor.getCursor()
    if (this.attachmentDrafts.snapshot.length > 0
      && matchesKey(data, Key.backspace)
      && cursor.line === 0
      && cursor.col === 0) {
      this.attachmentDrafts.removeLast()
      return { consume: true }
    }
    if (this.editor.getExpandedText() === '' && matchesKey(data, Key.pageUp)) {
      if (this.layout.pageTranscript(-1)) {
        this.updateStatus(this.controller.current)
        this.tui.requestRender()
      }
      return { consume: true }
    }
    if (this.editor.getExpandedText() === '' && matchesKey(data, Key.pageDown)) {
      if (this.layout.pageTranscript(1)) {
        this.updateStatus(this.controller.current)
        this.tui.requestRender()
      }
      return { consume: true }
    }
    if (escape && !this.tui.hasOverlay()) {
      if (this.imageSubmissionBusy) {
        this.attachmentCoordinator?.cancel()
        return { consume: true }
      }
      if (isWorking(this.controller.current)) {
        void this.runAction(() => this.controller.cancel())
        return { consume: true }
      }
      if (this.editor.getExpandedText() === '') {
        const now = Date.now()
        if (now - this.lastEscapeAt <= DOUBLE_ESCAPE_MS) {
          this.disarmRewind()
          this.requestRewind()
        } else {
          this.armRewind(now)
        }
        return { consume: true }
      }
    }
    return undefined
  }

  private handleKeymapAction(action: KeymapAction): void {
    switch (action) {
      case 'app.cancel-or-exit':
        if (this.imageSubmissionBusy) this.attachmentCoordinator?.cancel()
        else if (isWorking(this.controller.current)) void this.runAction(() => this.controller.cancel())
        else void this.requestExit(0)
        return
      case 'turn.queue':
        void this.submitEditor('queue')
        return
      case 'vision.paste':
        void this.runAction(() => this.pasteImage())
        return
      case 'attachments.focus':
        this.attachmentRailFocused = true
        this.tui.setFocus(this.attachmentRail)
        this.tui.requestRender()
        return
      case 'attachments.remove-last':
        this.attachmentDrafts.removeLast()
        return
      case 'details.toggle':
        this.setDetailsExpanded(!this.showDetails)
        return
      case 'reasoning.cycle':
        void this.cycleReasoningEffort()
    }
  }

  private handleMouse(mouse: MouseReport): void {
    const blocked = this.composerModalActive || this.tui.hasOverlay()
    const renderState = this.tui.captureRenderState()
    const transcriptLine = blocked
      ? -1
      : this.layout.transcriptRowAt(mouse.y, renderState.previousViewportTop)
    let changed = this.transcript.handlePointer(transcriptLine, 'move')
    if (!blocked && (mouse.button & 64) !== 0) {
      const direction = (mouse.button & 1) === 0 ? -1 : 1
      const blockScrolled = this.transcript.handlePointer(
        transcriptLine,
        direction < 0 ? 'wheel-up' : 'wheel-down',
      )
      changed = blockScrolled || changed
      if (!blockScrolled) changed = this.layout.scrollTranscript(direction * 3) || changed
    } else if (!blocked && mouse.button === 0 && !mouse.release) {
      changed = this.transcript.handlePointer(transcriptLine, 'click') || changed
    }
    if (changed) {
      this.updateStatus(this.controller.current)
      this.tui.requestRender()
    }
  }

  private async submitEditor(mode: 'queue' | 'steer'): Promise<void> {
    const text = this.editor.getExpandedText()
    if (text.trim() === '' && this.attachmentDrafts.snapshot.length === 0) return
    this.editor.setText('')
    this.editor.addToHistory(text)
    await this.submit(text, mode)
  }

  private async submit(value: string, forcedMode?: 'queue' | 'steer'): Promise<void> {
    const text = value.trim()
    if (text === '' && this.attachmentDrafts.snapshot.length === 0) return
    try {
      if (text.startsWith('/')) {
        if (await this.handleCommand(text)) return
        let resolution = resolveLeadingSlash(text, this.slashCandidates())
        if (resolution.kind === 'unknown' && this.controller.current.sessionId !== undefined) {
          await this.skillCatalog.refresh(true)
          resolution = resolveLeadingSlash(text, this.slashCandidates())
        }
        const catalogSettled = this.skillCatalog.current.status === 'ready'
          || this.skillCatalog.current.status === 'stale'
        if (resolution.kind === 'unknown' && catalogSettled) {
          throw new Error(`Unknown command or Skill "/${resolution.name}". Use /help or /skills to discover available entries.`)
        }
      }
      const mode = forcedMode ?? (isWorking(this.controller.current) ? 'steer' : 'queue')
      this.layout.followTranscript()
      if (this.attachmentDrafts.snapshot.length === 0) {
        await this.controller.prompt(value, mode)
      } else {
        const coordinator = this.attachmentCoordinator
        const state = this.controller.current
        const selection = state.models?.current
        if (coordinator === undefined) throw new Error('Vision is unavailable in this profile.')
        if (state.sessionId === undefined || selection === undefined) {
          throw new Error('Wait for the active session and model before submitting images.')
        }
        await coordinator.submit(
          String(state.sessionId),
          selection,
          value,
          mode,
          state.projections.imageLimits,
          (displayText, submitMode, prepareContent) => this.controller.promptWithPreparation(
            displayText,
            submitMode,
            prepareContent,
          ),
        )
      }
    } catch (error: unknown) {
      if (this.editor.getExpandedText() === '') this.editor.setText(value)
      this.controller.notice(error instanceof Error ? error.message : String(error))
    }
  }

  private async handleCommand(text: string): Promise<boolean> {
    return this.commands.dispatch(text)
  }

  private localCommands(): TerminalCommandDefinition[] {
    return [{
      name: 'help',
      description: 'Show terminal and Harness commands',
      handler: () => { this.controller.notice(slashHelpText(this.slashCandidates())) },
    }, {
      name: 'clear',
      description: 'Clear the conversation and start a new session',
      handler: async () => {
        this.layout.followTranscript()
        await this.controller.clearSession()
      },
    }, {
      name: 'new',
      description: 'Create a new session',
      handler: () => this.controller.newSession(),
    }, {
      name: 'resume',
      description: 'Switch to another session',
      argumentHint: '[session-id]',
      handler: async (argument) => {
        if (argument !== '') await this.controller.resume(argument)
        else await this.openSessionSelector()
      },
    }, {
      name: 'model',
      description: 'Select model and provider',
      argumentHint: '[provider/model]',
      handler: async (argument) => {
        if (argument !== '') await this.selectNamedModel(argument)
        else await this.openModelSelector()
      },
    }, {
      name: 'attach',
      description: 'Attach an image file to the next message',
      argumentHint: '<path>',
      handler: async (argument) => {
        if (argument.trim() === '') throw new Error('Usage: /attach <path>')
        this.ensureVisionAvailable()
        if (this.imageSubmissionBusy) throw new Error('Vision analysis is already in progress.')
        this.attachmentDrafts.add(await imageDraftFromPath(argument.trim(), this.controller.current.cwd))
      },
    }, {
      name: 'paste-image',
      description: 'Attach the image currently on the clipboard',
      handler: () => this.pasteImage(),
    }, {
      name: 'details',
      description: 'Toggle expanded tool output',
      handler: () => { this.setDetailsExpanded(!this.showDetails) },
    }, {
      name: 'skills',
      description: 'Browse and author reusable Skills',
      handler: () => { this.openSkills() },
    }, {
      name: 'config',
      description: 'Configure model, policy, and terminal preferences',
      argumentHint: '[model|reasoning|permission|plan|vision|keybindings|interface]',
      handler: argument => this.openConfigRoute(argument),
    }, {
      name: 'keymap',
      description: 'Configure persistent terminal keybindings',
      handler: () => { this.openKeymap() },
    }, {
      name: 'vision',
      description: 'Configure image routing and the Vision proxy',
      handler: () => this.openVisionConfig(),
    }, {
      name: 'task',
      description: 'Inspect and control the current task',
      handler: () => { this.openTask() },
    }, {
      name: 'trajectory',
      aliases: ['trace'],
      description: 'Inspect the session execution chain',
      handler: () => { this.openTrajectory() },
    }, {
      name: 'status',
      description: 'Show current session status',
      handler: () => {
        const state = this.controller.current
        this.controller.notice([
          `Session: ${state.sessionId === undefined ? 'none' : String(state.sessionId)}`,
          `Directory: ${state.cwd}`,
          `State: ${state.running ? 'running' : 'idle'}`,
          `Stream: ${state.connected ? 'connected' : 'reconnecting'}`,
          `Queued: ${state.queue.length}`,
        ].join('\n'))
      },
    }, {
      name: 'memories',
      aliases: ['memory'],
      description: 'Manage project memory and session learning',
      handler: () => this.openMemoryDialog(),
    }, {
      name: 'rewind',
      description: 'Open workspace and conversation checkpoints',
      handler: () => { this.requestRewind() },
    }, {
      name: 'exit',
      aliases: ['quit'],
      description: 'Exit the terminal client',
      handler: () => this.requestExit(0),
    }]
  }

  private ensureVisionAvailable(): void {
    if (this.attachmentCoordinator === undefined) throw new Error('Vision is unavailable in this profile.')
  }

  private get imageSubmissionBusy(): boolean {
    return this.attachmentCoordinator?.busy === true
  }

  private async loadInitialImages(): Promise<void> {
    if (this.initialImagePaths.length === 0) return
    this.ensureVisionAvailable()
    const drafts = await Promise.all(this.initialImagePaths.map(path => (
      imageDraftFromPath(path, this.controller.current.cwd)
    )))
    for (const draft of drafts) this.attachmentDrafts.add(draft)
  }

  private leaveAttachmentRail(): void {
    if (!this.attachmentRailFocused) return
    this.attachmentRailFocused = false
    this.tui.setFocus(this.editor)
    this.tui.requestRender()
  }

  private async pasteImage(): Promise<void> {
    if (this.clipboardPastePending) return
    this.ensureVisionAvailable()
    if (this.imageSubmissionBusy) throw new Error('Vision analysis is already in progress.')
    this.clipboardPastePending = true
    try {
      this.attachmentDrafts.add(await this.clipboardImage())
    } finally {
      this.clipboardPastePending = false
    }
  }

  private refreshAutocomplete(cwd = this.controller.current.cwd, requestRender = true): void {
    if (this.disposed) return
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(
      slashAutocompleteRows(this.slashCandidates()),
      cwd,
    ))
    this.autocompleteCwd = cwd
    if (requestRender) this.tui.requestRender()
  }

  private slashCandidates() {
    return mergeSlashCatalog(
      this.commands.descriptors,
      this.skillCatalog.current.entries,
      this.commands.resolutionNames,
    )
  }

  private handleSkillCatalogChange(snapshot: Readonly<SkillCatalogSnapshot>): void {
    if (this.disposed) return
    this.skillsView?.setSnapshot(snapshot)
    this.refreshAutocomplete(this.controller.current.cwd, false)
    this.tui.requestRender()
  }

  private requestRewind(): void {
    this.disarmRewind()
    void this.runAction(() => this.openRewind())
  }

  private openTrajectory(): void {
    if (this.tui.hasOverlay() || this.composerModalActive) return
    const close = (): void => {
      if (this.trajectoryView === undefined) return
      this.trajectoryView = undefined
      this.layout.setComposerOverride(undefined)
      this.composerModalActive = false
      this.tui.setFocus(this.editor)
      this.tui.requestRender()
    }
    const trajectory = new TrajectoryView(
      this.controller.current,
      () => this.terminal.rows,
      this.theme,
      () => this.controller.loadEarlierHistory(),
      () => { void this.runAction(() => this.controller.cancel()) },
      close,
      () => this.tui.requestRender(),
    )
    this.trajectoryView = trajectory
    this.composerModalActive = true
    this.layout.setComposerOverride(trajectory)
    this.tui.setFocus(trajectory)
    this.tui.requestRender()
  }

  private openPermissionConfig(): void {
    const state = this.controller.current
    const permissions = this.configurationSnapshot(state).permissions
    if (permissions === undefined) {
      this.controller.notice('Permission configuration is unavailable in this profile.')
      return
    }
    this.openConfig('permissions')
  }

  private openConfigRoute(argument: string): void | Promise<void> {
    const route = argument.trim().toLowerCase()
    if (route === '') return this.openConfig()
    if (route === 'model') return this.openModelSelector()
    if (route === 'reasoning' || route === 'effort') return this.openConfig('reasoning')
    if (route === 'permission' || route === 'permissions') return this.openPermissionConfig()
    if (route === 'plan') return this.openConfig('plan')
    if (route === 'vision') return this.openVisionConfig()
    if (route === 'keymap' || route === 'keybinding' || route === 'keybindings') return this.openKeymap()
    if (route === 'interface' || route === 'details') return this.openConfig()
    throw new Error(`Unknown config section "${sanitizeTerminalText(argument.trim())}". Use model, reasoning, permission, plan, vision, keybindings, or interface.`)
  }

  private openConfig(initialStage: ConfigEntryStage = 'root'): void {
    if (this.tui.hasOverlay() || this.composerModalActive) return
    const close = (): void => {
      if (this.configView === undefined) return
      this.configView = undefined
      this.layout.setComposerOverride(undefined)
      this.composerModalActive = false
      this.tui.setFocus(this.editor)
      this.tui.requestRender()
    }
    const state = this.controller.current
    const view = new ConfigView(
      this.configurationSnapshot(state),
      this.theme,
      () => {
        close()
        void this.runAction(() => this.openModelSelector())
      },
      effort => { void this.runAction(() => this.selectReasoningEffort(effort)) },
      (value) => {
        if (initialStage === 'permissions') close()
        void this.runAction(() => this.commands.dispatchHost(`/permission ${value}`))
      },
      active => { void this.runAction(() => this.commands.dispatchHost(active ? '/plan' : '/plan off')) },
      expanded => { this.setDetailsExpanded(expanded) },
      close,
      initialStage,
      () => {
        close()
        void this.runAction(() => this.openVisionConfig())
      },
      () => {
        close()
        this.openKeymap()
      },
    )
    this.configView = view
    this.composerModalActive = true
    this.layout.setComposerOverride(view)
    this.tui.setFocus(view)
    this.tui.requestRender()
    if ((initialStage === 'root' || initialStage === 'reasoning')
      && state.models === undefined
      && state.sessionId !== undefined) {
      void this.runAction(async () => { await this.controller.refreshModels() })
    }
  }

  private async openVisionConfig(): Promise<void> {
    if (this.tui.hasOverlay() || this.composerModalActive) return
    const vision = this.vision
    if (vision === undefined) throw new Error('Vision is unavailable in this profile.')
    const status = await this.refreshVisionStatus()
    if (this.tui.hasOverlay() || this.composerModalActive || this.disposed) return
    const close = (): void => {
      if (this.visionConfigView === undefined) return
      this.visionConfigView = undefined
      this.layout.setComposerOverride(undefined)
      this.composerModalActive = false
      this.tui.setFocus(this.editor)
      this.tui.requestRender()
    }
    const view = new VisionConfigView(
      status,
      this.theme,
      mode => {
        void this.runAction(async () => {
          await vision.setMode(mode)
          await this.refreshVisionStatus()
        })
      },
      () => {
        void this.runAction(async () => {
          await vision.configureRecommendedDashScope()
          await this.refreshVisionStatus()
          this.controller.notice('Configured dashscope-vision/qwen3.7-plus using DASHSCOPE_API_KEY.')
        })
      },
      close,
    )
    this.visionConfigView = view
    this.composerModalActive = true
    this.layout.setComposerOverride(view)
    this.tui.setFocus(view)
    this.tui.requestRender()
  }

  private openKeymap(): void {
    if (this.tui.hasOverlay() || this.composerModalActive) return
    const close = (): void => {
      if (this.keymapView === undefined) return
      this.keymapView = undefined
      this.layout.setComposerOverride(undefined)
      this.composerModalActive = false
      this.tui.setFocus(this.editor)
      this.tui.requestRender()
    }
    const view = new KeymapView(
      this.keymap.current().keymap,
      this.theme,
      preset => {
        void this.runAction(async () => {
          await this.keymap.setPreset(preset)
          this.controller.notice(`Keybindings changed to ${preset}.`)
        })
      },
      close,
    )
    this.keymapView = view
    this.composerModalActive = true
    this.layout.setComposerOverride(view)
    this.tui.setFocus(view)
    this.tui.requestRender()
  }

  private async refreshVisionStatus(): Promise<VisionStatus> {
    const vision = this.vision
    if (vision === undefined) throw new Error('Vision is unavailable in this profile.')
    const status = await vision.status()
    this.visionStatus = status
    this.visionConfigView?.setStatus(status)
    this.refreshConfigurationSurface()
    this.tui.requestRender()
    return status
  }

  private openTask(): void {
    if (this.tui.hasOverlay() || this.composerModalActive) return
    const close = (): void => {
      if (this.taskView === undefined) return
      this.taskView = undefined
      this.layout.setComposerOverride(undefined)
      this.composerModalActive = false
      this.tui.setFocus(this.editor)
      this.tui.requestRender()
    }
    const state = this.controller.current
    const view = new TaskView(
      taskSnapshot(state.projections, state.running, state.queue.length),
      this.theme,
      () => this.terminal.rows,
      action => { this.handleGoalAction(action) },
      () => { void this.runAction(() => this.controller.cancel()) },
      close,
    )
    this.taskView = view
    this.composerModalActive = true
    this.layout.setComposerOverride(view)
    this.tui.setFocus(view)
    this.tui.requestRender()
  }

  private openSkills(): void {
    if (this.tui.hasOverlay() || this.composerModalActive) return
    const close = (): void => {
      if (this.skillsView === undefined) return
      this.skillsView = undefined
      this.layout.setComposerOverride(undefined)
      this.composerModalActive = false
      this.tui.setFocus(this.editor)
      this.tui.requestRender()
    }
    const view = new SkillsView(
      this.skillCatalog.current,
      this.theme,
      () => this.terminal.rows,
      (name) => {
        close()
        this.editor.setText(`/${name} `)
      },
      query => this.openSkillSearch(query),
      () => { this.beginSkillCreation() },
      name => { void this.runAction(() => this.skillAuthoring.edit(this.controller.current.cwd, name)) },
      () => { void this.skillCatalog.refresh(true) },
      close,
    )
    this.skillsView = view
    this.composerModalActive = true
    this.layout.setComposerOverride(view)
    this.tui.setFocus(view)
    this.tui.requestRender()
    void this.skillCatalog.refresh()
  }

  private openSkillSearch(initial: string): void {
    let handle: OverlayHandle
    const close = (): void => { handle.hide() }
    const dialog = new TextInputDialog(
      this.tui,
      'Filter Skills',
      this.theme,
      (query) => {
        close()
        this.skillsView?.setQuery(query)
        this.tui.requestRender()
      },
      close,
      initial,
    )
    handle = this.tui.showOverlay(dialog, { width: '80%', maxHeight: '60%', margin: 1 })
  }

  private beginSkillCreation(): void {
    void this.runAction(async () => {
      const targets = await this.skillAuthoring.targets(this.controller.current.cwd)
      new SkillAuthoringWizard(
        this.tui,
        this.theme,
        targets,
        (name) => {
          if (this.commands.has(name)) {
            return `/${name} is already a Command or alias and would shadow the Skill. Choose another name.`
          }
          const collision = this.slashCandidates().find(candidate => candidate.name === name)
          if (collision === undefined) return undefined
          return `/${name} is already an effective Skill. Use e in /skills to edit a local definition.`
        },
        request => { void this.runAction(() => this.skillAuthoring.create(request)) },
        message => this.controller.notice(message),
      ).start()
    })
  }

  private async openSkillDocument(document: LocalSkillDocument, created: boolean): Promise<void> {
    const editor = externalEditorCommand()
    if (editor === undefined) {
      const abort = new AbortController()
      try {
        await this.controller.openPath(document.path, abort.signal)
        this.controller.notice(`${created ? 'Created' : 'Opened'} /${document.name} at ${document.path}`)
      } catch (error: unknown) {
        throw new Error([
          `${created ? 'Created' : 'Edit'} /${document.name} at:`,
          document.path,
          `No terminal editor is configured and the Host opener failed: ${error instanceof Error ? error.message : String(error)}`,
        ].join('\n'))
      }
      return
    }

    this.terminal.write(DISABLE_MOUSE_TRACKING)
    this.tui.stop()
    try {
      await runExternalEditor(editor, document.path, [
        this.runtime.stdin,
        this.runtime.stdout,
        this.runtime.stderr,
      ])
    } finally {
      await this.terminal.drainInput(100, 20)
      if (!this.disposed) {
        this.tui.start()
        this.terminal.write(ENABLE_MOUSE_TRACKING)
        this.tui.requestRender()
      }
    }
  }

  private handleGoalAction(action: GoalAction): void {
    const state = this.controller.current
    const projection = taskSnapshot(state.projections, state.running, state.queue.length).goal
    if (action === 'create') {
      this.openGoalObjectiveInput('Create Goal', '', async (objective) => {
        this.openGoalRoundInput(
          'Goal round limit (blank uses profile default)',
          '',
          rounds => this.controller.createGoal(objective, rounds),
          true,
        )
      })
      return
    }
    if (projection === undefined || projection === null) {
      this.controller.notice('The current Goal changed; reopen /task and try again.')
      return
    }
    if (action === 'edit') {
      this.openGoalObjectiveInput(
        'Edit Goal',
        projection.goal.objective,
        objective => this.controller.editGoal(projection.goal, objective),
      )
      return
    }
    if (action === 'rounds') {
      this.openGoalRoundInput(
        'Edit Goal round limit',
        String(projection.goal.maxGoalRounds),
        rounds => this.controller.editGoal(projection.goal, undefined, rounds),
        false,
      )
      return
    }
    const mutation = action === 'pause'
      ? () => this.controller.pauseGoal(projection.goal)
      : action === 'resume'
        ? () => this.controller.resumeGoal(projection.goal)
        : action === 'complete'
          ? () => this.controller.completeGoal(projection.goal)
          : () => this.controller.clearGoal(projection.goal)
    void this.runAction(async () => { await mutation() })
  }

  private openGoalObjectiveInput(
    title: string,
    initial: string,
    submit: (objective: string) => Promise<unknown>,
  ): void {
    let handle: OverlayHandle
    const close = (): void => { handle.hide() }
    const dialog = new TextInputDialog(
      this.tui,
      title,
      this.theme,
      (objective) => {
        if (objective.trim() === '') return
        close()
        void this.runAction(async () => { await submit(objective.trim()) })
      },
      close,
      initial,
    )
    handle = this.tui.showOverlay(dialog, { width: '85%', maxHeight: '70%', margin: 1 })
  }

  private openGoalRoundInput(
    title: string,
    initial: string,
    submit: (rounds: number | undefined) => Promise<unknown>,
    optional: boolean,
  ): void {
    let handle: OverlayHandle
    const close = (): void => { handle.hide() }
    const dialog = new TextInputDialog(
      this.tui,
      title,
      this.theme,
      (value) => {
        const normalized = value.trim()
        const rounds = normalized === '' && optional ? undefined : Number(normalized)
        close()
        void this.runAction(async () => {
          if (rounds !== undefined && (!Number.isSafeInteger(rounds) || rounds <= 0)) {
            throw new Error('Goal round limit must be a positive integer')
          }
          await submit(rounds)
        })
      },
      close,
      initial,
    )
    handle = this.tui.showOverlay(dialog, { width: '75%', maxHeight: '60%', margin: 1 })
  }

  private async openRewind(): Promise<void> {
    if (this.tui.hasOverlay() || this.composerModalActive) return
    const sessionId = this.controller.current.sessionId
    if (sessionId === undefined) throw new Error('no terminal session is active')
    const surfaceGeneration = ++this.rewindSurfaceGeneration
    this.rewindSummaries = this.checkpoints.list(String(sessionId))
    this.showRewindCheckpointList()
    void this.checkpoints.describe(String(sessionId)).then(summaries => {
      if (surfaceGeneration !== this.rewindSurfaceGeneration
        || this.controller.current.sessionId !== sessionId
        || this.rewindSummaries === undefined) return
      this.rewindSummaries = summaries
      this.rewindCheckpointDialog?.setSummaries(summaries)
      this.tui.requestRender()
    }).catch((error: unknown) => {
      if (surfaceGeneration !== this.rewindSurfaceGeneration) return
      this.rewindCheckpointDialog?.setInspectionError(error instanceof Error ? error.message : String(error))
      this.tui.requestRender()
    })
  }

  private showRewindCheckpointList(selectedCheckpointId?: string): void {
    const summaries = this.rewindSummaries
    if (summaries === undefined) return
    const dialog = new RewindCheckpointDialog(
      summaries,
      selectedCheckpointId,
      () => this.terminal.rows,
      this.theme,
      summary => { void this.openRewindPreview(summary) },
      () => this.closeRewindSurface(),
    )
    this.rewindCheckpointDialog = dialog
    this.rewindProgress = undefined
    this.composerModalActive = true
    this.layout.setComposerOverride(dialog)
    this.tui.setFocus(dialog)
    this.tui.requestRender()
  }

  private async openRewindPreview(summary: RewindCheckpointSummary): Promise<void> {
    const sessionId = this.controller.current.sessionId
    if (sessionId === undefined || String(sessionId) !== summary.sessionId) {
      this.closeRewindSurface()
      this.controller.notice('The active session changed before the checkpoint could be inspected.')
      return
    }
    this.showRewindProgress('Preparing selected checkpoint…')
    let preview: RewindPreview
    try {
      preview = await this.checkpoints.preview(String(sessionId), summary.checkpointId)
    } catch (error: unknown) {
      this.closeRewindSurface()
      this.controller.notice(error instanceof Error ? error.message : String(error))
      return
    }
    const dialog = new RewindDialog(
      preview,
      this.theme,
      () => {
        this.showRewindProgress('Restoring workspace checkpoint…')
        void this.performRewind(preview)
      },
      () => this.showRewindCheckpointList(summary.checkpointId),
    )
    this.rewindCheckpointDialog = undefined
    this.layout.setComposerOverride(dialog)
    this.tui.setFocus(dialog)
    this.tui.requestRender()
  }

  private async performRewind(preview: RewindPreview): Promise<void> {
    try {
      const rollback = await this.checkpoints.restore(preview)
      const revertedMemories: MemoryMutation[] = []
      let targetSessionId: string
      try {
        for (const mutation of [...preview.memoryMutations ?? []].reverse()) {
          await this.memory.restore(mutation, 'before')
          revertedMemories.push(mutation)
        }
        targetSessionId = String(await this.controller.rewind(preview, phase => {
          this.showRewindProgress(phase === 'forking'
            ? 'Rewinding conversation…'
            : 'Reloading rewound session…')
        }))
      } catch (error: unknown) {
        this.showRewindProgress('Rewind failed; restoring the current workspace and memory…')
        const rollbackFailures: unknown[] = []
        for (const mutation of [...revertedMemories].reverse()) {
          try {
            await this.memory.restore(mutation, 'after')
          } catch (rollbackError: unknown) {
            rollbackFailures.push(rollbackError)
          }
        }
        try {
          await rollback()
        } catch (rollbackError: unknown) {
          rollbackFailures.push(rollbackError)
        }
        if (rollbackFailures.length > 0) {
          throw new Error(`rewind failed (${String(error)}) and rollback also failed (${rollbackFailures.map(String).join('; ')})`)
        }
        throw error
      }
      this.checkpoints.continueFrom(preview, targetSessionId)
      this.editor.setText(preview.prompt)
    } catch (error: unknown) {
      this.controller.notice(error instanceof Error ? error.message : String(error))
    } finally {
      this.closeRewindSurface()
    }
  }

  private showRewindProgress(message: string): void {
    if (this.rewindProgress === undefined) {
      this.rewindProgress = new Text('', 1, 0)
    }
    this.composerModalActive = true
    this.rewindCheckpointDialog = undefined
    this.layout.setComposerOverride(this.rewindProgress)
    this.tui.setFocus(null)
    this.rewindProgress.setText([
      this.theme.bold('Rewind'),
      this.theme.accent(`✦ ${message}`),
      this.theme.dim('Workspace, memory, and conversation rollback are applied as one operation.'),
    ].join('\n'))
    this.tui.requestRender()
  }

  private closeRewindSurface(): void {
    this.rewindSurfaceGeneration += 1
    this.layout.setComposerOverride(undefined)
    this.rewindProgress = undefined
    this.rewindSummaries = undefined
    this.rewindCheckpointDialog = undefined
    this.composerModalActive = false
    this.tui.setFocus(this.editor)
    this.tui.requestRender()
  }

  private armRewind(now: number): void {
    if (this.rewindArmTimer !== undefined) clearTimeout(this.rewindArmTimer)
    this.lastEscapeAt = now
    this.updateStatus(this.controller.current)
    this.tui.requestRender()
    this.rewindArmTimer = setTimeout(() => {
      this.rewindArmTimer = undefined
      this.lastEscapeAt = 0
      if (this.disposed) return
      this.updateStatus(this.controller.current)
      this.tui.requestRender()
    }, DOUBLE_ESCAPE_MS)
  }

  private disarmRewind(): void {
    if (this.rewindArmTimer !== undefined) clearTimeout(this.rewindArmTimer)
    this.rewindArmTimer = undefined
    if (this.lastEscapeAt === 0) return
    this.lastEscapeAt = 0
    if (this.disposed) return
    this.updateStatus(this.controller.current)
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
        void this.runAction(() => this.selectModel(selected))
      },
      close,
    )
    this.composerModalActive = true
    this.layout.setComposerOverride(dialog)
    this.tui.setFocus(dialog)
    this.tui.requestRender()
  }

  private async openMemoryDialog(): Promise<void> {
    if (this.tui.hasOverlay() || this.composerModalActive) return
    const state = this.controller.current
    if (state.sessionId === undefined) throw new Error('no terminal session is active')
    const sessionId = String(state.sessionId)
    const overview = await this.memory.overview(state.cwd, sessionId)
    const close = (): void => {
      this.layout.setComposerOverride(undefined)
      this.composerModalActive = false
      this.tui.setFocus(this.editor)
      this.tui.requestRender()
    }
    const dialog = new MemoryDialog(
      overview,
      () => this.terminal.rows,
      this.theme,
      policy => { this.memory.setPolicy(sessionId, policy) },
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
    await this.selectModel(matches[0] as ModelSelection)
  }

  private async selectModel(selection: ModelSelection): Promise<void> {
    if (this.imageSubmissionBusy) throw new Error('Wait for Vision analysis to finish before changing models.')
    while (this.controller.current.historyHasMore) {
      if (!await this.controller.loadEarlierHistory()) break
    }
    const containsImages = this.controller.current.events.some(entry => entry.event.type === 'user/message'
      && entry.event.data.source.kind === 'user'
      && entry.event.data.content.some(block => block.type === 'image'))
    if (containsImages && this.vision !== undefined
      && !await this.vision.supportsNativeImages(selection.provider, selection.model)) {
      throw new Error('This session already contains native image messages. Select a multimodal model or start a new session before switching to a text-only model.')
    }
    await this.controller.selectModel(selection)
  }

  private setDetailsExpanded(expanded: boolean): void {
    this.showDetails = expanded
    this.transcript.setDetails(expanded)
    this.refreshConfigurationSurface()
    this.tui.requestRender()
  }

  private configurationSnapshot(state: Readonly<TuiState> = this.controller.current) {
    return configurationSnapshot(
      state.models,
      state.projections,
      this.showDetails,
      this.visionStatus,
      this.keymap.current().keymap,
    )
  }

  private refreshConfigurationSurface(): void {
    this.configView?.setSnapshot(this.configurationSnapshot())
  }

  private async selectReasoningEffort(reasoningEffort: string | undefined): Promise<void> {
    const models = this.controller.current.models ?? await this.controller.refreshModels()
    const current = models.current
    await this.controller.selectModel({
      provider: current.provider,
      model: current.model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    })
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
    await this.selectReasoningEffort(next)
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
    const hint = code === 0 ? resumeHint(this.controller.current.sessionId) : undefined
    await this.dispose()
    if (hint !== undefined) this.runtime.stdout.write(hint)
    this.runtime.exit(code)
  }
}

import {
  Editor,
  Key,
  ProcessTerminal,
  Text,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  type OverlayHandle,
  type Terminal,
} from '@earendil-works/pi-tui'
import type {
  IApiClient,
  ModelSelection,
  SessionSummary,
} from '@deepseek-ai/dsh-host-apiproxy'
import type {
  MemoryActivity,
  MemoryOverview,
  MemorySessionPolicy,
} from '@vascent/deepseek-harness-memory'
import type { ResolvedConfig } from './config.ts'
import {
  HarnessController,
  type ApprovalPrompt,
  type InteractionResolution,
  type QuestionPrompt,
  type TuiControllerSink,
  type TuiState,
} from '../runtime/controller.ts'
import {
  ApprovalDialog,
  ChoiceDialog,
  MemoryDialog,
  ModelDialog,
  MultiSelectDialog,
  TextInputDialog,
} from '../presentation/dialogs.ts'
import { RewindDialog, RewindPointDialog } from '../presentation/rewind/index.ts'
import { sanitizeTerminalText } from '../text.ts'
import { createTheme, type TuiTheme } from '../presentation/theme.ts'
import { composerStats } from '../presentation/stats.ts'
import { DiffLineLocator } from '../presentation/diff-location.ts'
import { TranscriptComponent } from '../presentation/transcript.ts'
import { ComposerAnchoredLayout } from '../presentation/layout.ts'
import { SelectableMainScreen } from '../presentation/selectable-main-screen.ts'
import { TrajectoryView } from '../trajectory/view.ts'
import {
  RewindTransaction,
  type RewindAction,
  type RewindPlan,
  type RewindPointSummary,
  type RewindPort,
} from '../rewind/index.ts'
import {
  parseMouseReport,
  resolveMouseAction,
  type MouseAction,
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
import {
  AttachmentDraftStore,
  type AttachmentDraft,
} from './attachments/drafts.ts'
import {
  preparePromptDraft,
  type PromptAttachmentReader,
} from './attachments/restore.ts'
import { imageDraftFromPath } from './attachments/files.ts'
import {
  imageDraftFromClipboard,
  type ClipboardImageLoader,
} from './attachments/clipboard.ts'
import {
  AttachmentCoordinator,
  type VisionGateway,
} from './attachments/coordinator.ts'
import { AttachmentRail } from '../presentation/attachments.ts'
import { ComposerEditorFrame } from '../presentation/composer-editor.ts'
import { ComposerFooter } from '../presentation/footer.ts'
import { VisionConfigView } from '../presentation/config/vision-view.ts'
import type { VisionStatus } from '@vascent/deepseek-harness-vision'
import type { CommunityWebStatus } from '@vascent/deepseek-harness-web'
import { WebConfigView } from '../presentation/config/web-view.ts'
import { KeymapView } from '../presentation/config/keymap-view.ts'
import {
  memoryKeymapGateway,
  type KeymapSettingsGateway,
} from './keymap-settings.ts'
import {
  resolveKeymapInput,
  type KeymapAction,
} from '../input/keymap.ts'
import { composerExecutionActivity } from '../presentation/composer-activity.ts'
import { formatExecutionDuration } from '../presentation/execution-style.ts'
import {
  ComposerInputController,
  REWIND_ESCAPE_WINDOW_MS,
  type ComposerDraft,
  type ComposerInputAction,
} from './composer-input.ts'
import {
  createClipboardTextWriter,
  type ClipboardTextWriter,
} from './text-clipboard.ts'
import {
  ComposerAutocompleteProvider,
  listWorkspacePaths,
  type WorkspacePathSource,
} from './autocomplete.ts'
import type { TuiStartupOptions } from './cli.ts'
import {
  watchGitBranch,
  type GitBranchSource,
} from './git-branch.ts'

function isWorking(state: Readonly<TuiState>): boolean {
  return composerExecutionActivity(state) !== undefined
}

interface QueuedInteraction {
  key: string
  open(): void
}

interface ActiveInteraction extends QueuedInteraction {
  close: (() => void) | undefined
  phase: 'open' | 'responding' | 'cancelling'
}

function approvalInteractionKey(
  sessionId: ApprovalPrompt['sessionId'],
  approvalId: ApprovalPrompt['approvalId'],
): string {
  return `approval:${String(sessionId)}:${String(approvalId)}`
}

function questionInteractionKey(sessionId: QuestionPrompt['sessionId'], rpcId: QuestionPrompt['rpcId']): string {
  return `question:${String(sessionId)}:${String(rpcId)}`
}

/** Launcher-owned exit function used instead of calling process.exit from raw mode. */
export interface TuiRuntime {
  exit(code: number): void
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  stderr: NodeJS.WriteStream
}

/** Memory capabilities used by the terminal application outside Rewind. */
export interface TuiMemoryPort {
  onActivity(listener: (activity: MemoryActivity) => void): () => void
  overview(cwd: string, sessionId?: string): Promise<MemoryOverview>
  setPolicy(sessionId: string, patch: Partial<MemorySessionPolicy>): MemorySessionPolicy
}

/** Secret-free Web capability status used by the terminal configuration surface. */
export interface WebGateway {
  status(signal?: AbortSignal): Promise<CommunityWebStatus>
}

/** Optional composition ports kept separate from the stable application core. */
export interface TuiApplicationDependencies {
  commandSource?: HostCommandSource
  vision?: VisionGateway
  web?: WebGateway
  keymap?: KeymapSettingsGateway
  startup?: TuiStartupOptions
  clipboardImage?: ClipboardImageLoader
  clipboardText?: ClipboardTextWriter
  attachments?: PromptAttachmentReader
  workspacePaths?: WorkspacePathSource
  gitBranch?: GitBranchSource
  terminal?: Terminal
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
  return `\nResume this session with:\n  dsh-tui resume ${shellArgument(String(sessionId))}\n\n`
}

/** Main-screen pi-tui application for one in-process Harness API client. */
export class TuiApplication implements TuiControllerSink {
  private readonly terminal: Terminal
  private readonly tui: SelectableMainScreen
  private readonly theme: TuiTheme
  private readonly controller: HarnessController
  private readonly header: Text
  private readonly status = new Text('', 0, 0)
  private readonly footer: ComposerFooter
  private readonly editor: Editor
  private readonly transcript: TranscriptComponent
  private readonly attachmentRail: AttachmentRail
  private readonly composerEditor: ComposerEditorFrame
  private readonly attachmentDrafts = new AttachmentDraftStore()
  private readonly attachmentCoordinator: AttachmentCoordinator | undefined
  private readonly vision: VisionGateway | undefined
  private readonly diffLineLocator = new DiffLineLocator()
  private readonly layout: ComposerAnchoredLayout
  private trajectoryView: TrajectoryView | undefined
  private configView: ConfigView | undefined
  private visionConfigView: VisionConfigView | undefined
  private webConfigView: WebConfigView | undefined
  private keymapView: KeymapView | undefined
  private taskView: TaskView | undefined
  private skillsView: SkillsView | undefined
  private removeInputListener?: () => void
  private spinner: ReturnType<typeof setInterval> | undefined
  private spinnerFrame = 0
  private workingStartedAt: number | undefined
  private workingActivityKey: string | undefined
  private showDetails = false
  private readonly composerInput = new ComposerInputController<AttachmentDraft>()
  private rewindArmTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private exiting = false
  private interruptingActivityKey: string | undefined
  private activeInteraction: ActiveInteraction | undefined
  private composerModalActive = false
  private rewindProgress: Text | undefined
  private rewindSummaries: RewindPointSummary[] | undefined
  private rewindPointDialog: RewindPointDialog | undefined
  private memoryActivity: MemoryActivity = { state: 'idle' }
  private readonly removeMemoryActivity: () => void
  private readonly interactionQueue: QueuedInteraction[] = []
  private readonly commands: TerminalCommandDirectory
  private readonly skillCatalog: SkillCatalog
  private readonly skillAuthoring: SkillAuthoringCoordinator
  private autocompleteCwd: string
  private renderedSessionId: TuiState['sessionId'] = undefined
  private readonly removeAttachmentListener: () => void
  private readonly keymap: KeymapSettingsGateway
  private readonly removeKeymapListener: () => void
  private visionStatus: VisionStatus | undefined
  private webStatus: CommunityWebStatus | undefined
  private readonly web: WebGateway | undefined
  private attachmentRailFocused = false
  private readonly startup: TuiStartupOptions
  private readonly clipboardImage: ClipboardImageLoader
  private readonly clipboardText: ClipboardTextWriter
  private readonly promptAttachmentReader: PromptAttachmentReader | undefined
  private readonly workspacePaths: WorkspacePathSource
  private readonly gitBranchSource: GitBranchSource
  private gitBranchCwd: string | undefined
  private gitBranch: string | undefined
  private removeGitBranchListener: (() => void) | undefined
  private clipboardPastePending = false
  private readonly rewindTransaction: RewindTransaction

  constructor(
    api: IApiClient,
    private readonly config: ResolvedConfig,
    private readonly runtime: TuiRuntime,
    rewind: RewindPort,
    private readonly memory: TuiMemoryPort,
    dependencies: TuiApplicationDependencies = {},
  ) {
    const {
      commandSource,
      vision,
      web,
      keymap,
      startup = { imagePaths: [], plan: false },
      clipboardImage = imageDraftFromClipboard,
      clipboardText,
      attachments,
      workspacePaths = listWorkspacePaths,
      gitBranch = watchGitBranch,
      terminal = new ProcessTerminal(),
    } = dependencies
    this.terminal = terminal
    this.startup = startup
    this.clipboardImage = clipboardImage
    this.clipboardText = clipboardText ?? createClipboardTextWriter(terminal)
    this.promptAttachmentReader = attachments
    this.workspacePaths = workspacePaths
    this.gitBranchSource = gitBranch
    this.theme = createTheme(config.color)
    this.footer = new ComposerFooter(this.theme)
    this.tui = new SelectableMainScreen(this.terminal, config.showHardwareCursor)
    this.controller = new HarnessController(api, this, config.cwd, config.historyMessages)
    this.rewindTransaction = new RewindTransaction(rewind, {
      rewind: async (plan, onPhase) => String(await this.controller.rewind(plan, onPhase)),
    })
    const initial = this.controller.current
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
    this.web = web
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
    this.composerEditor = new ComposerEditorFrame(this.editor, this.theme)
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
    this.editor.setAutocompleteProvider(this.createAutocompleteProvider(config.cwd))
    this.autocompleteCwd = config.cwd
    this.editor.onChange = text => {
      if (!this.composerInput.observeEditorText(text) || this.disposed) return
      this.updateStatus(this.controller.current)
      this.tui.requestRender()
    }
    this.editor.onSubmit = text => {
      this.resetComposerInput()
      this.editor.addToHistory(text)
      void this.submit(text)
    }
    this.layout = new ComposerAnchoredLayout(
      this.header,
      this.transcript,
      this.status,
      this.composerEditor,
      this.footer,
      () => this.terminal.rows,
      this.attachmentRail,
      this.theme.surfaceBorder,
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
      if (this.composerInput.observeAttachments(drafts)) {
        this.updateStatus(this.controller.current)
      }
      this.attachmentRail.setDrafts(drafts)
      this.composerEditor.setDrafts(drafts)
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

  /** Start rendering, bind the requested session, then apply one startup intent. */
  async start(): Promise<void> {
    if (!this.runtime.stdin.isTTY || !this.runtime.stdout.isTTY) {
      throw new Error('deepseek-harness-tui requires an interactive TTY')
    }
    this.terminal.setTitle(this.config.title)
    this.removeInputListener = this.tui.addInputListener(data => this.handleGlobalInput(data))
    this.tui.start()
    await this.controller.start(await this.startupSessionId())
    if (this.startup.model !== undefined) {
      await this.selectNamedModel(this.startup.model, this.startup.reasoningEffort)
    } else if (this.startup.reasoningEffort !== undefined) {
      await this.selectReasoningEffort(this.startup.reasoningEffort)
    }
    if (this.startup.permissionMode !== undefined) {
      await this.commands.dispatchHost(`/permission ${this.startup.permissionMode}`)
    }
    if (this.startup.plan) await this.commands.dispatchHost('/plan')
    await this.loadInitialImages()
    if (this.startup.prompt !== undefined) {
      this.editor.addToHistory(this.startup.prompt)
      await this.submit(this.startup.prompt)
    }
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
    this.removeGitBranchListener?.()
    this.removeGitBranchListener = undefined
    this.attachmentCoordinator?.cancel(false)
    this.removeInputListener?.()
    this.tui.stop()
    await this.terminal.drainInput(250, 30)
  }

  render(state: Readonly<TuiState>): void {
    if (this.disposed) return
    if (this.renderedSessionId !== state.sessionId) {
      this.resetComposerInput(false)
    }
    if (this.renderedSessionId !== undefined && this.renderedSessionId !== state.sessionId) {
      this.attachmentCoordinator?.cancel(false)
      this.attachmentDrafts.clear()
    }
    this.renderedSessionId = state.sessionId
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
    this.reconcileInterruptTarget(state)
    this.updateStatus(state)
    this.observeGitBranch(state.cwd)
    this.updateFooter(state)
    if (state.cwd !== this.autocompleteCwd || commandsChanged) {
      this.refreshAutocomplete(state.cwd, false)
    }
    this.tui.requestRender()
  }

  private observeGitBranch(cwd: string): void {
    if (this.gitBranchCwd === cwd) return
    this.removeGitBranchListener?.()
    this.gitBranchCwd = cwd
    this.gitBranch = undefined
    this.removeGitBranchListener = this.gitBranchSource(cwd, (branch) => {
      if (this.disposed || this.gitBranchCwd !== cwd || this.gitBranch === branch) return
      this.gitBranch = branch
      this.updateFooter(this.controller.current)
      this.tui.requestRender()
    })
  }

  private updateFooter(state: Readonly<TuiState>): void {
    const selection = state.models?.current
    const model = selection === undefined
      ? 'model unavailable'
      : `${selection.provider}/${selection.model}${selection.reasoningEffort === undefined ? '' : ` · ${selection.reasoningEffort}`}`
    this.footer.setSnapshot({
      model,
      cwd: state.cwd,
      ...this.gitBranchCwd === state.cwd && this.gitBranch !== undefined
        ? { branch: this.gitBranch }
        : {},
      stats: composerStats(state.projections),
    })
  }

  requestApproval(prompt: ApprovalPrompt): void {
    const key = approvalInteractionKey(prompt.sessionId, prompt.approvalId)
    this.enqueueInteraction({ key, open: () => this.showApproval(prompt) })
  }

  requestQuestions(prompt: QuestionPrompt): void {
    const key = questionInteractionKey(prompt.sessionId, prompt.rpcId)
    this.enqueueInteraction({ key, open: () => this.showQuestion(prompt, 0, []) })
  }

  resolveInteraction(resolution: InteractionResolution): void {
    const key = resolution.type === 'approval/resolved'
      ? approvalInteractionKey(resolution.sessionId, resolution.approvalId)
      : questionInteractionKey(resolution.sessionId, resolution.questionRpcId)
    this.completeInteraction(key)
  }

  private updateStatus(state: Readonly<TuiState>): void {
    const history = this.layout.followsTranscriptTail ? '' : ' · Viewing history · PageDown to follow'
    const task = sessionControlSummary(state.projections)
    const taskStatus = task === '' ? '' : ` · ${task}`
    const activity = composerExecutionActivity(state)
    if (activity !== undefined) {
      if (activity.key !== this.workingActivityKey) {
        const hostHandoff = this.workingActivityKey?.startsWith('submission:') === true
          && activity.key.startsWith('session:')
        this.workingActivityKey = activity.key
        this.workingStartedAt = activity.startedAt
          ?? (hostHandoff ? this.workingStartedAt : undefined)
          ?? Date.now()
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
      const startedAt = activity.startedAt ?? this.workingStartedAt ?? Date.now()
      const elapsed = formatExecutionDuration(Date.now() - startedAt, 'elapsed')
      const label = activity.kind === 'vision'
        ? `Vision · Analyzing ${String(activity.imageCount)} image${activity.imageCount === 1 ? '' : 's'}`
        : 'Working'
      const interruptHint = this.interruptingActivityKey === this.interruptionTargetKey(state)
        ? 'Ctrl+C again to exit'
        : 'esc to interrupt'
      this.status.setText([
        this.theme.accent(glyph),
        this.theme.secondary(` ${label} (${elapsed} · ${interruptHint}${history})`),
      ].join(''))
      return
    }
    this.workingStartedAt = undefined
    this.workingActivityKey = undefined
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
    const composerInput = this.composerInput.snapshot
    if (composerInput.rewindArmed) {
      const recovery = composerInput.draftRecovery === 'stored' ? ' · ↑ to restore draft' : ''
      this.status.setText(this.theme.warning(`Press Esc again to open Rewind history${recovery}${history}`))
      return
    }
    if (this.memoryActivity.state === 'error') {
      this.status.setText(this.theme.warning(`Memory learning failed: ${this.memoryActivity.message}${history}`))
      return
    }
    if (composerInput.draftRecovery === 'stored') {
      this.status.setText(this.theme.secondary(`Input cleared · ↑ to restore${history}`))
      return
    }
    this.status.setText(state.connected
      ? `${this.theme.bold(this.theme.success('Ready'))}${this.theme.secondary(`${taskStatus}${history}`)}`
      : this.theme.warning(`Connecting…${history}`))
  }

  private handleGlobalInput(data: string): { consume?: boolean } | undefined {
    const mouse = parseMouseReport(data)
    if (mouse !== undefined) {
      this.handleMouse(resolveMouseAction(mouse))
      return { consume: true }
    }
    const escape = matchesKey(data, Key.escape)
    const keyRelease = isKeyRelease(data)
    if (!keyRelease && this.tui.clearTextSelection()) this.tui.requestRender()
    if (keyRelease && escape) return { consume: true }
    if (escape && isKeyRepeat(data)) return { consume: true }
    if (escape && this.cancelActiveInteraction()) return { consume: true }
    if (this.activeInteraction !== undefined) {
      if (matchesKey(data, Key.ctrl('c'))) {
        if (!keyRelease && !isKeyRepeat(data)) this.cancelOrExit()
        return { consume: true }
      }
      return undefined
    }
    if (this.composerModalActive) return undefined
    if (this.attachmentRailFocused) {
      if (keyRelease) return undefined
      if (escape || matchesKey(data, Key.ctrl('c'))) {
        this.leaveAttachmentRail()
        return { consume: true }
      }
      return undefined
    }
    if (!escape && !keyRelease) this.disarmRewind()
    const resolution = resolveKeymapInput(data, {
      working: isWorking(this.controller.current),
      hasAttachments: this.attachmentDrafts.snapshot.length > 0,
    }, this.keymap.current().keymap)
    if (resolution.kind !== 'unmatched') {
      if (resolution.kind === 'action') this.handleKeymapAction(resolution.action)
      return { consume: true }
    }
    if (keyRelease) return undefined
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
    const historyDirection = matchesKey(data, Key.up)
      ? 'up'
      : matchesKey(data, Key.down) ? 'down' : undefined
    if (historyDirection !== undefined) {
      const action = this.composerInput.navigateDraft(
        historyDirection,
        this.composerDraft(),
      )
      if (this.applyComposerInputAction(action)) return { consume: true }
    }
    if (escape && !this.tui.hasOverlay()) {
      if (this.imageSubmissionBusy || isWorking(this.controller.current)) {
        this.requestInterrupt()
        return { consume: true }
      }
      if (this.editor.isShowingAutocomplete()) return undefined
      const action = this.composerInput.pressEscape(this.composerDraft(), Date.now())
      this.applyComposerInputAction(action)
      return { consume: true }
    }
    return undefined
  }

  private handleKeymapAction(action: KeymapAction): void {
    switch (action) {
      case 'app.cancel-or-exit':
        this.cancelOrExit()
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

  private handleMouse(mouse: MouseAction): void {
    const blocked = this.composerModalActive || this.tui.hasOverlay()
    const renderState = this.tui.captureRenderState()
    const transcriptLine = this.layout.transcriptRowAt(mouse.y, renderState.previousViewportTop)
    let changed = false
    if (mouse.kind === 'wheel') {
      changed = this.tui.clearTextSelection() || changed
      if (!blocked) changed = this.transcript.handlePointer(transcriptLine, 'move') || changed
      const blockScrolled = blocked
        ? false
        : this.transcript.handlePointer(
            transcriptLine,
            mouse.direction < 0 ? 'wheel-up' : 'wheel-down',
          )
      changed = blockScrolled || changed
      if (!blockScrolled) changed = this.layout.scrollTranscript(mouse.direction * 3) || changed
    } else if (blocked) {
      changed = this.transcript.handlePointer(-1, 'move') || changed
      changed = this.tui.clearTextSelection() || changed
    } else {
      changed = this.transcript.handlePointer(transcriptLine, 'move') || changed
      if (mouse.kind === 'press') {
        changed = this.tui.beginTextSelection(mouse.x, mouse.y) || changed
      } else if (mouse.kind === 'drag') {
        changed = this.tui.updateTextSelection(mouse.x, mouse.y) || changed
      } else if (mouse.kind === 'release') {
        const result = this.tui.finishTextSelection(mouse.x, mouse.y)
        changed = result.changed || changed
        if (result.kind === 'selection') {
          void this.clipboardText(result.text).catch((error: unknown) => {
            this.controller.notice(`Could not copy selection: ${error instanceof Error ? error.message : String(error)}`)
          })
        } else if (result.kind === 'click') {
          changed = this.transcript.handlePointer(transcriptLine, 'click') || changed
        }
      }
    }
    if (changed) {
      this.updateStatus(this.controller.current)
      this.tui.requestRender()
    }
  }

  private async submitEditor(mode: 'queue' | 'steer'): Promise<void> {
    const text = this.editor.getExpandedText()
    if (text.trim() === '' && this.attachmentDrafts.snapshot.length === 0) return
    this.resetComposerInput()
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
      description: 'Toggle all Activity details',
      handler: () => { this.setDetailsExpanded(!this.showDetails) },
    }, {
      name: 'skills',
      description: 'Browse and author reusable Skills',
      handler: () => { this.openSkills() },
    }, {
      name: 'config',
      description: 'Configure model, policy, and terminal preferences',
      argumentHint: '[model|reasoning|permission|plan|vision|web|keybindings|interface]',
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
      name: 'web',
      description: 'Inspect Web search and page-reading providers',
      handler: () => this.openWebConfig(),
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
      description: 'Open source-attributed Rewind history',
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

  private async startupSessionId(): Promise<string | undefined> {
    const target = this.startup.resume
    if (target === undefined) return undefined
    if (target.kind === 'session') return target.sessionId
    const latest = (await this.controller.sessions()).find(session => !session.blank && session.origin !== 'subagent')
    if (latest === undefined) throw new Error('no non-blank root session is available to resume')
    return String(latest.sessionId)
  }

  private async loadInitialImages(): Promise<void> {
    if (this.startup.imagePaths.length === 0) return
    this.ensureVisionAvailable()
    const drafts = await Promise.all(this.startup.imagePaths.map(path => (
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
    this.editor.setAutocompleteProvider(this.createAutocompleteProvider(cwd))
    this.autocompleteCwd = cwd
    if (requestRender) this.tui.requestRender()
  }

  private createAutocompleteProvider(cwd: string): ComposerAutocompleteProvider {
    return new ComposerAutocompleteProvider(
      slashAutocompleteRows(this.slashCandidates()),
      cwd,
      this.workspacePaths,
    )
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
    if (route === 'web') return this.openWebConfig()
    if (route === 'keymap' || route === 'keybinding' || route === 'keybindings') return this.openKeymap()
    if (route === 'interface' || route === 'details') return this.openConfig()
    throw new Error(`Unknown config section "${sanitizeTerminalText(argument.trim())}". Use model, reasoning, permission, plan, vision, web, keybindings, or interface.`)
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
      () => {
        close()
        void this.runAction(() => this.openWebConfig())
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
    if (initialStage === 'root' && this.web !== undefined && this.webStatus === undefined) {
      void this.runAction(async () => { await this.refreshWebStatus() })
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

  private async openWebConfig(): Promise<void> {
    if (this.tui.hasOverlay() || this.composerModalActive) return
    if (this.web === undefined) throw new Error('Web providers are unavailable in this profile.')
    const status = await this.refreshWebStatus()
    if (this.tui.hasOverlay() || this.composerModalActive || this.disposed) return
    const close = (): void => {
      if (this.webConfigView === undefined) return
      this.webConfigView = undefined
      this.layout.setComposerOverride(undefined)
      this.composerModalActive = false
      this.tui.setFocus(this.editor)
      this.tui.requestRender()
    }
    const view = new WebConfigView(
      status,
      this.theme,
      () => { void this.runAction(async () => { await this.refreshWebStatus() }) },
      close,
    )
    this.webConfigView = view
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

  private async refreshWebStatus(): Promise<CommunityWebStatus> {
    if (this.web === undefined) throw new Error('Web providers are unavailable in this profile.')
    const status = await this.web.status()
    this.webStatus = status
    this.webConfigView?.setStatus(status)
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
    this.showRewindProgress('Loading Rewind history…')
    try {
      this.rewindSummaries = await this.rewindTransaction.list(String(sessionId), this.controller.current.cwd)
      if (this.controller.current.sessionId !== sessionId) {
        throw new Error('the active session changed while Rewind was preparing')
      }
    } catch (error: unknown) {
      this.closeRewindSurface()
      throw error
    }
    this.showRewindPointList()
  }

  private showRewindPointList(selectedPointId?: string): void {
    const summaries = this.rewindSummaries
    if (summaries === undefined) return
    const dialog = new RewindPointDialog(
      summaries,
      selectedPointId,
      () => this.terminal.rows,
      this.theme,
      summary => { void this.openRewindPlan(summary) },
      () => this.closeRewindSurface(),
    )
    this.rewindPointDialog = dialog
    this.rewindProgress = undefined
    this.composerModalActive = true
    this.layout.setComposerOverride(dialog)
    this.tui.setFocus(dialog)
    this.tui.requestRender()
  }

  private async openRewindPlan(summary: RewindPointSummary): Promise<void> {
    const sessionId = this.controller.current.sessionId
    if (sessionId === undefined || String(sessionId) !== summary.sessionId) {
      this.closeRewindSurface()
      this.controller.notice('The active session changed before the rewind point could be inspected.')
      return
    }
    this.showRewindProgress('Preparing source-attributed restore plan…')
    let plan: RewindPlan
    try {
      plan = await this.rewindTransaction.plan(String(sessionId), summary.pointId)
    } catch (error: unknown) {
      this.closeRewindSurface()
      this.controller.notice(error instanceof Error ? error.message : String(error))
      return
    }
    const dialog = new RewindDialog(
      plan,
      () => this.terminal.rows,
      this.theme,
      (action) => {
        this.showRewindProgress(action === 'conversation-only'
          ? 'Restoring conversation checkpoint…'
          : action === 'code-only'
            ? 'Restoring source-attributed code state…'
            : 'Restoring code and conversation checkpoint…')
        void this.performRewind(plan, action)
      },
      () => this.showRewindPointList(summary.pointId),
    )
    this.rewindPointDialog = undefined
    this.layout.setComposerOverride(dialog)
    this.tui.setFocus(dialog)
    this.tui.requestRender()
  }

  private async performRewind(
    plan: RewindPlan,
    action: RewindAction = 'code-and-conversation',
  ): Promise<void> {
    try {
      const draft = action === 'code-only'
        ? undefined
        : await preparePromptDraft(plan.input, this.promptAttachmentReader)
      await this.rewindTransaction.execute(plan, action, (phase) => {
        this.showRewindProgress(phase === 'forking'
          ? 'Rewinding conversation…'
          : phase === 'opening'
            ? 'Reloading rewound session…'
            : 'Rewind failed; restoring the current workspace and memory…')
      })
      if (draft !== undefined) {
        this.resetComposerInput()
        this.editor.setText(draft.text)
        this.attachmentDrafts.replaceAll(draft.attachments)
      }
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
    this.rewindPointDialog = undefined
    this.layout.setComposerOverride(this.rewindProgress)
    this.tui.setFocus(null)
    this.rewindProgress.setText([
      this.theme.bold('Rewind'),
      this.theme.accent(`✦ ${message}`),
      this.theme.dim('Source-attributed workspace, Memory, and conversation state stay coordinated.'),
    ].join('\n'))
    this.tui.requestRender()
  }

  private closeRewindSurface(): void {
    this.layout.setComposerOverride(undefined)
    this.rewindProgress = undefined
    this.rewindSummaries = undefined
    this.rewindPointDialog = undefined
    this.composerModalActive = false
    this.tui.setFocus(this.editor)
    this.tui.requestRender()
  }

  private composerDraft(): ComposerDraft<AttachmentDraft> {
    return {
      text: this.editor.getExpandedText(),
      attachments: this.attachmentDrafts.snapshot,
    }
  }

  private applyComposerInputAction(action: ComposerInputAction<AttachmentDraft>): boolean {
    switch (action.type) {
      case 'pass':
        return false
      case 'clear-and-arm-rewind':
        this.editor.setText('')
        this.attachmentDrafts.clear()
        this.scheduleRewindDisarm()
        break
      case 'arm-rewind':
        this.scheduleRewindDisarm()
        break
      case 'open-rewind':
        this.requestRewind()
        return true
      case 'restore-draft':
        this.editor.setText(action.draft.text)
        this.attachmentDrafts.replaceAll(action.draft.attachments)
        break
      case 'clear-restored-draft':
        this.editor.setText('')
        this.attachmentDrafts.clear()
        break
    }
    this.updateStatus(this.controller.current)
    this.tui.requestRender()
    return true
  }

  private scheduleRewindDisarm(): void {
    if (this.rewindArmTimer !== undefined) clearTimeout(this.rewindArmTimer)
    this.rewindArmTimer = setTimeout(() => {
      this.rewindArmTimer = undefined
      if (!this.composerInput.disarmRewind() || this.disposed) return
      this.updateStatus(this.controller.current)
      this.tui.requestRender()
    }, REWIND_ESCAPE_WINDOW_MS)
  }

  private disarmRewind(): void {
    if (this.rewindArmTimer !== undefined) clearTimeout(this.rewindArmTimer)
    this.rewindArmTimer = undefined
    if (!this.composerInput.disarmRewind() || this.disposed) return
    this.updateStatus(this.controller.current)
    this.tui.requestRender()
  }

  private resetComposerInput(requestRender = true): void {
    if (this.rewindArmTimer !== undefined) clearTimeout(this.rewindArmTimer)
    this.rewindArmTimer = undefined
    if (!this.composerInput.reset() || !requestRender || this.disposed) return
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

  private async selectNamedModel(name: string, reasoningEffort?: string): Promise<void> {
    const models = await this.controller.refreshModels()
    const matches = models.groups.flatMap(group => group.models
      .filter(model => `${group.id}/${model.id}` === name || model.id === name)
      .map(model => ({ provider: group.id, model: model.id })))
    if (matches.length !== 1) throw new Error(matches.length === 0
      ? `model "${name}" was not found`
      : `model "${name}" is ambiguous; use provider/model`)
    await this.selectModel({
      ...matches[0] as ModelSelection,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    })
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
      this.web === undefined ? undefined : this.webStatus ?? null,
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

  private enqueueInteraction(interaction: QueuedInteraction): void {
    if (this.activeInteraction?.key === interaction.key
      || this.interactionQueue.some(candidate => candidate.key === interaction.key)) return
    this.interactionQueue.push(interaction)
    this.startNextInteraction()
  }

  private startNextInteraction(): void {
    if (this.activeInteraction !== undefined) return
    const next = this.interactionQueue.shift()
    if (next === undefined) return
    this.activeInteraction = {
      ...next,
      close: undefined,
      phase: 'open',
    }
    next.open()
  }

  private setInteractionSurface(key: string, close: () => void): void {
    const active = this.activeInteraction
    if (active?.key !== key) {
      close()
      return
    }
    active.close?.()
    active.close = close
  }

  private hideInteractionSurface(key: string): void {
    const active = this.activeInteraction
    if (active?.key !== key) return
    active.close?.()
    active.close = undefined
  }

  private completeInteraction(key: string): void {
    const active = this.activeInteraction
    if (active?.key !== key) {
      const queued = this.interactionQueue.findIndex(candidate => candidate.key === key)
      if (queued !== -1) this.interactionQueue.splice(queued, 1)
      return
    }
    active.close?.()
    this.activeInteraction = undefined
    this.startNextInteraction()
  }

  private respondToInteraction(key: string, action: () => Promise<void>): void {
    const active = this.activeInteraction
    if (active?.key !== key || active.phase !== 'open') return
    active.phase = 'responding'
    void action().then(
      () => { this.completeInteraction(key) },
      (error: unknown) => { this.reopenInteraction(key, 'responding', error) },
    )
  }

  private interruptionTargetKey(state: Readonly<TuiState> = this.controller.current): string | undefined {
    return composerExecutionActivity(state)?.key
      ?? (this.imageSubmissionBusy ? 'vision:preparation' : undefined)
      ?? this.activeInteraction?.key
  }

  private reconcileInterruptTarget(state: Readonly<TuiState>): void {
    if (this.interruptingActivityKey === undefined) return
    if (this.interruptingActivityKey !== this.interruptionTargetKey(state)) {
      this.interruptingActivityKey = undefined
    }
  }

  private requestInterrupt(): boolean {
    const target = this.interruptionTargetKey()
    if (target === undefined) return false
    if (this.interruptingActivityKey === target) return true
    this.interruptingActivityKey = target
    const active = this.activeInteraction
    if (active !== undefined) this.beginInteractionCancellation(active)
    else if (this.imageSubmissionBusy) this.attachmentCoordinator?.cancel()
    else void this.runAction(() => this.controller.cancel())
    this.updateStatus(this.controller.current)
    this.tui.requestRender()
    return true
  }

  private cancelOrExit(): void {
    const target = this.interruptionTargetKey()
    if (target === undefined || this.interruptingActivityKey === target) {
      void this.requestExit(0)
      return
    }
    this.requestInterrupt()
  }

  private cancelActiveInteraction(): boolean {
    if (this.activeInteraction === undefined) return false
    this.requestInterrupt()
    return true
  }

  private beginInteractionCancellation(active: ActiveInteraction): void {
    if (active.phase === 'cancelling') return
    const key = active.key
    active.phase = 'cancelling'
    void this.controller.cancel().then(
      () => { this.completeInteraction(key) },
      (error: unknown) => { this.reopenInteraction(key, 'cancelling', error) },
    )
  }

  private reopenInteraction(
    key: string,
    phase: ActiveInteraction['phase'],
    error: unknown,
  ): void {
    const active = this.activeInteraction
    if (active?.key !== key || active.phase !== phase) return
    active.phase = 'open'
    this.controller.notice(error instanceof Error ? error.message : String(error))
    this.tui.requestRender()
  }

  private showApproval(prompt: ApprovalPrompt): void {
    const key = approvalInteractionKey(prompt.sessionId, prompt.approvalId)
    const settle = (outcome: 'allowed-once' | 'rejected'): void => {
      this.respondToInteraction(key, () => this.controller.answerApproval(prompt, outcome))
    }
    const dialog = new ApprovalDialog(
      prompt.toolName,
      prompt.reason,
      this.theme,
      settle,
      () => { this.cancelActiveInteraction() },
    )
    const previousFocus = this.tui.getFocusedComponent()
    const previousModalActive = this.composerModalActive
    const restoreComposer = this.layout.pushComposerOverride(dialog)
    this.composerModalActive = true
    this.tui.setFocus(dialog)
    this.tui.requestRender()
    this.setInteractionSurface(key, () => {
      if (!restoreComposer()) return
      this.composerModalActive = previousModalActive
      this.tui.setFocus(previousFocus)
      this.tui.requestRender()
    })
  }

  private showQuestion(
    prompt: QuestionPrompt,
    index: number,
    answers: Array<{ id: string; selected: string[]; custom?: string }>,
  ): void {
    const key = questionInteractionKey(prompt.sessionId, prompt.rpcId)
    const question = prompt.questions[index]
    if (question === undefined) {
      this.respondToInteraction(key, () => this.controller.answerQuestions(prompt, answers))
      return
    }
    const close = (): void => { this.hideInteractionSurface(key) }
    const next = (answer: { id: string; selected: string[]; custom?: string }): void => {
      const completed = [...answers, answer]
      if (index + 1 >= prompt.questions.length) {
        this.respondToInteraction(key, () => this.controller.answerQuestions(prompt, completed))
        return
      }
      close()
      this.showQuestion(prompt, index + 1, completed)
    }
    const cancel = (): void => { this.cancelActiveInteraction() }
    const custom = (selected: string[]): void => {
      close()
      const input = new TextInputDialog(
        this.tui,
        `${questionTitle(question)} · Other`,
        this.theme,
        text => {
          if (text.trim() === '') return
          next({ id: question.id, selected, custom: text })
        },
        cancel,
      )
      const inputHandle = this.tui.showOverlay(input, { width: '85%', maxHeight: '70%', margin: 1 })
      this.setInteractionSurface(key, () => { inputHandle.hide() })
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
      const handle = this.tui.showOverlay(dialog, { width: '85%', maxHeight: '80%', margin: 1 })
      this.setInteractionSurface(key, () => { handle.hide() })
      return
    }
    if (options.length === 0) {
      const handle = this.tui.showOverlay(new TextInputDialog(
        this.tui,
        questionTitle(question),
        this.theme,
        text => {
          if (text.trim() === '') return
          next({ id: question.id, selected: [], custom: text })
        },
        cancel,
      ), { width: '85%', maxHeight: '70%', margin: 1 })
      this.setInteractionSurface(key, () => { handle.hide() })
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
    const handle = this.tui.showOverlay(dialog, { width: '85%', maxHeight: '80%', margin: 1 })
    this.setInteractionSurface(key, () => { handle.hide() })
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

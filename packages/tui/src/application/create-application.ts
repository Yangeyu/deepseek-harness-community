import { ProcessTerminal, type Terminal } from '@earendil-works/pi-tui'
import type { ResolvedConfig } from './config.ts'
import type { TuiStartupOptions } from './cli.ts'
import type { TuiRuntime } from './contracts.ts'
import { TuiApplication, type ApplicationRuntime } from './app.ts'
import { ApplicationExit } from './exit.ts'
import { ApplicationStartup } from './startup.ts'
import { CommandRouter } from './command-router.ts'
import { InputCoordinator } from './input-coordinator.ts'
import { createLocalCommands } from './local-commands.ts'
import { createSessionFeatureSet } from './create-session-features.ts'
import type { TuiHostPorts } from './host-ports.ts'
import { createClipboardTextWriter } from '../infrastructure/clipboard/text-writer.ts'
import { HarnessModelPort } from '../infrastructure/harness/models.ts'
import { attachTerminalInput } from '../infrastructure/terminal/input-adapter.ts'
import { watchGitBranch } from '../infrastructure/workspace/git-branch.ts'
import {
  imageDraftFromClipboard,
  type ClipboardImageLoader,
} from '../modules/composer/attachments/clipboard.ts'
import type { VisionGateway } from '../modules/composer/attachments/coordinator.ts'
import { ComposerHost } from '../modules/composer/host.ts'
import type {
  PermissionDefaultPort,
  WebConfigurationPort,
} from '../modules/configuration/contracts.ts'
import { ConfigurationProcess } from '../modules/configuration/process.ts'
import { AuthenticationProcess } from '../modules/authentication/process.ts'
import type { ProviderAuthenticationPort } from '../modules/authentication/contracts.ts'
import type { ProviderUsagePort } from '../modules/usage/contracts.ts'
import { formatUsage } from '../modules/usage/format.ts'
import { selectedModel } from '../runtime/session/model-selection.ts'
import { openAuthorizationUrl } from '../infrastructure/terminal/open-url.ts'
import { InteractionHost } from '../modules/interaction/host.ts'
import type { MemoryPort } from '../modules/memory/contracts.ts'
import { MemoryProcess } from '../modules/memory/process.ts'
import type { PromptAttachmentReader } from '../modules/rewind/application/prompt-draft.ts'
import type { RewindPort } from '../modules/rewind/index.ts'
import { RewindProcess } from '../modules/rewind/process.ts'
import { SessionCenterProcess } from '../modules/session-center/process.ts'
import { SkillsHost } from '../modules/skills/host.ts'
import { TaskHost } from '../modules/task/host.ts'
import { TrajectoryHost } from '../modules/trajectory/host.ts'
import { TranscriptHost } from '../modules/transcript/host.ts'
import { createTheme } from '../presentation/primitives/theme.ts'
import type { ClipboardTextWriter } from '../presentation/shell/input/contracts.ts'
import { ComposerAnchoredLayout } from '../presentation/shell/layout/composer-layout.ts'
import { SelectableMainScreen } from '../presentation/shell/screen/selectable-main-screen.ts'
import type { GitBranchSource } from '../presentation/shell/status/contracts.ts'
import { ShellStatusProcess } from '../presentation/shell/status/process.ts'
import { SurfaceHost } from '../presentation/shell/surfaces/surface-host.ts'
import type { HostCommandSource } from '../runtime/commands.ts'
import { TerminalCommandDirectory } from '../runtime/commands.ts'
import { ApplicationMachine } from '../runtime/lifecycle/application-machine.ts'
import { RenderScheduler } from '../runtime/render-scheduler.ts'
import { SessionManager } from '../runtime/session/manager.ts'
import {
  BoundSession,
  SessionFeatureCoordinator,
} from './session-features.ts'
import { TerminalSnapshotCoordinator } from './snapshot.ts'

export type TuiMemoryPort = MemoryPort
export type WebGateway = WebConfigurationPort

export interface TuiApplicationDependencies {
  authentication?: ProviderAuthenticationPort
  usage?: ProviderUsagePort
  commandSource?: HostCommandSource
  vision?: VisionGateway
  web?: WebGateway
  permissionDefault?: PermissionDefaultPort
  startup?: TuiStartupOptions
  clipboardImage?: ClipboardImageLoader
  clipboardText?: ClipboardTextWriter
  attachments?: PromptAttachmentReader
  gitBranch?: GitBranchSource
  terminal?: Terminal
}

/** Constructed graph exposed only to integration tests and application diagnostics. */
export interface ApplicationAssembly {
  readonly application: TuiApplication
  readonly session: SessionManager
  readonly commands: TerminalCommandDirectory
  readonly composer: ComposerHost
  readonly status: ShellStatusProcess['status']
  readonly footer: ShellStatusProcess['footer']
  readonly transcript: TranscriptHost
  readonly layout: ComposerAnchoredLayout
  readonly surfaces: SurfaceHost
  readonly interactions: InteractionHost
  readonly rewindProcess: RewindProcess
  readonly taskProcess: TaskHost
  readonly configuration: ConfigurationProcess
  readonly skills: SkillsHost
  readonly trajectory: TrajectoryHost
  readonly input: InputCoordinator
  readonly tui: SelectableMainScreen
  readonly snapshot: TerminalSnapshotCoordinator
  readonly render: ShellStatusProcess['refresh']
  readonly requestExit: (code: number) => Promise<void>
}

/** Statically compose one terminal application; no feature discovery occurs at runtime. */
export function createApplication(
  host: TuiHostPorts,
  config: ResolvedConfig,
  runtime: TuiRuntime,
  rewind: RewindPort,
  memory: TuiMemoryPort,
  dependencies: TuiApplicationDependencies = {},
): ApplicationAssembly {
  const {
    commandSource,
    vision,
    web,
    permissionDefault,
    startup: startupIntent = { imagePaths: [], plan: false },
    clipboardImage = imageDraftFromClipboard,
    clipboardText,
    attachments,
    gitBranch = watchGitBranch,
    terminal = new ProcessTerminal(),
  } = dependencies

  const lifecycle = new ApplicationMachine('tui')
  const terminalScope = lifecycle.scope.fork('terminal')
  const rewindScope = lifecycle.scope.fork('rewind')
  const configurationScope = lifecycle.scope.fork('configuration')
  const sessionCenterScope = lifecycle.scope.fork('session-center')
  const memoryScope = lifecycle.scope.fork('memory')
  const surfaceScope = lifecycle.scope.fork('surfaces')
  const inputScope = lifecycle.scope.fork('input')
  const commandScope = lifecycle.scope.fork('commands')
  const shellScope = lifecycle.scope.fork('shell-status')

  const theme = createTheme(config.color)
  const tui = new SelectableMainScreen(terminal, config.showHardwareCursor)
  let invalidateTerminal = (): void => {}
  const renderScheduler = terminalScope.own(new RenderScheduler(() => { tui.requestRender() }))
  const session = new SessionManager(
    lifecycle.scope.fork('session-kernel'),
    host.sessions,
    host.interactions,
    config.cwd,
    config.historyMessages,
  )
  const exit = new ApplicationExit(runtime, () => session.current, () => lifecycle.dispose())
  const copyText = clipboardText ?? createClipboardTextWriter(terminal)

  const composer = new ComposerHost()
  const transcript = new TranscriptHost()
  const interactions = new InteractionHost()
  const taskProcess = new TaskHost()
  const skills = new SkillsHost()
  const trajectory = new TrajectoryHost()

  let commandRouter!: CommandRouter
  let layout!: ComposerAnchoredLayout
  let rewindProcess!: RewindProcess
  let configuration!: ConfigurationProcess
  let sessionCenter!: SessionCenterProcess
  let memoryProcess!: MemoryProcess
  let input!: InputCoordinator

  const commands = new TerminalCommandDirectory(
    createLocalCommands({
      helpText: () => commandRouter.helpText(),
      notice: message => { session.notice(message) },
      currentSession: () => session.current,
      clear: async () => {
        layout.followTranscript()
        await session.clearSession()
      },
      create: () => session.newSession(),
      resume: sessionId => sessionId === undefined
        ? sessionCenter.open()
        : sessionCenter.resume(sessionId),
      selectModel: model => model === undefined
        ? configuration.openModelSelector()
        : configuration.selectNamedModel(model),
      ...dependencies.authentication === undefined ? {} : { connectProvider: async (provider?: string) => {
        const connected = await authentication!.connect(provider)
        if (lifecycle.scope.active) session.notice(connected ? 'Provider connected. Use /model to select a model.' : 'Sign-in cancelled.')
      } },
      ...dependencies.usage === undefined ? {} : { showUsage: async () => {
        const captured = session.captureSession()
        const provider = selectedModel(session.current.modelCatalog, session.current.projections)?.provider
        if (provider === undefined) throw new Error('Select a model with /model before checking usage.')
        let message: string
        try {
          const usage = await dependencies.usage!.read(provider, commandScope.signal)
          message = usage === undefined ? `Subscription usage is not available for ${provider}.` : formatUsage(usage)
        } catch (error) {
          message = error instanceof Error ? error.message : String(error)
        }
        if (commandScope.active && captured.active) session.notice(message)
      } },
      attach: path => composer.attachPath(path).then(() => undefined),
      pasteImage: () => composer.pasteImage(),
      toggleDetails: () => { configuration.setDetails(!configuration.details) },
      openSkills: () => { skills.open() },
      openConfiguration: route => configuration.openRoute(route),
      openTask: () => { taskProcess.open() },
      openTrajectory: () => { trajectory.open() },
      openMemory: () => memoryProcess.open(),
      openRewind: () => { rewindProcess.request() },
      exit: () => exit.request(0),
    }),
    commandSource,
    [{
      name: 'permission',
      onBare: () => configuration.openPermission(),
      ...permissionDefault === undefined
        ? {}
        : {
            afterHostSuccess: async (preset: string) => {
              try {
                await permissionDefault.setDefaultPreset(preset)
              } catch (error: unknown) {
                const reason = error instanceof Error ? error.message : String(error)
                throw new Error(`Permission changed for this session, but its default could not be saved: ${reason}`)
              }
            },
          },
    }],
  )
  const shellStatus = new ShellStatusProcess({
    title: config.title,
    theme,
    session,
    composer,
    commandActivity: () => commandRouter.activity,
    memoryActivity: () => memoryProcess.activity,
    interruption: state => ({
      target: input.interruptionTarget(state),
      interruptingKey: input.interruptingKey,
    }),
    followsTranscript: () => layout.followsTranscriptTail,
    advanceTranscriptAnimation: () => { transcript.advanceAnimation() },
    gitBranch,
    invalidate: () => { invalidateTerminal() },
    scope: shellScope,
  })
  layout = new ComposerAnchoredLayout(
    shellStatus.header,
    transcript,
    shellStatus.status,
    composer.editorFrame,
    shellStatus.footer,
    () => terminal.rows,
    composer.attachmentRail,
    theme.surfaceBorder,
  )
  const surfaces = new SurfaceHost(
    layout,
    tui,
    () => { invalidateTerminal() },
    surfaceScope,
  )
  rewindProcess = new RewindProcess({
    rewind,
    conversation: {
      rewind: async (plan, onPhase) => String(await session.rewind({
        sessionId: plan.sessionId,
        ...plan.previousTurnEndSeq === undefined
          ? {}
          : { previousTurnEndSeq: plan.previousTurnEndSeq },
      }, onPhase)),
    },
    session,
    composer,
    surfaces,
    ...attachments === undefined ? {} : { promptAttachments: attachments },
    visibleRows: () => terminal.rows,
    theme,
    scope: rewindScope,
  })
  memoryProcess = new MemoryProcess({
    memory,
    session,
    surfaces,
    visibleRows: () => terminal.rows,
    theme,
    onActivity: () => { shellStatus.refresh() },
    invalidate: () => { invalidateTerminal() },
    scope: memoryScope,
  })
  const authentication = dependencies.authentication === undefined ? undefined : new AuthenticationProcess({
    port: dependencies.authentication, surfaces, tui, theme,
    scope: lifecycle.scope.fork('authentication'),
    invalidate: () => { invalidateTerminal() },
    openUrl: openAuthorizationUrl,
  })
  configuration = new ConfigurationProcess({
    session,
    models: new HarnessModelPort(host.sessions, session),
    commands,
    surfaces,
    tui,
    theme,
    visibleRows: () => terminal.rows,
    imageSubmissionBusy: () => composer.current.imageSubmissionBusy,
    setTranscriptDetails: expanded => { transcript.setDetails(expanded) },
    invalidate: () => { invalidateTerminal() },
    scope: configurationScope,
    ...vision === undefined ? {} : { vision },
    ...web === undefined ? {} : { web },
  })
  sessionCenter = new SessionCenterProcess({
    session,
    surfaces,
    theme,
    scope: sessionCenterScope,
    invalidate: () => { invalidateTerminal() },
  })
  commandRouter = new CommandRouter({
    directory: commands,
    session,
    skills,
    refreshAutocomplete: () => { composer.refreshAutocomplete() },
    onActivity: () => { shellStatus.refresh() },
    scope: commandScope,
  })

  const sessionFeatureOptions = {
    skills: host.skills,
    goals: host.goals,
    runtime,
    terminal,
    tui,
    theme,
    commands,
    composer,
    transcript,
    surfaces,
    fileReferences: host.fileReferences,
    clipboardImage,
    showReasoning: config.showReasoning,
    maxToolOutputLines: config.maxToolOutputLines,
    thinkingMaxLines: config.thinkingMaxLines,
    dispatchCommand: (text: string) => commandRouter.dispatch(text),
    autocompleteItems: () => commandRouter.autocompleteRows(),
    followTranscript: () => { layout.followTranscript() },
    openRewind: () => { rewindProcess.request() },
    onInteractionChange: () => {
      if (!lifecycle.active) return
      input.reconcile()
      shellStatus.refresh()
    },
    invalidate: () => { invalidateTerminal() },
    ...vision === undefined ? {} : { vision },
  }

  const bootstrapScope = lifecycle.scope.fork('unbound-features')
  const bootstrapFeatures = createSessionFeatureSet(sessionFeatureOptions, bootstrapScope, session)
  const featureCoordinator = new SessionFeatureCoordinator({
    composer,
    interaction: interactions,
    skills,
    task: taskProcess,
    trajectory,
    transcript,
  }, bootstrapFeatures, (context, previous) => {
    const bound = new BoundSession(
      session,
      context.scope,
      context.sessionId,
      context.epoch,
      context.runtime,
    )
    return createSessionFeatureSet(
      sessionFeatureOptions,
      context.scope,
      bound,
      { sessionId: context.sessionId, epoch: context.epoch },
      previous,
    )
  })
  lifecycle.scope.onDispose(session.registerFeatureParticipant(featureCoordinator))

  input = new InputCoordinator({
    session,
    composer,
    interactions,
    configuration,
    surfaces,
    layout,
    transcript,
    screen: tui,
    clipboard: copyText,
    requestExit: code => exit.request(code),
    invalidate: () => { shellStatus.refresh() },
    scope: inputScope,
  })
  lifecycle.scope.onDispose(session.onInteraction((event) => {
    if (!lifecycle.active) return
    if (event.type === 'approval') interactions.requestApproval(event.prompt)
    else if (event.type === 'questions') interactions.requestQuestions(event.prompt)
    else interactions.resolve(event.resolution)
  }))

  const snapshot = terminalScope.own(new TerminalSnapshotCoordinator({
    application: () => lifecycle.current,
    session: () => session.current,
    composer: () => composer.current,
    interaction: () => interactions.current,
    rewind: () => rewindProcess.current,
    transcript: () => transcript.current,
    trajectory: () => trajectory.current,
    configuration: () => configuration.current,
    task: () => taskProcess.current,
    skills: () => skills.current,
    sessionCenter: () => sessionCenter.current,
    memory: () => memoryProcess.activity,
    surfaces: () => surfaces.current,
    focus: () => surfaces.focus,
  }))
  invalidateTerminal = () => { snapshot.invalidate() }
  terminalScope.onDispose(lifecycle.subscribe(() => { snapshot.invalidate() }))
  terminalScope.onDispose(session.subscribe(() => { snapshot.invalidate() }))
  terminalScope.onDispose(composer.subscribe(() => { snapshot.invalidate() }))
  terminalScope.onDispose(transcript.subscribe(() => { snapshot.invalidate() }))
  terminalScope.onDispose(snapshot.subscribe(() => { renderScheduler.invalidate() }))
  snapshot.flush()

  shellStatus.start()
  tui.addChild(layout)
  tui.setFocus(composer.editor)

  const startup = new ApplicationStartup({
    title: config.title,
    intent: startupIntent,
    runtime,
    terminal,
    screen: tui,
    terminalScope,
    attachInput: () => attachTerminalInput(tui, gesture => input.handle(gesture)),
    session,
    sessionCenter,
    configuration,
    commands,
    composer,
  })
  const applicationRuntime: ApplicationRuntime = {
    start: () => lifecycle.start(() => startup.run()),
    dispose: () => lifecycle.dispose(),
  }
  const application = new TuiApplication(applicationRuntime)

  return {
    application,
    session,
    commands,
    composer,
    status: shellStatus.status,
    footer: shellStatus.footer,
    transcript,
    layout,
    surfaces,
    interactions,
    rewindProcess,
    taskProcess,
    configuration,
    skills,
    trajectory,
    input,
    tui,
    snapshot,
    render: state => { shellStatus.refresh(state) },
    requestExit: code => exit.request(code),
  }
}

export function createTuiApplication(
  host: TuiHostPorts,
  config: ResolvedConfig,
  runtime: TuiRuntime,
  rewind: RewindPort,
  memory: TuiMemoryPort,
  dependencies: TuiApplicationDependencies = {},
): TuiApplication {
  return createApplication(host, config, runtime, rewind, memory, dependencies).application
}

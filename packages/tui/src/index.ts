/**
 * Third-party terminal profile bundle for DeepSeek Harness. The composition
 * root adapts in-process Host services to consumer-owned application ports and
 * keeps Cordis and pi-tui outside the lifecycle kernel.
 * @module @vascent/deepseek-harness-tui
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-file-reference'
import type {} from '@vascent/deepseek-harness-web'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { TuiRuntime } from './application/contracts.ts'
import { createTuiApplication } from './application/create-application.ts'
import type { TuiHostPorts } from './application/host-ports.ts'
import {
  installRewindWorkspaceAdapter,
  installRewindPromptAdapter,
  FileRewindRepository,
  HostRewindConversationHistory,
  LocalWorkspaceRewind,
  MemoryRewindParticipant,
  RewindService,
} from './modules/rewind/index.ts'
import type { HostCommandSource } from './runtime/commands.ts'
import { Config, resolveConfig, type Config as TuiConfig } from './application/config.ts'
import {
  CliUsageError,
  formatCliError,
  parseCliArgs,
  renderCliHelp,
} from './application/cli.ts'
import { formatSessionList } from './modules/session-center/model.ts'
import { HarnessFileReferenceSource } from './infrastructure/harness/file-references.ts'
import { HarnessGoalPort } from './infrastructure/harness/goal.ts'
import { HarnessInteractionSource } from './infrastructure/harness/interactions.ts'
import { settingsPermissionDefaultGateway } from './infrastructure/harness/permission-default.ts'
import { HarnessSessionTransport } from './infrastructure/harness/session-transport.ts'
import { harnessSkillCatalogSource } from './infrastructure/harness/skills.ts'

export { Config, resolveConfig }
export type { TuiConfig, TuiRuntime }
export { TerminalCommandDirectory } from './runtime/commands.ts'
export type {
  RewindAction,
  RewindFilePlan,
  RewindParticipantImpact,
  RewindPlan,
  RewindPlanState,
  RewindPointSummary,
  RewindPort,
} from './modules/rewind/index.ts'
export type {
  HostCommandSource,
  TerminalCommandDefinition,
  TerminalCommandDescriptor,
} from './runtime/commands.ts'
export type {
  PendingSubmission,
} from './runtime/session/manager.ts'
export type { ApprovalPrompt, QuestionPrompt } from './runtime/session/interactions.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Loader settlement barrier supplied by dsh profile boot. */
    loader?: { await(): Promise<void> }
    /** Application command line supplied by the dsh launcher. */
    cmdlineArgs?: { get(): readonly string[] }
    /** Bounded process exit supplied by the dsh launcher. */
    appExit?: (code: number) => void
  }
}

/** Stable Cordis plugin name. */
export const name = 'community-tui'

/** Host services required by the in-process terminal composition root. */
export const inject = [
  'sessionController',
  'fileReferences',
  'sessionSkillCatalog',
  'goals',
  'tools',
  'agents',
  'attachments',
  'commands',
  'communityWeb',
  'memory',
  'settings',
  'vision',
]

/** Mount the terminal application and bind its lifetime to the plugin effect. */
export function apply(ctx: Context, config: TuiConfig): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('community-tui requires the dsh launcher appExit service')
  let invocation
  try {
    invocation = parseCliArgs(ctx.get('cmdlineArgs')?.get() ?? [], config)
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error
    process.stderr.write(formatCliError(error))
    exit(2)
    return
  }
  if (invocation.kind === 'help') {
    process.stdout.write(renderCliHelp(invocation.topic))
    exit(0)
    return
  }
  if (invocation.kind !== 'interactive' && invocation.kind !== 'sessions') {
    process.stderr.write(`dscode: ${invocation.kind} is available only through the dscode launcher\n`)
    exit(2)
    return
  }
  if (invocation.patches.length > 0) {
    process.stderr.write('dscode: --patch must be consumed by the launcher before TUI startup\n')
    exit(2)
    return
  }
  const runtime: TuiRuntime = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    exit,
  }
  if (invocation.kind === 'sessions') {
    ctx.effect(() => {
      const abort = new AbortController()
      void (async () => {
        await ctx.get('loader')?.await()
        const sessions = (await ctx.sessionController.list({}, abort.signal)).items
        runtime.stdout.write(formatSessionList(sessions, invocation.json))
        exit(0)
      })().catch((error: unknown) => {
        if (abort.signal.aborted) return
        runtime.stderr.write(`dsh tui: ${error instanceof Error ? error.message : String(error)}\n`)
        exit(1)
      })
      return () => { abort.abort() }
    })
    return
  }
  const resolved = resolveConfig(invocation.config)
  const sessionTransport = new HarnessSessionTransport({
    cwd: resolved.cwd,
    controller: ctx.sessionController,
    tools: ctx.tools,
    toolScope: sessionId => ctx.agents.get(sessionId),
    onStatus: listener => ctx.on('api-session/status', listener),
    onError: listener => ctx.on('api-session/error', listener),
    onPresenterError: message => { ctx.logger.warn(message) },
  })
  const host: TuiHostPorts = {
    sessions: sessionTransport,
    interactions: new HarnessInteractionSource(ctx),
    fileReferences: new HarnessFileReferenceSource(ctx.sessionController, ctx.fileReferences),
    skills: harnessSkillCatalogSource(ctx.sessionSkillCatalog),
    goals: session => new HarnessGoalPort(ctx.sessionController, ctx.goals, session),
  }
  const memoryRewind = new MemoryRewindParticipant(ctx.memory)
  const rewindRepository = new FileRewindRepository(dshHomePath('rewind'), {
    onWarning: message => { ctx.logger.warn(message) },
  })
  const rewind = new RewindService(
    {
      history: resolved.rewindHistory,
      onIngestionError: error => { ctx.logger.warn(`Rewind ingestion failed: ${String(error)}`) },
      onPersistenceError: error => { ctx.logger.warn(`durable Rewind failed: ${String(error)}`) },
    },
    new HostRewindConversationHistory(ctx),
    new LocalWorkspaceRewind(),
    [memoryRewind],
    rewindRepository,
  )
  installRewindPromptAdapter(
    ctx,
    rewind,
    error => { ctx.logger.warn(`Rewind prompt ingestion failed: ${String(error)}`) },
  )
  installRewindWorkspaceAdapter(ctx, rewind)
  const commandSource: HostCommandSource = {
    list: (sessionId) => {
      if (sessionId === undefined) return []
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) return []
      return ctx.commands.list(agent).map((command: CommandDescriptor) => ({
        name: command.name,
        description: command.description,
        ...command.input === undefined ? {} : { argumentHint: command.input.hint },
      }))
    },
    execute: async (sessionId, line, signal) => {
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) return undefined
      return (await ctx.commands.execute(agent, line, [], signal))?.result
    },
    subscribe: listener => ctx.on('commands/change', listener),
  }
  const app = createTuiApplication(
    host,
    resolved,
    runtime,
    rewind,
    ctx.memory,
    {
      commandSource,
      vision: ctx.vision,
      web: ctx.communityWeb,
      permissionDefault: settingsPermissionDefaultGateway(ctx.settings),
      startup: invocation.startup,
      attachments: ctx.attachments,
    },
  )
  ctx.effect(() => {
    let active = true
    const removeMemoryMutation = ctx.memory.onMutation(mutation => {
      const effect = memoryRewind.capture(mutation)
      if (effect !== undefined) rewind.recordEffect(effect)
    })
    void (async () => {
      await ctx.get('loader')?.await()
      if (!active) return
      await app.start()
    })().catch((error: unknown) => {
      if (!active) return
      runtime.stderr.write(`dsh tui: ${error instanceof Error ? error.message : String(error)}\n`)
      void app.dispose().then(() => rewind.close()).finally(() => exit(1))
    })
    return async () => {
      active = false
      try {
        await app.dispose()
        await rewind.close()
      } finally {
        removeMemoryMutation()
      }
    }
  })
}

/**
 * Third-party terminal profile bundle for DeepSeek Harness. The application
 * consumes only the transport-neutral ApiProxy and keeps pi-tui behind its own
 * controller/rendering seam.
 * @module @vascent/deepseek-harness-tui
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import {
  InProcessApiClient,
  toFetchHandler,
} from '@deepseek-ai/dsh-host-apiproxy'
import { TuiApplication, type TuiRuntime } from './application/app.ts'
import { installCheckpointCapture, WorkspaceCheckpointStore } from './checkpoint.ts'
import type { HostCommandSource } from './runtime/commands.ts'
import { Config, resolveConfig, type Config as TuiConfig } from './application/config.ts'

export { Config, resolveConfig }
export type { TuiConfig, TuiRuntime }
export { HarnessController } from './runtime/controller.ts'
export { TerminalCommandDirectory } from './runtime/commands.ts'
export type {
  HostCommandSource,
  TerminalCommandDefinition,
  TerminalCommandDescriptor,
} from './runtime/commands.ts'
export type {
  ApprovalPrompt,
  PendingSubmission,
  QuestionPrompt,
  TuiControllerSink,
  TuiState,
} from './runtime/controller.ts'
export { TranscriptComponent } from './presentation/transcript.ts'
export { buildTrajectoryRecords } from './trajectory/records.ts'
export type { TrajectoryRecord } from './trajectory/records.ts'
export { TrajectoryView } from './trajectory/view.ts'
export { TrajectoryModel } from './trajectory/model.ts'
export type { TrajectoryMeasurement, TrajectoryMetrics, TrajectoryNode } from './trajectory/model.ts'
export { sanitizeTerminalText } from './text.ts'

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

/** The in-process API gateway must exist before the terminal can activate. */
export const inject = ['apiProxy', 'agents', 'commands', 'memory']

interface ParsedArgs {
  help: boolean
  config: TuiConfig
}

function parseArgs(args: readonly string[], base: TuiConfig): ParsedArgs {
  const config: TuiConfig = { ...base }
  let help = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }
    if (argument === '--resume') {
      const value = args[index + 1]
      if (value === undefined) throw new Error('--resume requires a session id')
      config.sessionId = value
      index += 1
      continue
    }
    if (argument === '--cwd') {
      const value = args[index + 1]
      if (value === undefined) throw new Error('--cwd requires a path')
      config.cwd = value
      index += 1
      continue
    }
    if (argument === '--no-color') {
      config.color = false
      continue
    }
    throw new Error(`unknown TUI option: ${argument}`)
  }
  return { help, config }
}

const HELP = `Usage: dsh-tui [options]

Options:
  --resume <session-id>  Resume an existing session
  --cwd <path>           Start a new session in this directory
  --no-color             Disable ANSI color
  -h, --help             Show this help
`

/** Mount the terminal application and bind its lifetime to the plugin effect. */
export function apply(ctx: Context, config: TuiConfig): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('community-tui requires the dsh launcher appExit service')
  const parsed = parseArgs(ctx.get('cmdlineArgs')?.get() ?? [], config)
  if (parsed.help) {
    process.stdout.write(HELP)
    exit(0)
    return
  }
  const runtime: TuiRuntime = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    exit,
  }
  const api = new InProcessApiClient(toFetchHandler(ctx.apiProxy))
  const resolved = resolveConfig(parsed.config)
  const checkpoints = new WorkspaceCheckpointStore(resolved.rewindCheckpoints)
  installCheckpointCapture(ctx, checkpoints)
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
      return (await ctx.commands.execute(agent, line, signal))?.result
    },
    subscribe: listener => ctx.on('commands/change', listener),
  }
  const app = new TuiApplication(api, resolved, runtime, checkpoints, ctx.memory, commandSource)
  ctx.effect(() => {
    let active = true
    const removeMemoryMutation = ctx.memory.onMutation(mutation => {
      checkpoints.recordMemoryMutation(mutation)
    })
    void (async () => {
      await ctx.get('loader')?.await()
      if (!active) return
      await app.start()
    })().catch((error: unknown) => {
      if (!active) return
      runtime.stderr.write(`dsh tui: ${error instanceof Error ? error.message : String(error)}\n`)
      void app.dispose().finally(() => exit(1))
    })
    return async () => {
      active = false
      removeMemoryMutation()
      await app.dispose()
    }
  })
}

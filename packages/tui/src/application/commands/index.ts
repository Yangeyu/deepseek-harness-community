import type { RuntimeSessionSnapshot } from '../../runtime/session/snapshot.ts'
import type { PermissionDefaultPort } from '../../modules/configuration/contracts.ts'
import type { ProviderUsagePort } from '../../modules/usage/contracts.ts'
import type { TerminalCommandDecoration, TerminalCommandDefinition } from './contracts.ts'
import { createConnectCommand } from './builtins/connect.ts'
import { createUsageCommand } from './builtins/usage.ts'
import { createHelpCommand } from './builtins/help.ts'
import { createClearCommand } from './builtins/clear.ts'
import { createNewCommand } from './builtins/new.ts'
import { createResumeCommand } from './builtins/resume.ts'
import { createModelCommand } from './builtins/model.ts'
import { createAttachCommand } from './builtins/attach.ts'
import { createPasteImageCommand } from './builtins/paste-image.ts'
import { createCopyCommand } from './builtins/copy.ts'
import { createDetailsCommand } from './builtins/details.ts'
import { createSkillsCommand } from './builtins/skills.ts'
import { createConfigCommand } from './builtins/config.ts'
import { createVisionCommand } from './builtins/vision.ts'
import { createWebCommand } from './builtins/web.ts'
import { createTaskCommand } from './builtins/task.ts'
import { createTrajectoryCommand } from './builtins/trajectory.ts'
import { createStatusCommand } from './builtins/status.ts'
import { createMemoriesCommand } from './builtins/memories.ts'
import { createRewindCommand } from './builtins/rewind.ts'
import { createExitCommand } from './builtins/exit.ts'
import { createPermissionDecoration } from './builtins/permission.ts'

export interface BuiltinCommandOptions {
  session: {
    readonly current: Pick<RuntimeSessionSnapshot,
      'events' | 'historyHasMore' | 'modelCatalog' | 'projections' | 'sessionId' | 'cwd' | 'runState' | 'connection' | 'queue'>
    captureSession(): { readonly active: boolean }
    loadEarlierHistory(): Promise<boolean>
    notice(message: string): void
    clearSession(): Promise<void>
    newSession(): Promise<void>
  }
  composer: {
    attachPath(path: string): Promise<unknown>
    pasteImage(): Promise<void>
  }
  configuration: {
    openModelSelector(): Promise<void>
    selectNamedModel(model: string): Promise<void>
    readonly details: boolean
    setDetails(expanded: boolean): void
    openRoute(route: string): void | Promise<void>
    openPermission(): void
  }
  sessionCenter: { open(): Promise<void>; resume(sessionId: string): Promise<void> }
  authentication?: { connect(provider?: string): Promise<boolean> }
  /** The same reader instance used by the footer, including its shared cache. */
  usage?: ProviderUsagePort
  layout: { followTranscript(): void }
  skills: { open(): void }
  task: { open(): void }
  trajectory: { open(): void }
  memory: { open(): Promise<void> }
  rewind: { request(): void }
  exit: { request(code: number): Promise<void> }
  clipboardText(text: string): Promise<void>
  signal: AbortSignal
  help: { helpText(): string }
  permissionDefault?: PermissionDefaultPort
}

/** Explicit membership and discovery order; each member owns its definition and behavior. */
export function createBuiltinCommands(options: BuiltinCommandOptions): {
  local: TerminalCommandDefinition[]
  decorations: TerminalCommandDecoration[]
} {
  return {
    local: [
      ...options.authentication === undefined ? [] : [
        createConnectCommand(options.authentication, options.session, options.signal),
      ],
      ...options.usage === undefined ? [] : [
        createUsageCommand(options.session, options.usage, options.signal),
      ],
      createHelpCommand(options.session, options.help),
      createClearCommand(options.session, options.layout),
      createNewCommand(options.session),
      createResumeCommand(options.sessionCenter),
      createModelCommand(options.configuration),
      createAttachCommand(options.composer),
      createPasteImageCommand(options.composer),
      createCopyCommand(options.session, options.clipboardText, options.signal),
      createDetailsCommand(options.configuration),
      createSkillsCommand(options.skills),
      createConfigCommand(options.configuration),
      createVisionCommand(options.configuration),
      createWebCommand(options.configuration),
      createTaskCommand(options.task),
      createTrajectoryCommand(options.trajectory),
      createStatusCommand(options.session),
      createMemoriesCommand(options.memory),
      createRewindCommand(options.rewind),
      createExitCommand(options.exit),
    ],
    decorations: [createPermissionDecoration(options.configuration, options.permissionDefault)],
  }
}

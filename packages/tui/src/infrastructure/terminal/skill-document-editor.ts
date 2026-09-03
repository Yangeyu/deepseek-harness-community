import type { Terminal } from '@earendil-works/pi-tui'
import type {
  LocalSkillDocument,
  LocalSkillEditorPort,
} from '../../modules/skills/contracts.ts'
import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import {
  externalEditorCommand,
  runExternalEditor,
} from './external-editor.ts'

export interface SkillEditorScreen {
  start(): void
  stop(): void
}

export interface SkillEditorHost {
  openPath(path: string, signal: AbortSignal): Promise<void>
  notice(message: string): void
}

export interface SkillEditorRuntime {
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  stderr: NodeJS.WriteStream
}

/** Owns the temporary terminal hand-off required by a local Skill editor. */
export class TerminalSkillDocumentEditor implements LocalSkillEditorPort {
  constructor(
    private readonly host: SkillEditorHost,
    private readonly screen: SkillEditorScreen,
    private readonly terminal: Terminal,
    private readonly runtime: SkillEditorRuntime,
    private readonly scope: LifecycleScope,
    private readonly invalidate: () => void,
    private readonly environment: Record<string, string | undefined> = process.env,
  ) {}

  async open(document: LocalSkillDocument, created: boolean): Promise<void> {
    const editor = externalEditorCommand(this.environment)
    if (editor === undefined) {
      try {
        await this.host.openPath(document.path, this.scope.signal)
        this.host.notice(`${created ? 'Created' : 'Opened'} /${document.name} at ${document.path}`)
      } catch (error: unknown) {
        throw new Error([
          `${created ? 'Created' : 'Edit'} /${document.name} at:`,
          document.path,
          `No terminal editor is configured and the Host opener failed: ${error instanceof Error ? error.message : String(error)}`,
        ].join('\n'))
      }
      return
    }

    const operation = this.scope.fork('external-editor')
    operation.onDispose(async () => {
      if (!this.scope.active) return
      await this.terminal.drainInput(100, 20)
      if (!this.scope.active) return
      this.screen.start()
      this.invalidate()
    })
    this.screen.stop()
    try {
      await runExternalEditor(editor, document.path, [
        this.runtime.stdin,
        this.runtime.stdout,
        this.runtime.stderr,
      ])
    } finally {
      await operation.dispose()
    }
  }

}

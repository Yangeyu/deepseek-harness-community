import { spawn } from 'node:child_process'

export interface ExternalEditorCommand {
  command: string
  source: 'VISUAL' | 'EDITOR'
}
export function externalEditorCommand(
  environment: Record<string, string | undefined> = process.env,
): ExternalEditorCommand | undefined {
  const visual = environment.VISUAL?.trim()
  if (visual !== undefined && visual !== '') return { command: visual, source: 'VISUAL' }
  const editor = environment.EDITOR?.trim()
  return editor === undefined || editor === '' ? undefined : { command: editor, source: 'EDITOR' }
}

function shellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Run the user's trusted editor command and wait for terminal ownership to return. */
export function runExternalEditor(
  editor: ExternalEditorCommand,
  path: string,
  stdio: [NodeJS.ReadStream, NodeJS.WriteStream, NodeJS.WriteStream],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(`${editor.command} ${shellArgument(path)}`, {
      shell: true,
      stdio,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${editor.source} exited ${signal === null ? `with code ${code ?? 'unknown'}` : `from signal ${signal}`}`))
    })
  })
}

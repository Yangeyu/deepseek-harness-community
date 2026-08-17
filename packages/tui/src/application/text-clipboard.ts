import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import type { Terminal } from '@earendil-works/pi-tui'

interface ClipboardCommand {
  executable: string
  arguments: readonly string[]
}

export type ClipboardTextWriter = (text: string) => Promise<void>
export type ClipboardCommandRunner = (command: ClipboardCommand, text: string) => Promise<void>

const PLATFORM_COMMANDS: Partial<Record<NodeJS.Platform, readonly ClipboardCommand[]>> = {
  darwin: [{ executable: 'pbcopy', arguments: [] }],
  win32: [{ executable: 'clip.exe', arguments: [] }],
  linux: [
    { executable: 'wl-copy', arguments: [] },
    { executable: 'xclip', arguments: ['-selection', 'clipboard'] },
    { executable: 'xsel', arguments: ['--clipboard', '--input'] },
  ],
}

function runClipboardCommand(command: ClipboardCommand, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.arguments], {
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (error === undefined) resolve()
      else reject(error)
    }
    child.once('error', finish)
    child.once('close', code => finish(code === 0
      ? undefined
      : new Error(`${command.executable} exited with status ${String(code)}`)))
    child.stdin.once('error', finish)
    child.stdin.end(text)
  })
}

function writeOsc52(terminal: Terminal, text: string): void {
  terminal.write(`\u001b]52;c;${Buffer.from(text).toString('base64')}\u0007`)
}

/** Prefer a verified platform clipboard command, with OSC 52 for remote terminals. */
export function createClipboardTextWriter(
  terminal: Terminal,
  options: {
    platform?: NodeJS.Platform
    run?: ClipboardCommandRunner
  } = {},
): ClipboardTextWriter {
  const commands = PLATFORM_COMMANDS[options.platform ?? process.platform] ?? []
  const run = options.run ?? runClipboardCommand
  return async (text) => {
    if (text === '') return
    for (const command of commands) {
      try {
        await run(command, text)
        return
      } catch {
        // Try the next available platform adapter before terminal fallback.
      }
    }
    writeOsc52(terminal, text)
  }
}

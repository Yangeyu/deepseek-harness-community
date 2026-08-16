import type { Config } from './config.ts'

export interface ParsedTuiArgs {
  help: boolean
  config: Config
  imagePaths: readonly string[]
}

function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1]
  if (value === undefined || value === '' || value.startsWith('-')) throw new Error(`${option} requires a value`)
  return value
}

/** Parse terminal-only options separately from Cordis plugin construction. */
export function parseTuiArgs(args: readonly string[], base: Config): ParsedTuiArgs {
  const config: Config = { ...base }
  const imagePaths: string[] = []
  let help = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) continue
    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }
    if (argument === '--resume') {
      config.sessionId = requiredValue(args, index, '--resume')
      index += 1
      continue
    }
    if (argument === '--cwd') {
      config.cwd = requiredValue(args, index, '--cwd')
      index += 1
      continue
    }
    if (argument === '--image' || argument === '-i') {
      imagePaths.push(requiredValue(args, index, argument))
      index += 1
      continue
    }
    if (argument.startsWith('--image=')) {
      const value = argument.slice('--image='.length)
      if (value === '') throw new Error('--image requires a value')
      imagePaths.push(value)
      continue
    }
    if (argument === '--no-color') {
      config.color = false
      continue
    }
    throw new Error(`unknown TUI option: ${argument}`)
  }
  return { help, config, imagePaths }
}

export const TUI_HELP = `Usage: dsh-tui [options]

Options:
  --resume <session-id>  Resume an existing session
  --cwd <path>           Start a new session in this directory
  -i, --image <path>     Attach an image at startup (repeatable)
  --no-color             Disable ANSI color
  -h, --help             Show this help
`

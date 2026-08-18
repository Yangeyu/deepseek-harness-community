import type { Config } from './config.ts'

export type CompletionShell = 'bash' | 'fish' | 'powershell' | 'zsh'
export type CliHelpTopic = 'completion' | 'config' | 'doctor' | 'exec' | 'plugin' | 'resume' | 'sessions'

export type ResumeTarget =
  | { kind: 'last' }
  | { kind: 'session'; sessionId: string }

/** Startup intent kept separate from durable plugin configuration. */
export interface TuiStartupOptions {
  resume?: ResumeTarget
  prompt?: string
  imagePaths: readonly string[]
  model?: string
  reasoningEffort?: string
  permissionMode?: string
  plan: boolean
}

export interface TuiInteractiveInvocation {
  kind: 'interactive'
  config: Config
  startup: TuiStartupOptions
  patches: readonly string[]
}

export interface SessionListInvocation {
  kind: 'sessions'
  json: boolean
  patches: readonly string[]
}

export type TuiProfileInvocation = TuiInteractiveInvocation | SessionListInvocation

export type CliInvocation =
  | TuiProfileInvocation
  | { kind: 'help'; topic?: CliHelpTopic }
  | { kind: 'version' }
  | { kind: 'doctor'; json: boolean }
  | { kind: 'completion'; shell: CompletionShell }
  | { kind: 'config'; defaults: boolean; patches: readonly string[] }
  | { kind: 'plugin'; args: readonly string[] }
  | { kind: 'exec'; cwd?: string; prompt?: string; patches: readonly string[] }

const COMMANDS = ['resume', 'sessions', 'exec', 'doctor', 'completion', 'config', 'plugin', 'help'] as const
const HELP_TOPICS = ['resume', 'sessions', 'exec', 'doctor', 'completion', 'config', 'plugin'] as const
const COMPLETION_SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const
const VERSION_FLAGS = ['-v', '-V', '--version'] as const
const OPTIONS = [
  '-v',
  '-V',
  '--version',
  '--help',
  '--patch',
  '--resume',
  '--last',
  '--cwd',
  '--image',
  '--model',
  '--effort',
  '--permission-mode',
  '--plan',
  '--no-color',
  '--json',
] as const

export class CliUsageError extends Error {
  constructor(message: string, readonly suggestion?: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1]
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(Math.min(
        (current[rightIndex] ?? 0) + 1,
        (previous[rightIndex + 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + Number(left[leftIndex] !== right[rightIndex]),
      ))
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[right.length] ?? Math.max(left.length, right.length)
}

function closest(value: string, candidates: readonly string[]): string | undefined {
  const ranked = candidates
    .map(candidate => ({ candidate, distance: editDistance(value, candidate) }))
    .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))
  const match = ranked[0]
  if (match === undefined || match.distance > Math.max(2, Math.floor(value.length / 3))) return undefined
  return match.candidate
}

function unknownOption(option: string): never {
  const normalized = option.replace(/=.*/u, '')
  const candidate = closest(normalized, OPTIONS)
  throw new CliUsageError(
    `unknown option: ${option}`,
    candidate === undefined || candidate === normalized ? undefined : `Did you mean ${candidate}?`,
  )
}

function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1]
  if (value === undefined || value === '' || value.startsWith('-')) {
    throw new CliUsageError(`${option} requires a value`)
  }
  return value
}

function valueOption(
  args: readonly string[],
  index: number,
  names: readonly string[],
): { value: string; nextIndex: number } | undefined {
  const argument = args[index]
  if (argument === undefined) return undefined
  if (names.includes(argument)) {
    return { value: requiredValue(args, index, names.at(-1) ?? argument), nextIndex: index + 1 }
  }
  const longName = names.find(name => name.startsWith('--') && argument.startsWith(`${name}=`))
  if (longName === undefined) return undefined
  const value = argument.slice(longName.length + 1)
  if (value === '') throw new CliUsageError(`${longName} requires a value`)
  return { value, nextIndex: index }
}

function helpFlagPresent(args: readonly string[]): boolean {
  for (const argument of args) {
    if (argument === '--') return false
    if (argument === '-h' || argument === '--help') return true
  }
  return false
}

function leadingCommand(args: readonly string[]): { name: typeof COMMANDS[number]; index: number } | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') return undefined
    const patch = valueOption(args, index, ['--patch'])
    if (patch !== undefined) {
      index = patch.nextIndex
      continue
    }
    if (argument !== undefined && (COMMANDS as readonly string[]).includes(argument)) {
      return { name: argument as typeof COMMANDS[number], index }
    }
    return undefined
  }
  return undefined
}

function helpTopic(value: string): CliHelpTopic {
  if ((HELP_TOPICS as readonly string[]).includes(value)) return value as CliHelpTopic
  const candidate = closest(value, HELP_TOPICS)
  throw new CliUsageError(
    `unknown help topic: ${value}`,
    candidate === undefined ? undefined : `Did you mean "dscode help ${candidate}"?`,
  )
}

function parseExplicitHelp(args: readonly string[]): CliInvocation | undefined {
  const command = leadingCommand(args)
  if (command?.name === 'help') {
    const values = args.slice(command.index + 1)
    if (values.length > 1) throw new CliUsageError('help accepts at most one command name')
    return values[0] === undefined ? { kind: 'help' } : { kind: 'help', topic: helpTopic(values[0]) }
  }
  if (!helpFlagPresent(args)) return undefined
  if (command !== undefined) {
    return { kind: 'help', topic: command.name as CliHelpTopic }
  }
  return { kind: 'help' }
}

function parseVersion(args: readonly string[]): CliInvocation | undefined {
  let flag: typeof VERSION_FLAGS[number] | undefined
  for (const argument of args) {
    if (argument === '--') break
    if ((VERSION_FLAGS as readonly string[]).includes(argument)) {
      flag = argument as typeof VERSION_FLAGS[number]
      break
    }
  }
  if (flag === undefined) return undefined
  if (args.length !== 1) throw new CliUsageError(`${flag} cannot be combined with other arguments`)
  return { kind: 'version' }
}

function parseDoctor(args: readonly string[], commandIndex: number): CliInvocation {
  let json = false
  for (let index = 0; index < args.length; index += 1) {
    if (index === commandIndex) continue
    const argument = args[index]
    if (argument === '--json') {
      json = true
      continue
    }
    if (argument?.startsWith('-')) unknownOption(argument)
    throw new CliUsageError(`doctor does not accept argument: ${String(argument)}`)
  }
  return { kind: 'doctor', json }
}

function parseCompletion(args: readonly string[], commandIndex: number): CliInvocation {
  const values = args.filter((_, index) => index !== commandIndex && args[index] !== '--')
  const shell = values[0]
  if (shell === undefined) throw new CliUsageError('completion requires a shell: bash, zsh, fish, or powershell')
  if (values.length > 1) throw new CliUsageError('completion accepts exactly one shell')
  if (!(COMPLETION_SHELLS as readonly string[]).includes(shell)) {
    const candidate = closest(shell, COMPLETION_SHELLS)
    throw new CliUsageError(
      `unsupported completion shell: ${shell}`,
      candidate === undefined ? undefined : `Did you mean ${candidate}?`,
    )
  }
  return { kind: 'completion', shell: shell as CompletionShell }
}

function parseConfig(args: readonly string[], commandIndex: number): CliInvocation {
  const patches: string[] = []
  let defaults = false
  let modeSeen = false
  for (let index = 0; index < args.length; index += 1) {
    if (index === commandIndex) continue
    const patch = valueOption(args, index, ['--patch'])
    if (patch !== undefined) {
      patches.push(patch.value)
      index = patch.nextIndex
      continue
    }
    const argument = args[index]
    if (argument === 'show') {
      if (modeSeen) throw new CliUsageError('config accepts only one of "show" or "default"')
      modeSeen = true
      continue
    }
    if (argument === 'default') {
      if (modeSeen) throw new CliUsageError('config accepts only one of "show" or "default"')
      defaults = true
      modeSeen = true
      continue
    }
    if (argument?.startsWith('-')) unknownOption(argument)
    throw new CliUsageError(`unknown config action: ${String(argument)}`)
  }
  if (defaults && patches.length > 0) {
    throw new CliUsageError('config default cannot be combined with --patch')
  }
  return { kind: 'config', defaults, patches }
}

function parsePlugin(args: readonly string[], commandIndex: number): CliInvocation {
  if (commandIndex !== 0) throw new CliUsageError('plugin must appear before its forwarded arguments')
  const forwarded = args.slice(1)
  const pluginArgs = forwarded[0] === '--' ? forwarded.slice(1) : forwarded
  if (pluginArgs.length === 0) throw new CliUsageError('plugin requires pnpm arguments, for example: plugin list')
  return { kind: 'plugin', args: pluginArgs }
}

function parseExec(args: readonly string[], commandIndex: number): CliInvocation {
  const patches: string[] = []
  const prompt: string[] = []
  let cwd: string | undefined
  let options = true
  for (let index = 0; index < args.length; index += 1) {
    if (index === commandIndex) continue
    const argument = args[index]
    if (options && argument === '--') {
      options = false
      continue
    }
    if (options) {
      const patch = valueOption(args, index, ['--patch'])
      if (patch !== undefined) {
        patches.push(patch.value)
        index = patch.nextIndex
        continue
      }
      const directory = valueOption(args, index, ['-C', '--cwd'])
      if (directory !== undefined) {
        cwd = directory.value
        index = directory.nextIndex
        continue
      }
      if (argument?.startsWith('-')) unknownOption(argument)
    }
    if (argument !== undefined) prompt.push(argument)
  }
  return {
    kind: 'exec',
    patches,
    ...cwd === undefined ? {} : { cwd },
    ...prompt.length === 0 ? {} : { prompt: prompt.join(' ') },
  }
}

function parseSessions(args: readonly string[], commandIndex: number): SessionListInvocation {
  const patches: string[] = []
  let json = false
  let listSeen = false
  for (let index = 0; index < args.length; index += 1) {
    if (index === commandIndex) continue
    const argument = args[index]
    const patch = valueOption(args, index, ['--patch'])
    if (patch !== undefined) {
      patches.push(patch.value)
      index = patch.nextIndex
      continue
    }
    if (argument === 'list' && !listSeen) {
      listSeen = true
      continue
    }
    if (argument === '--json') {
      json = true
      continue
    }
    if (argument?.startsWith('-')) unknownOption(argument)
    throw new CliUsageError(`sessions only supports the "list" action, got: ${String(argument)}`)
  }
  return { kind: 'sessions', json, patches }
}

function parseInteractive(
  args: readonly string[],
  base: Config,
  command: ReturnType<typeof leadingCommand>,
): TuiInteractiveInvocation {
  const config: Config = { ...base }
  const patches: string[] = []
  const imagePaths: string[] = []
  const positionals: string[] = []
  let resumeFlag: string | undefined
  let resumeLast = false
  let cwdProvided = false
  let model: string | undefined
  let reasoningEffort: string | undefined
  let permissionMode: string | undefined
  let plan = false
  let options = true

  for (let index = 0; index < args.length; index += 1) {
    if (index === command?.index) continue
    const argument = args[index]
    if (options && argument === '--') {
      options = false
      continue
    }
    if (options) {
      const patch = valueOption(args, index, ['--patch'])
      if (patch !== undefined) {
        patches.push(patch.value)
        index = patch.nextIndex
        continue
      }
      const resume = valueOption(args, index, ['--resume'])
      if (resume !== undefined) {
        if (resumeFlag !== undefined) throw new CliUsageError('--resume may only be provided once')
        resumeFlag = resume.value
        index = resume.nextIndex
        continue
      }
      const directory = valueOption(args, index, ['-C', '--cwd'])
      if (directory !== undefined) {
        config.cwd = directory.value
        cwdProvided = true
        index = directory.nextIndex
        continue
      }
      const image = valueOption(args, index, ['-i', '--image'])
      if (image !== undefined) {
        imagePaths.push(image.value)
        index = image.nextIndex
        continue
      }
      const selectedModel = valueOption(args, index, ['-m', '--model'])
      if (selectedModel !== undefined) {
        model = selectedModel.value
        index = selectedModel.nextIndex
        continue
      }
      const effort = valueOption(args, index, ['--effort'])
      if (effort !== undefined) {
        reasoningEffort = effort.value
        index = effort.nextIndex
        continue
      }
      const permission = valueOption(args, index, ['--permission-mode'])
      if (permission !== undefined) {
        permissionMode = permission.value
        index = permission.nextIndex
        continue
      }
      if (argument === '--last') {
        resumeLast = true
        continue
      }
      if (argument === '--plan') {
        plan = true
        continue
      }
      if (argument === '--no-color') {
        config.color = false
        continue
      }
      if (argument?.startsWith('-')) unknownOption(argument)
    }
    if (argument !== undefined) positionals.push(argument)
  }

  const resumeCommand = command?.name === 'resume'
  if (resumeLast && !resumeCommand) throw new CliUsageError('--last is only valid with the resume command')
  if (resumeCommand && resumeFlag !== undefined) {
    throw new CliUsageError('resume <session-id> cannot be combined with --resume')
  }

  let resume: ResumeTarget | undefined
  if (resumeCommand) {
    if (resumeLast) {
      resume = { kind: 'last' }
    } else {
      const sessionId = positionals.shift()
      if (sessionId === undefined) throw new CliUsageError('resume requires a session id or --last')
      resume = { kind: 'session', sessionId }
    }
  } else if (resumeFlag !== undefined) {
    resume = { kind: 'session', sessionId: resumeFlag }
  } else if (base.sessionId !== undefined) {
    resume = { kind: 'session', sessionId: base.sessionId }
  }
  if (resume !== undefined && cwdProvided) {
    throw new CliUsageError('--cwd cannot be combined with resume because a session keeps its original workspace')
  }

  return {
    kind: 'interactive',
    config,
    patches,
    startup: {
      imagePaths,
      plan,
      ...resume === undefined ? {} : { resume },
      ...positionals.length === 0 ? {} : { prompt: positionals.join(' ') },
      ...model === undefined ? {} : { model },
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      ...permissionMode === undefined ? {} : { permissionMode },
    },
  }
}

/** Parse the complete public CLI into one side-effect-free action. */
export function parseCliArgs(args: readonly string[], base: Config = {}): CliInvocation {
  const help = parseExplicitHelp(args)
  if (help !== undefined) return help
  const version = parseVersion(args)
  if (version !== undefined) return version

  const command = leadingCommand(args)
  switch (command?.name) {
    case 'doctor': return parseDoctor(args, command.index)
    case 'completion': return parseCompletion(args, command.index)
    case 'config': return parseConfig(args, command.index)
    case 'plugin': return parsePlugin(args, command.index)
    case 'exec': return parseExec(args, command.index)
    case 'sessions': return parseSessions(args, command.index)
    case 'help': throw new CliUsageError('help parsing did not resolve a help action')
    default: return parseInteractive(args, base, command)
  }
}

/** Canonical app arguments forwarded after dsh has consumed profile overlays. */
export function tuiAppArgs(invocation: TuiProfileInvocation): string[] {
  if (invocation.kind === 'sessions') return ['sessions', ...(invocation.json ? ['--json'] : [])]

  const { config, startup } = invocation
  const args: string[] = []
  if (startup.resume?.kind === 'last') args.push('resume', '--last')
  if (startup.resume?.kind === 'session') args.push('--resume', startup.resume.sessionId)
  if (config.cwd !== undefined) args.push('--cwd', config.cwd)
  if (config.color === false) args.push('--no-color')
  for (const path of startup.imagePaths) args.push('--image', path)
  if (startup.model !== undefined) args.push('--model', startup.model)
  if (startup.reasoningEffort !== undefined) args.push('--effort', startup.reasoningEffort)
  if (startup.permissionMode !== undefined) args.push('--permission-mode', startup.permissionMode)
  if (startup.plan) args.push('--plan')
  if (startup.prompt !== undefined) args.push('--', startup.prompt)
  return args
}

export { formatCliError, renderCliHelp, renderCliVersion, renderCompletion } from './cli-output.ts'

import type { SessionSummary } from '@deepseek-ai/dsh-host-apiproxy'

type SessionId = SessionSummary['sessionId']

/** Toolkit-neutral command metadata used by help and autocomplete surfaces. */
export interface TerminalCommandDescriptor {
  name: string
  description: string
  argumentHint?: string
}

/** TUI-owned command with aliases and a local interaction handler. */
export interface TerminalCommandDefinition extends TerminalCommandDescriptor {
  aliases?: readonly string[]
  handler(argument: string): void | Promise<void>
}

export interface HostCommandResult {
  kind: 'success' | 'error'
  text?: string
  sourceEventSeq?: number
}

/** Bare-invocation UI attached to an existing Host command. */
export interface TerminalCommandDecoration {
  name: string
  handler(): void | Promise<void>
}

/** Host-backed command discovery and execution without leaking Cordis into the application. */
export interface HostCommandSource {
  list(sessionId: SessionId | undefined): readonly TerminalCommandDescriptor[]
  execute(sessionId: SessionId, line: string, signal: AbortSignal): Promise<HostCommandResult | undefined>
  subscribe(listener: () => void): () => void
}

function parseCommand(text: string): { name: string; argument: string } | undefined {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)
  if (match === null || match[1] === undefined) return undefined
  return {
    name: match[1].toLowerCase(),
    argument: match[2]?.trim() ?? '',
  }
}

function descriptorKey(descriptor: TerminalCommandDescriptor): string {
  return [descriptor.name, descriptor.description, descriptor.argumentHint ?? ''].join('\u0000')
}

/**
 * One command directory for local interaction commands and agent-scoped Host
 * commands. Rendering libraries consume its plain descriptors; resolved Host
 * commands execute through the Host port and never fall through to the model.
 */
export class TerminalCommandDirectory {
  private readonly localByName = new Map<string, TerminalCommandDefinition>()
  private readonly decorations = new Map<string, TerminalCommandDecoration>()
  private readonly executions = new Set<AbortController>()
  private readonly removeHostListener: () => void
  private sessionId: SessionId | undefined
  private host: TerminalCommandDescriptor[] = []
  private signature = ''

  constructor(
    private readonly local: readonly TerminalCommandDefinition[],
    private readonly source?: HostCommandSource,
    private readonly onChange: () => void = () => {},
    decorations: readonly TerminalCommandDecoration[] = [],
  ) {
    for (const definition of local) {
      this.localByName.set(definition.name, definition)
      for (const alias of definition.aliases ?? []) this.localByName.set(alias, definition)
    }
    for (const decoration of decorations) this.decorations.set(decoration.name.toLowerCase(), decoration)
    this.removeHostListener = source?.subscribe(() => {
      if (this.refreshHost()) this.onChange()
    }) ?? (() => {})
    this.refreshHost()
  }

  /** Effective discovery rows, with TUI-local commands shadowing Host names. */
  get descriptors(): readonly TerminalCommandDescriptor[] {
    const localNames = new Set(this.localByName.keys())
    return [
      ...this.local.map(command => ({
        name: command.name,
        description: command.description,
        ...command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint },
      })),
      ...this.host.filter(command => !localNames.has(command.name)),
    ]
  }

  /** Every effective dispatch name, including local aliases hidden from discovery rows. */
  get resolutionNames(): readonly string[] {
    return [...new Set([
      ...this.localByName.keys(),
      ...this.host.map(command => command.name),
    ])]
  }

  has(name: string): boolean {
    return this.resolutionNames.includes(name.toLowerCase())
  }

  /** Refresh the agent-scoped Host view when the active session changes. */
  setSession(sessionId: SessionId | undefined): boolean {
    if (sessionId === this.sessionId) return false
    this.abortExecutions()
    this.sessionId = sessionId
    return this.refreshHost()
  }

  /** Dispatch a local interaction or a resolved Host command. */
  async dispatch(text: string): Promise<boolean> {
    const parsed = parseCommand(text)
    if (parsed === undefined) return false
    const command = this.localByName.get(parsed.name)
    if (command !== undefined) {
      await command.handler(parsed.argument)
      return true
    }
    if (!this.host.some(candidate => candidate.name === parsed.name)) return false
    const decoration = this.decorations.get(parsed.name)
    if (parsed.argument === '' && decoration !== undefined) {
      await decoration.handler()
      return true
    }
    await this.dispatchHost(text)
    return true
  }

  /** Execute an already selected Host command without re-entering local dispatch. */
  async dispatchHost(text: string): Promise<void> {
    const parsed = parseCommand(text)
    if (parsed === undefined) throw new Error('Host command must be one complete slash-command line')
    if (!this.host.some(candidate => candidate.name === parsed.name)) {
      throw new Error(`Host command "/${parsed.name}" is unavailable in this session`)
    }
    const sessionId = this.sessionId
    if (sessionId === undefined || this.source === undefined) {
      throw new Error(`Host command "/${parsed.name}" cannot execute without an active session`)
    }
    const abort = new AbortController()
    this.executions.add(abort)
    let result: HostCommandResult | undefined
    try {
      result = await this.source.execute(sessionId, text, abort.signal)
    } finally {
      this.executions.delete(abort)
    }
    if (result === undefined) {
      throw new Error(`Host command "/${parsed.name}" changed before it could execute`)
    }
    if (result.kind === 'error') throw new Error(result.text ?? `Host command "/${parsed.name}" failed`)
  }

  /** Complete help content generated from the same effective discovery rows. */
  helpText(): string {
    return this.descriptors.map((command) => {
      const argument = command.argumentHint === undefined ? '' : ` ${command.argumentHint}`
      return `/${command.name}${argument} · ${command.description}`
    }).join('\n')
  }

  dispose(): void {
    this.abortExecutions()
    this.removeHostListener()
  }

  private abortExecutions(): void {
    for (const execution of this.executions) execution.abort(new Error('Host command session changed'))
    this.executions.clear()
  }

  private refreshHost(): boolean {
    const next = [...(this.source?.list(this.sessionId) ?? [])]
      .map(command => ({
        name: command.name.toLowerCase(),
        description: command.description,
        ...command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint },
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
    const signature = next.map(descriptorKey).join('\u0001')
    if (signature === this.signature) return false
    this.host = next
    this.signature = signature
    return true
  }
}

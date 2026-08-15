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

/** Host-backed command discovery without coupling the TUI to Cordis. */
export interface HostCommandSource {
  list(sessionId: SessionId | undefined): readonly TerminalCommandDescriptor[]
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
 * commands. Rendering libraries consume its plain descriptors; only local
 * definitions execute here, while unresolved slash input continues to Host.
 */
export class TerminalCommandDirectory {
  private readonly localByName = new Map<string, TerminalCommandDefinition>()
  private readonly removeHostListener: () => void
  private sessionId: SessionId | undefined
  private host: TerminalCommandDescriptor[] = []
  private signature = ''

  constructor(
    private readonly local: readonly TerminalCommandDefinition[],
    private readonly source?: HostCommandSource,
    private readonly onChange: () => void = () => {},
  ) {
    for (const definition of local) {
      this.localByName.set(definition.name, definition)
      for (const alias of definition.aliases ?? []) this.localByName.set(alias, definition)
    }
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

  /** Refresh the agent-scoped Host view when the active session changes. */
  setSession(sessionId: SessionId | undefined): boolean {
    if (sessionId === this.sessionId) return false
    this.sessionId = sessionId
    return this.refreshHost()
  }

  /** Dispatch a TUI-local command; return false so Host can resolve the rest. */
  async dispatch(text: string): Promise<boolean> {
    const parsed = parseCommand(text)
    if (parsed === undefined) return false
    const command = this.localByName.get(parsed.name)
    if (command === undefined) return false
    await command.handler(parsed.argument)
    return true
  }

  /** Complete help content generated from the same effective discovery rows. */
  helpText(): string {
    return this.descriptors.map((command) => {
      const argument = command.argumentHint === undefined ? '' : ` ${command.argumentHint}`
      return `/${command.name}${argument} · ${command.description}`
    }).join('\n')
  }

  dispose(): void {
    this.removeHostListener()
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

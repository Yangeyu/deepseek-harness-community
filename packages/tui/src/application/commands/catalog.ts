import type { SkillEntry } from '../../runtime/session/contracts.ts'
import type { SlashCandidate, SlashResolution, TerminalCommandDescriptor } from './contracts.ts'

function normalizedName(name: string): string {
  return name.trim().replace(/^\//, '').toLowerCase()
}

/** Parse a complete command line for execution, without accepting leading whitespace. */
export function parseCommand(text: string): { name: string; argument: string } | undefined {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)
  if (match === null || match[1] === undefined) return undefined
  return {
    name: match[1].toLowerCase(),
    argument: match[2]?.trim() ?? '',
  }
}

/** Merge discovery rows while preserving Harness command-over-Skill precedence. */
export function mergeSlashCatalog(
  commands: readonly TerminalCommandDescriptor[],
  skills: readonly SkillEntry[],
  commandResolutionNames: readonly string[] = commands.map(command => command.name),
): readonly SlashCandidate[] {
  const commandNames = new Set(commandResolutionNames.map(normalizedName))
  const commandRows: SlashCandidate[] = commands.map(command => ({
    kind: 'command',
    ...command,
    name: normalizedName(command.name),
  }))
  const skillRows: SlashCandidate[] = skills
    .filter(skill => !commandNames.has(normalizedName(skill.name)))
    .map(skill => ({ kind: 'skill' as const, ...skill, name: normalizedName(skill.name) }))
    .sort((left, right) => left.name.localeCompare(right.name))
  return [...commandRows, ...skillRows]
}

/** Resolve only a leading slash gesture; ordinary prompt text is untouched. */
export function resolveLeadingSlash(
  text: string,
  candidates: readonly SlashCandidate[],
): SlashResolution {
  // Unlike complete command execution, prompt admission permits leading whitespace
  // but excludes paths: a Unix absolute path must remain ordinary model input.
  const match = /^\s*\/([^\s/]+)(?=\s|$)/.exec(text)
  const token = match?.[1]
  if (token === undefined) return { kind: 'none' }
  const name = normalizedName(token)
  const candidate = candidates.find(row => row.name === name)
  if (candidate === undefined) return { kind: 'unknown', name }
  return candidate.kind === 'command'
    ? { kind: 'command', candidate }
    : { kind: 'skill', candidate }
}

/** Plain command rows consumed by pi-tui's autocomplete provider. */
export function slashAutocompleteRows(candidates: readonly SlashCandidate[]): TerminalCommandDescriptor[] {
  return candidates.map(candidate => candidate.kind === 'command'
    ? {
        name: candidate.name,
        description: candidate.description,
        ...candidate.argumentHint === undefined ? {} : { argumentHint: candidate.argumentHint },
      }
    : {
        name: candidate.name,
        description: `Skill · ${candidate.description}`,
        argumentHint: '[request]',
      })
}

/** Shared row formatting for directory help and contextual grouped help. */
export function commandHelpLine(command: TerminalCommandDescriptor): string {
  const argument = command.argumentHint === undefined ? '' : ` ${command.argumentHint}`
  return `/${command.name}${argument} · ${command.description}`
}

/** Grouped help generated from the same effective Slash candidates as autocomplete. */
export function slashHelpText(candidates: readonly SlashCandidate[]): string {
  const commands = candidates.filter((candidate): candidate is Extract<SlashCandidate, { kind: 'command' }> =>
    candidate.kind === 'command')
  const skills = candidates.filter((candidate): candidate is Extract<SlashCandidate, { kind: 'skill' }> =>
    candidate.kind === 'skill')
  return [
    'Commands',
    ...commands.map(commandHelpLine),
    ...skills.length === 0 ? [] : [
      '',
      'Skills',
      ...skills.map(skill => commandHelpLine({ ...skill, argumentHint: '[request]' })),
    ],
  ].join('\n')
}

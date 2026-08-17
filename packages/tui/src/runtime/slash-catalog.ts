import type { SkillEntry } from '@deepseek-ai/dsh-host-apiproxy'
import type { TerminalCommandDescriptor } from './commands.ts'

export type SlashCandidate =
  | ({ kind: 'command' } & TerminalCommandDescriptor)
  | ({ kind: 'skill' } & SkillEntry)

export type SlashResolution =
  | { kind: 'none' }
  | { kind: 'command'; candidate: Extract<SlashCandidate, { kind: 'command' }> }
  | { kind: 'skill'; candidate: Extract<SlashCandidate, { kind: 'skill' }> }
  | { kind: 'unknown'; name: string }

function normalizedName(name: string): string {
  return name.trim().replace(/^\//, '').toLowerCase()
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
  // Commands and Skills are one path-free name. A Unix absolute path shares
  // the leading slash but is ordinary prompt text, not an unknown command.
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

/** Grouped help generated from the same effective Slash candidates as autocomplete. */
export function slashHelpText(candidates: readonly SlashCandidate[]): string {
  const commands = candidates.filter((candidate): candidate is Extract<SlashCandidate, { kind: 'command' }> =>
    candidate.kind === 'command')
  const skills = candidates.filter((candidate): candidate is Extract<SlashCandidate, { kind: 'skill' }> =>
    candidate.kind === 'skill')
  return [
    'Commands',
    ...commands.map((command) => {
      const argument = command.argumentHint === undefined ? '' : ` ${command.argumentHint}`
      return `/${command.name}${argument} · ${command.description}`
    }),
    ...skills.length === 0 ? [] : [
      '',
      'Skills',
      ...skills.map(skill => `/${skill.name} [request] · ${skill.description}`),
    ],
  ].join('\n')
}

import type { TerminalCommandDefinition } from '../contracts.ts'

export function createSkillsCommand(skills: { open(): void }): TerminalCommandDefinition {
  return {
    name: 'skills',
    description: 'Browse and author reusable Skills',
    handler: () => { skills.open() },
  }
}

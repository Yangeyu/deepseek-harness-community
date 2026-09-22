import type { TerminalCommandDefinition } from '../contracts.ts'

export function createAttachCommand(composer: { attachPath(path: string): Promise<unknown> }): TerminalCommandDefinition {
  return {
    name: 'attach',
    description: 'Attach an image file to the next message',
    argumentHint: '<path>',
    async handler(argument) {
      if (argument.trim() === '') throw new Error('Usage: /attach <path>')
      await composer.attachPath(argument.trim())
    },
  }
}

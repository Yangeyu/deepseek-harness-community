import type { TerminalCommandDefinition } from '../contracts.ts'

export function createPasteImageCommand(composer: { pasteImage(): Promise<void> }): TerminalCommandDefinition {
  return {
    name: 'paste-image',
    description: 'Attach the image currently on the clipboard',
    handler: () => composer.pasteImage(),
  }
}

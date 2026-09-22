import type { TerminalCommandDefinition } from '../contracts.ts'

export function createModelCommand(configuration: {
  openModelSelector(): Promise<void>
  selectNamedModel(model: string): Promise<void>
}): TerminalCommandDefinition {
  return {
    name: 'model',
    description: 'Select model and provider',
    argumentHint: '[provider/model]',
    handler: argument => argument === ''
      ? configuration.openModelSelector()
      : configuration.selectNamedModel(argument),
  }
}

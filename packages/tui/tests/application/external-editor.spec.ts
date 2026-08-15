import { describe, expect, it } from 'vitest'
import { externalEditorCommand } from '../../src/application/external-editor.ts'

describe('externalEditorCommand', () => {
  it('prefers VISUAL, then EDITOR, while ignoring blank values', () => {
    expect(externalEditorCommand({ VISUAL: 'code --wait', EDITOR: 'vim' })).toEqual({
      command: 'code --wait',
      source: 'VISUAL',
    })
    expect(externalEditorCommand({ VISUAL: ' ', EDITOR: 'nvim' })).toEqual({
      command: 'nvim',
      source: 'EDITOR',
    })
    expect(externalEditorCommand({})).toBeUndefined()
  })
})

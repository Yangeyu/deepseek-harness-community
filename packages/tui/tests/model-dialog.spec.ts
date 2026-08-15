import { describe, expect, it, vi } from 'vitest'
import type { ModelSelection, SessionModels } from '@deepseek-ai/dsh-host-apiproxy'
import { ModelDialog } from '../src/dialogs.ts'
import { createTheme } from '../src/theme.ts'

const models: SessionModels = {
  current: { provider: 'deepseek', model: 'flash', reasoningEffort: 'medium' },
  routable: true,
  groups: [{
    id: 'deepseek',
    name: 'DeepSeek',
    models: [
      { id: 'flash', name: 'V4 Flash', description: 'Fast everyday model' },
      {
        id: 'pro',
        name: 'V4 Pro',
        description: 'Complex coding tasks',
        reasoning: {
          defaultEffort: 'medium',
          efforts: [
            { id: 'medium', name: 'Medium' },
            { id: 'high', name: 'High' },
          ],
        },
      },
    ],
  }],
  failures: [],
}

describe('ModelDialog', () => {
  it('moves from a compact model list to a separate effort step', () => {
    const selected = vi.fn<(selection: ModelSelection) => void>()
    const dialog = new ModelDialog(models, createTheme(false), selected, vi.fn())

    expect(dialog.render(120).join('\n')).toContain('1. V4 Flash (current)')
    dialog.handleInput('\u001b[B')
    dialog.handleInput('\r')
    expect(dialog.render(120).join('\n')).toContain('Select Reasoning Effort')
    expect(selected).not.toHaveBeenCalled()

    dialog.handleInput('\u001b[B')
    expect(dialog.render(120).join('\n')).toContain('2. High')
    dialog.handleInput('\r')

    expect(selected).toHaveBeenCalledWith({
      provider: 'deepseek',
      model: 'pro',
      reasoningEffort: 'high',
    })
  })
})

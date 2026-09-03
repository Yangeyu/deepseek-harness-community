import { describe, expect, it, vi } from 'vitest'
import type { ModelSelection, SessionModels } from '@deepseek-ai/dsh-host-apiproxy'
import { ModelDialog } from '../../../../src/modules/configuration/view/model-dialog.ts'
import { createTheme } from '../../../../src/presentation/primitives/theme.ts'

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
    const dialog = new ModelDialog(models, () => 24, createTheme(false), selected, vi.fn())

    expect(dialog.render(120).join('\n')).toContain('1. V4 Flash (current)')
    dialog.handleAction('surface.next')
    dialog.handleAction('surface.confirm')
    expect(dialog.render(120).join('\n')).toContain('Select Reasoning Effort')
    expect(selected).not.toHaveBeenCalled()

    dialog.handleAction('surface.next')
    expect(dialog.render(120).join('\n')).toContain('2. High')
    dialog.handleAction('surface.confirm')

    expect(selected).toHaveBeenCalledWith({
      provider: 'deepseek',
      model: 'pro',
      reasoningEffort: 'high',
    })
  })

  it('keeps the selected model visible without exceeding a 24-row terminal', () => {
    const manyModels: SessionModels = {
      ...models,
      current: { provider: 'deepseek', model: 'model-1' },
      groups: [{
        id: 'deepseek',
        name: 'DeepSeek',
        models: Array.from({ length: 40 }, (_, index) => ({
          id: `model-${String(index + 1)}`,
          name: `Model ${String(index + 1)}`,
        })),
      }],
    }
    const dialog = new ModelDialog(manyModels, () => 24, createTheme(false), vi.fn(), vi.fn())

    for (let index = 0; index < 30; index += 1) dialog.handleAction('surface.next')
    const rendered = dialog.render(80)

    expect(rendered.length).toBeLessThanOrEqual(24)
    expect(rendered.join('\n')).toContain('› 31. Model 31')
    expect(rendered.join('\n')).toContain('/40')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { KeymapView } from '../../src/presentation/config/keymap-view.ts'
import { createTheme } from '../../src/presentation/theme.ts'

describe('KeymapView', () => {
  it('shows bindings and supports vim navigation', () => {
    const onPreset = vi.fn()
    const view = new KeymapView('standard', createTheme(false), onPreset, vi.fn())

    expect(view.render(80).join('\n')).toContain('Tab                  Queue next message')
    view.handleInput('j')
    expect(view.render(80).join('\n')).toContain('› Legacy')
    expect(view.render(80).join('\n')).toContain('Alt+Enter')
    view.handleInput('\r')

    expect(onPreset).toHaveBeenCalledWith('legacy')
  })

  it('updates the current marker after a persisted setting changes', () => {
    const view = new KeymapView('standard', createTheme(false), vi.fn(), vi.fn())
    view.setPreset('legacy')

    expect(view.render(80).join('\n')).toContain('Legacy (current)')
  })
})

import { Text, type Component } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { ComposerAnchoredLayout } from '../../../../src/presentation/shell/layout/composer-layout.ts'
import { SurfaceHost } from '../../../../src/presentation/shell/surfaces/surface-host.ts'
import { LifecycleScope } from '../../../../src/runtime/lifecycle/scope.ts'
import type { SurfaceInputAction } from '../../../../src/presentation/primitives/surface-input.ts'

function fixture() {
  const editor = new Text('editor', 0, 0)
  let focused: Component | null = editor
  const layout = new ComposerAnchoredLayout(
    new Text('header', 0, 0),
    new Text('transcript', 0, 0),
    new Text('status', 0, 0),
    editor,
    new Text('footer', 0, 0),
    () => 24,
  )
  const screen = {
    getFocusedComponent: () => focused,
    setFocus: vi.fn((component: Component | null) => { focused = component }),
  }
  const invalidate = vi.fn()
  const scope = new LifecycleScope('surfaces')
  return { editor, layout, screen, invalidate, scope, host: new SurfaceHost(layout, screen, invalidate, scope) }
}

describe('SurfaceHost', () => {
  it('restores the previous live surface and then the captured base focus', () => {
    const { editor, layout, screen, host } = fixture()
    const first = new Text('first', 0, 0)
    const second = new Text('second', 0, 0)

    const firstHandle = host.open({ placement: 'readable', component: first })
    const secondHandle = host.open({ placement: 'workspace', component: second })
    expect(layout.render(80).join('\n')).toContain('second')

    expect(secondHandle.close()).toBe(true)
    expect(layout.render(80).join('\n')).toContain('first')
    expect(screen.setFocus).toHaveBeenLastCalledWith(first)

    expect(firstHandle.close()).toBe(true)
    expect(screen.setFocus).toHaveBeenLastCalledWith(editor)
    expect(host.active).toBe(false)
  })

  it('does not let an obsolete handle close or replace a newer surface', () => {
    const { layout, host } = fixture()
    const first = host.open({ placement: 'readable', component: new Text('first', 0, 0) })
    const second = host.open({ placement: 'readable', component: new Text('second', 0, 0) })

    expect(first.close()).toBe(true)
    expect(first.close()).toBe(false)
    expect(first.replace({ placement: 'readable', component: new Text('stale', 0, 0) })).toBe(false)
    expect(layout.render(80).join('\n')).toContain('second')
    expect(second.active).toBe(true)
  })

  it('clears the visible surface when its owner scope retires', async () => {
    const { layout, scope, host } = fixture()
    host.open({ placement: 'readable', component: new Text('surface', 0, 0) })

    await scope.dispose()

    expect(host.active).toBe(false)
    expect(layout.render(80).join('\n')).not.toContain('surface')
    expect(() => host.open({ placement: 'readable', component: new Text('late', 0, 0) })).toThrow('inactive SurfaceHost')
  })

  it('dispatches semantic input only to the focused top Surface', () => {
    const { host } = fixture()
    const actions: SurfaceInputAction[] = []
    const target = {
      inputContext: 'menu' as const,
      handleAction: (action: SurfaceInputAction) => { actions.push(action) },
      invalidate: () => {},
      render: () => ['menu'],
    }
    host.open({ placement: 'readable', component: target })

    expect(host.inputContext).toBe('menu')
    expect(host.dispatchInput('surface.next')).toBe(true)
    expect(actions).toEqual(['surface.next'])
  })

  it('routes paging to the shared Surface viewport after the feature receives the semantic action', () => {
    const { host, layout } = fixture()
    const actions: SurfaceInputAction[] = []
    const target = {
      inputContext: 'menu' as const,
      handleAction: (action: SurfaceInputAction) => { actions.push(action) },
      invalidate: () => {},
      render: () => Array.from({ length: 40 }, (_, index) => `row ${String(index + 1)}`),
    }
    host.open({ placement: 'readable', component: target })
    layout.render(80)

    expect(host.dispatchInput('surface.page-next')).toBe(true)
    expect(actions).toEqual(['surface.page-next'])
    expect(layout.render(80).map(line => line.trim()).join('\n')).toContain('row 24')
    expect(layout.render(80).map(line => line.trim()).join('\n')).not.toMatch(/\brow 1\b/u)
  })
})

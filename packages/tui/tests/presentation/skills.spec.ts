import type { SkillCatalogSnapshot } from '../../src/runtime/skill-catalog.ts'
import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { SkillsView } from '../../src/presentation/skills.ts'
import { createTheme } from '../../src/presentation/theme.ts'

const snapshot: SkillCatalogSnapshot = {
  sessionId: 'session-skills' as never,
  status: 'ready',
  entries: [
    { name: 'release', description: 'Verify and publish', whenToUse: 'After checks pass', modelInvocable: false },
    { name: 'review', description: 'Review current changes', modelInvocable: true },
  ],
}

describe('SkillsView', () => {
  it('supports vim navigation and inserts the selected canonical gesture', () => {
    const invoke = vi.fn()
    const view = new SkillsView(snapshot, createTheme(false), () => 24, invoke, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn())

    view.handleInput('j')
    view.handleInput('\r')
    expect(invoke).toHaveBeenCalledWith('review')
  })

  it('filters name, description, and when-to-use text', () => {
    const view = new SkillsView(snapshot, createTheme(false), () => 24, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn())

    view.setQuery('checks pass')
    expect(view.render(80).join('\n')).toContain('/release')
    expect(view.render(80).join('\n')).not.toContain('/review')
  })

  it('keeps stale same-session rows visible with an explicit marker', () => {
    const view = new SkillsView({
      ...snapshot,
      status: 'stale',
      error: 'transport failed',
    }, createTheme(false), () => 24, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn())

    expect(view.render(80).join('\n')).toContain('Showing cached Skills · transport failed')
    expect(view.render(80).join('\n')).toContain('/release')
  })

  it('windows long catalogs without hiding the selected tail row', () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({
      name: `skill-${index}`,
      description: `Skill ${index}`,
      modelInvocable: true,
    }))
    const view = new SkillsView({ ...snapshot, entries }, createTheme(false), () => 12, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn())

    view.handleInput('G')
    const rendered = view.render(80).join('\n')
    expect(rendered).toContain('› /skill-19')
    expect(rendered).toContain('more above')
    expect(rendered.split('\n').length).toBeLessThanOrEqual(12)
  })

  it('bounds every rendered row in narrow terminals', () => {
    const view = new SkillsView(snapshot, createTheme(false), () => 16, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn())

    expect(view.render(40).every(line => visibleWidth(line) <= 40)).toBe(true)
    view.handleInput('l')
    expect(view.render(40).every(line => visibleWidth(line) <= 40)).toBe(true)
  })
})

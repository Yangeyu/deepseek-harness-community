import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import {
  ComposerFooter,
  footerIdentity,
} from '../../src/presentation/footer.ts'
import { createTheme } from '../../src/presentation/theme.ts'

describe('ComposerFooter', () => {
  it('shows model, working directory, and branch on one identity row', () => {
    expect(footerIdentity(
      'deepseek-official/deepseek-v4-flash · max',
      '/Users/yinfinity/Workplace/deepseek-harness-community',
      'feature/footer-context',
      120,
    )).toBe(
      'deepseek-official/deepseek-v4-flash · max │ deepseek-harness-community · feature/footer-context',
    )
  })

  it('preserves a fixed identity row and prioritizes branch context when narrow', () => {
    const identity = footerIdentity(
      'deepseek-official/deepseek-v4-flash · max',
      '/Users/yinfinity/Workplace/deepseek-harness-community',
      'feature/footer-context',
      48,
    )

    expect(visibleWidth(identity)).toBeLessThanOrEqual(48)
    expect(identity).not.toContain('\n')
    expect(identity).toContain('feature/footer-context')
  })

  it('keeps metrics on the optional second row', () => {
    const footer = new ComposerFooter(createTheme(false))
    footer.setSnapshot({
      model: 'deepseek-official/deepseek-v4-flash · max',
      cwd: '/workspace/project',
      branch: 'main',
      stats: '2 turns · 3 steps',
    })

    const rows = footer.render(80)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('project · main')
    expect(rows[1]).toContain('2 turns · 3 steps')
    expect(rows.every(row => visibleWidth(row) <= 80)).toBe(true)
  })

  it('keeps persistent identity bright and metrics legibly secondary', () => {
    const footer = new ComposerFooter(createTheme(true))
    footer.setSnapshot({
      model: 'deepseek-official/deepseek-v4-flash · max',
      cwd: '/workspace/project',
      branch: 'main',
      stats: '2 turns · 3 steps',
    })

    const [identity, metrics] = footer.render(80)
    expect(identity).not.toContain('\u001b[2m')
    expect(metrics).toContain('\u001b[38;2;148;163;184m')
    expect(metrics).not.toContain('\u001b[2m')
  })
})

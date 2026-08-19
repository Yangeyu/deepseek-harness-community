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
      '',
      120,
    )).toBe(
      'deepseek-official/deepseek-v4-flash · max │ deepseek-harness-community · feature/footer-context',
    )
  })

  it('appends the durable task summary to the same identity row when it fits', () => {
    expect(footerIdentity(
      'deepseek-official/deepseek-v4-flash · max',
      '/Users/yinfinity/Workplace/deepseek-harness-community',
      'feature/footer-context',
      'workspace-write · Goal active 2/8 · Tasks 3/5',
      200,
    )).toBe(
      'deepseek-official/deepseek-v4-flash · max │ deepseek-harness-community · feature/footer-context · workspace-write · Goal active 2/8 · Tasks 3/5',
    )
  })

  it('preserves a fixed identity row and prioritizes branch context when narrow', () => {
    const identity = footerIdentity(
      'deepseek-official/deepseek-v4-flash · max',
      '/Users/yinfinity/Workplace/deepseek-harness-community',
      'feature/footer-context',
      '',
      48,
    )

    expect(visibleWidth(identity)).toBeLessThanOrEqual(48)
    expect(identity).not.toContain('\n')
    expect(identity).toContain('feature/footer-context')
  })

  it('drops the task summary before the workspace label when narrow', () => {
    const identity = footerIdentity(
      'deepseek-official/deepseek-v4-flash · max',
      '/Users/yinfinity/Workplace/deepseek-harness-community',
      'feature/footer-context',
      'workspace-write · Goal active 2/8 · Tasks 3/5',
      48,
    )

    expect(visibleWidth(identity)).toBeLessThanOrEqual(48)
    expect(identity).toContain('feature/footer-context')
    expect(identity).not.toContain('Goal active')
  })

  it('keeps metrics on the optional second row', () => {
    const footer = new ComposerFooter(createTheme(false))
    footer.setSnapshot({
      model: 'deepseek-official/deepseek-v4-flash · max',
      cwd: '/workspace/project',
      branch: 'main',
      task: '',
      stats: '2 turns · 3 steps',
    })

    const rows = footer.render(80)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('project · main')
    expect(rows[1]).toContain('2 turns · 3 steps')
    expect(rows.every(row => visibleWidth(row) <= 80)).toBe(true)
  })

  it('shows the task summary on the persistent identity row', () => {
    const footer = new ComposerFooter(createTheme(false))
    footer.setSnapshot({
      model: 'deepseek-official/deepseek-v4-flash · max',
      cwd: '/workspace/project',
      branch: 'main',
      task: 'workspace-write · Goal active 2/8 · Tasks 3/5',
      stats: '2 turns · 3 steps',
    })

    const rows = footer.render(200)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('project · main · workspace-write · Goal active 2/8 · Tasks 3/5')
    expect(rows[1]).toContain('2 turns · 3 steps')
    expect(rows.every(row => visibleWidth(row) <= 200)).toBe(true)
  })

  it('renders only the identity row when no task summary or metrics exist', () => {
    const footer = new ComposerFooter(createTheme(false))
    footer.setSnapshot({ model: 'm', cwd: '/w', task: '', stats: '' })

    const rows = footer.render(80)
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toContain('·')
  })

  it('keeps persistent identity bright and metrics legibly secondary', () => {
    const footer = new ComposerFooter(createTheme(true))
    footer.setSnapshot({
      model: 'deepseek-official/deepseek-v4-flash · max',
      cwd: '/workspace/project',
      branch: 'main',
      task: '',
      stats: '2 turns · 3 steps',
    })

    const [identity, metrics] = footer.render(80)
    expect(identity).not.toContain('\u001b[2m')
    expect(metrics).toContain('\u001b[38;2;188;198;214m')
    expect(metrics).not.toContain('\u001b[2m')
  })
})
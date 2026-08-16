import { describe, expect, it } from 'vitest'
import { parseTuiArgs, TUI_HELP } from '../../src/application/cli.ts'

describe('TUI command line', () => {
  it('collects repeatable startup images for new and resumed sessions', () => {
    const parsed = parseTuiArgs([
      '--resume', 'session-1',
      '-i', 'first.png',
      '--image=second.webp',
      '--image', 'third.jpg',
    ], { cwd: '/workspace' })

    expect(parsed.config.sessionId).toBe('session-1')
    expect(parsed.imagePaths).toEqual(['first.png', 'second.webp', 'third.jpg'])
  })

  it('rejects missing values without consuming the next option', () => {
    expect(() => parseTuiArgs(['--image', '--no-color'], {})).toThrow('--image requires a value')
    expect(() => parseTuiArgs(['--resume'], {})).toThrow('--resume requires a value')
  })

  it('documents the portable image option', () => {
    expect(TUI_HELP).toContain('-i, --image <path>')
    expect(TUI_HELP).toContain('(repeatable)')
  })
})

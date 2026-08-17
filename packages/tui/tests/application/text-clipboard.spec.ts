import type { Terminal } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { createClipboardTextWriter } from '../../src/application/text-clipboard.ts'

function terminal(): Terminal {
  return { write: vi.fn() } as unknown as Terminal
}

describe('createClipboardTextWriter', () => {
  it('uses the first working native clipboard command', async () => {
    const output = terminal()
    const run = vi.fn(async (command: { executable: string }, text: string) => {
      expect(text).toBe('你好')
      if (command.executable === 'wl-copy') throw new Error('not installed')
    })
    const copy = createClipboardTextWriter(output, { platform: 'linux', run })

    await copy('你好')

    expect(run.mock.calls.map(([command]) => command.executable)).toEqual(['wl-copy', 'xclip'])
    expect(run.mock.calls[1]?.[1]).toBe('你好')
    expect(output.write).not.toHaveBeenCalled()
  })

  it('falls back to OSC 52 when no native command succeeds', async () => {
    const output = terminal()
    const copy = createClipboardTextWriter(output, {
      platform: 'linux',
      run: vi.fn(async () => { throw new Error('unavailable') }),
    })

    await copy('copy me')

    expect(output.write).toHaveBeenCalledWith('\u001b]52;c;Y29weSBtZQ==\u0007')
  })
})

import { stripTerminalSequences, visibleWidth, type Component } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import type { AttachmentDraft } from '../../src/application/attachments/drafts.ts'
import { AttachmentComposerFrame, AttachmentRail } from '../../src/presentation/attachments.ts'
import { createTheme } from '../../src/presentation/theme.ts'

class FakeEditor implements Component {
  invalidate(): void {}

  render(width: number): string[] {
    return [
      '─'.repeat(width),
      ` draft${' '.repeat(Math.max(0, width - 6))}`,
      '─'.repeat(width),
    ]
  }
}

function draft(id: string): AttachmentDraft {
  return {
    id,
    name: `${id}.png`,
    mediaType: 'image/png',
    data: Uint8Array.from([1]),
    source: 'clipboard',
  }
}

function railDraft(index: number): AttachmentDraft {
  return {
    id: `image-${String(index)}`,
    name: `very-long-unicode-screen-name-${String(index)}-界面截图.png`,
    mediaType: 'image/png',
    data: new Uint8Array(2_048),
    source: 'file',
    width: 1_280,
    height: 720,
  }
}

describe('AttachmentRail', () => {
  it('stays within two rows and preserves overflow feedback at 80 columns', () => {
    const rail = new AttachmentRail(createTheme(false))
    rail.setDrafts([railDraft(1), railDraft(2), railDraft(3), railDraft(4)])
    const lines = rail.render(80).map(stripTerminalSequences)

    expect(lines).toHaveLength(2)
    expect(lines.every(line => line.length <= 80)).toBe(true)
    expect(lines[1]).toContain('+2 images')
    expect(lines.join('\n')).toContain('…')
  })

  it('supports h/l selection, Delete removal, and Escape return', () => {
    const remove = vi.fn()
    const exit = vi.fn()
    const rail = new AttachmentRail(createTheme(false), remove, exit)
    rail.setDrafts([railDraft(1), railDraft(2)])

    rail.handleInput('l')
    rail.handleInput('\u001B[3~')
    rail.handleInput('\u001B')

    expect(remove).toHaveBeenCalledWith(1)
    expect(exit).toHaveBeenCalledOnce()
  })
})

describe('AttachmentComposerFrame', () => {
  it('renders structured image markers inside the Editor border', () => {
    const frame = new AttachmentComposerFrame(new FakeEditor(), createTheme(false))
    frame.setDrafts([draft('one'), draft('two')])

    const output = frame.render(48)

    expect(output[1]).toContain('[Image #1] [Image #2]')
    expect(output[1]).toContain('draft')
    expect(output.every(line => visibleWidth(line) === 48)).toBe(true)
  })

  it('delegates to the Editor without reserving marker width when there are no images', () => {
    const frame = new AttachmentComposerFrame(new FakeEditor(), createTheme(false))

    expect(frame.render(24)).toEqual([
      '─'.repeat(24),
      ` draft${' '.repeat(18)}`,
      '─'.repeat(24),
    ])
  })
})

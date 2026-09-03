import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import type { AttachmentDraft } from '../../../../src/modules/composer/attachments/drafts.ts'
import { AttachmentRail } from '../../../../src/modules/composer/view/attachment-rail.ts'
import { createTheme } from '../../../../src/presentation/primitives/theme.ts'

function railDraft(index: number): AttachmentDraft {
  return {
    id: `image-${String(index)}`,
    placeholder: `[Image #${String(index)}]`,
    name: `very-long-unicode-screen-name-${String(index)}-界面截图.png`,
    mediaType: 'image/png',
    data: new Uint8Array(2_048),
    source: 'file',
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

    rail.handleAction('surface.next')
    rail.handleAction('surface.confirm')
    rail.handleAction('surface.back')

    expect(remove).toHaveBeenCalledWith(1)
    expect(exit).toHaveBeenCalledOnce()
  })
})

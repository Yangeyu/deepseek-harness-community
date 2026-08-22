import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { describe, expect, it, vi } from 'vitest'
import {
  preparePromptDraft,
  type PromptAttachmentReader,
} from '../../src/application/attachments/restore.ts'

function attachment(id = 'attachment-1'): ImageAttachmentRef {
  return {
    attachmentId: id as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
    name: 'image.png',
  }
}

describe('Rewind Prompt attachment restoration', () => {
  it('rehydrates verified durable references as Composer drafts', async () => {
    const ref = attachment()
    const data = Uint8Array.from([0x89, 0x50, 0x4E, 0x47])
    const reader: PromptAttachmentReader = { readImage: vi.fn(async () => ({ ref, data })) }

    const draft = await preparePromptDraft({ text: 'inspect [Image #1]', attachments: [ref] }, reader)

    expect(reader.readImage).toHaveBeenCalledWith(ref)
    expect(draft.text).toBe('inspect [Image #1]')
    expect(draft.attachments).toEqual([expect.objectContaining({
      placeholder: '[Image #1]',
      name: 'image.png',
      mediaType: 'image/png',
      data,
      source: 'rewind',
      width: 1,
      height: 1,
    })])
  })

  it('preserves a durable inline image position', async () => {
    const ref = attachment()
    const reader: PromptAttachmentReader = {
      readImage: vi.fn(async () => ({ ref, data: new Uint8Array(4) })),
    }

    const draft = await preparePromptDraft({
      text: 'before [Image #1] after',
      attachments: [ref],
    }, reader)

    expect(draft.text).toBe('before [Image #1] after')
    expect(draft.attachments[0]?.placeholder).toBe('[Image #1]')
  })

  it('rejects ambiguous durable image references before restoring the Composer', async () => {
    const ref = attachment()
    const reader: PromptAttachmentReader = {
      readImage: vi.fn(async () => ({ ref, data: new Uint8Array(4) })),
    }

    await expect(preparePromptDraft({
      text: '[Image #1] then [Image #1]',
      attachments: [ref],
    }, reader)).rejects.toThrow('Image reference appears more than once: [Image #1]')
  })

  it('fails before mutation when durable attachment storage is unavailable or inconsistent', async () => {
    const ref = attachment()
    await expect(preparePromptDraft({ text: 'inspect [Image #1]', attachments: [ref] }, undefined))
      .rejects.toThrow('attachment storage is unavailable')
    const reader: PromptAttachmentReader = {
      readImage: vi.fn(async () => ({ ref: attachment('different'), data: new Uint8Array() })),
    }
    await expect(preparePromptDraft({ text: 'inspect [Image #1]', attachments: [ref] }, reader))
      .rejects.toThrow('no longer matches')
  })
})

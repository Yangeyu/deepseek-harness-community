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

    const draft = await preparePromptDraft({ text: 'inspect image', attachments: [ref] }, reader)

    expect(reader.readImage).toHaveBeenCalledWith(ref)
    expect(draft.text).toBe('inspect image')
    expect(draft.attachments).toEqual([expect.objectContaining({
      name: 'image.png',
      mediaType: 'image/png',
      data,
      source: 'rewind',
      width: 1,
      height: 1,
    })])
  })

  it('fails before mutation when durable attachment storage is unavailable or inconsistent', async () => {
    const ref = attachment()
    await expect(preparePromptDraft({ text: 'inspect image', attachments: [ref] }, undefined))
      .rejects.toThrow('attachment storage is unavailable')
    const reader: PromptAttachmentReader = {
      readImage: vi.fn(async () => ({ ref: attachment('different'), data: new Uint8Array() })),
    }
    await expect(preparePromptDraft({ text: 'inspect image', attachments: [ref] }, reader))
      .rejects.toThrow('no longer matches')
  })
})

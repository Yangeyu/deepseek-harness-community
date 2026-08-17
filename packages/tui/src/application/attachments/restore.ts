import { randomUUID } from 'node:crypto'
import type {
  ImageAttachmentRef,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { RewindPromptInput } from '../../rewind/index.ts'
import type { ComposerDraft } from '../composer-input.ts'
import type { AttachmentDraft } from './drafts.ts'

export interface PromptAttachmentReader {
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>
}

function fallbackName(ref: ImageAttachmentRef, index: number): string {
  const extension = ref.mediaType === 'image/jpeg' ? 'jpg' : ref.mediaType.slice('image/'.length)
  return `rewind-image-${String(index + 1)}.${extension}`
}

function sameRef(left: ImageAttachmentRef, right: ImageAttachmentRef): boolean {
  return String(left.attachmentId) === String(right.attachmentId)
    && left.mediaType === right.mediaType
    && left.bytes === right.bytes
    && left.width === right.width
    && left.height === right.height
    && left.name === right.name
}

/** Verify durable Prompt attachments before any workspace or conversation mutation. */
export async function preparePromptDraft(
  input: RewindPromptInput,
  reader: PromptAttachmentReader | undefined,
): Promise<ComposerDraft<AttachmentDraft>> {
  if (input.attachments.length === 0) return { text: input.text, attachments: [] }
  if (reader === undefined) throw new Error('Rewind cannot restore images because attachment storage is unavailable.')
  const stored = await Promise.all(input.attachments.map(attachment => reader.readImage(attachment)))
  return {
    text: input.text,
    attachments: stored.map(({ ref, data }, index) => {
      const expected = input.attachments[index]
      if (expected === undefined || !sameRef(expected, ref)) {
        throw new Error('A Rewind image no longer matches its durable attachment reference.')
      }
      return {
        id: randomUUID(),
        name: ref.name ?? fallbackName(ref, index),
        mediaType: ref.mediaType,
        data,
        source: 'rewind',
        width: ref.width,
        height: ref.height,
      }
    }),
  }
}

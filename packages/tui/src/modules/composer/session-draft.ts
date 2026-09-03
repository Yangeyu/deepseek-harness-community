import type { AttachmentDraft } from './attachments/drafts.ts'
import type { ComposerDraft } from './input.ts'
import { removeImageMarker } from './image-reference.ts'

/**
 * Preserve bootstrap input, but never carry Session-owned image reservations
 * into a different Session epoch.
 */
export function composerDraftForSession(
  draft: ComposerDraft<AttachmentDraft>,
  preserveAttachments: boolean,
): ComposerDraft<AttachmentDraft> {
  if (preserveAttachments) {
    return { text: draft.text, attachments: [...draft.attachments] }
  }
  return {
    text: draft.attachments.reduce(
      (text, attachment) => removeImageMarker(text, attachment.placeholder),
      draft.text,
    ),
    attachments: [],
  }
}

import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { promptTextFromContent } from '../../../src/runtime/execution/prompt-text.ts'
import { visionEvidenceBlock } from '../../../src/runtime/session/input.ts'

describe('durable Prompt text projection', () => {
  it('preserves exact body text order across native images and proxy evidence', () => {
    expect(promptTextFromContent([
      { type: 'text', text: 'before [Image #1]' },
      { type: 'image' },
      { type: 'text', text: ' after [Image #2]' },
      visionEvidenceBlock({
        analysisId: 'analysis-1', provider: 'bailian', model: 'qwen',
        observation: 'Visible warning banner',
        attachments: [{ attachmentId: AttachmentId('image-2'), mediaType: 'image/png', bytes: 10, width: 2, height: 2 }],
        references: ['[Image #2]'], durationMs: 10, truncated: false, finishReason: 'stop',
      }),
      { type: 'text', text: '\nnext line' },
    ])).toBe('before [Image #1] after [Image #2]\nnext line')
  })

  it('concatenates text-only blocks including explicit merge separators verbatim', () => {
    expect(promptTextFromContent([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
      { type: 'text', text: '\n\n' },
      { type: 'text', text: 'third' },
    ])).toBe('firstsecond\n\nthird')
  })
})

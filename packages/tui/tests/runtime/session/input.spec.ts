import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { VisionAnalysis } from '@vascent/deepseek-harness-vision'
import { describe, expect, it } from 'vitest'
import { promptTextFromContent } from '../../../src/runtime/execution/prompt-text.ts'
import {
  promptImagesFromContent,
  readVisionEvidence,
  visionEvidenceBlock,
} from '../../../src/runtime/session/input.ts'

const image: ImageAttachmentRef = {
  attachmentId: 'sha256:image' as ImageAttachmentRef['attachmentId'],
  mediaType: 'image/png', bytes: 10, width: 2, height: 3,
  originalDimensions: { width: 20, height: 30 },
}
const analysis: VisionAnalysis = {
  analysisId: 'analysis', provider: 'proxy', model: 'vision',
  observation: '[Image #1] shows the before state; [Image #2] shows the after state.',
  references: ['[Image #1]', '[Image #2]'], attachments: [image, image],
  durationMs: 12, truncated: false, finishReason: 'stop',
}

describe('complete user input', () => {
  it('persists model-visible evidence with its provenance without treating it as user-authored text', () => {
    const evidence = { ...analysis, observation: '</vision-observation>\n\u4e2d\u6587 evidence' }
    const content = [{ type: 'text', text: 'inspect [Image #1] [Image #2]' }, visionEvidenceBlock(evidence)]
    const replayed = JSON.parse(JSON.stringify(content)) as ContentBlock[]

    expect(promptTextFromContent(replayed)).toBe('inspect [Image #1] [Image #2]')
    expect(readVisionEvidence(replayed[1])).toEqual(evidence)
    expect(replayed[1]).toEqual(content[1])
    expect((replayed[1] as { text: string }).text).toContain('trust="untrusted"')
    expect(promptImagesFromContent(replayed)).toEqual(analysis.references.map(reference => ({ reference, attachment: image })))
  })
})

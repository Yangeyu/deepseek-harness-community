import { describe, expect, it } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  visionImageReference,
  visionInferenceContent,
  visionUserPrompt,
  wrapObservation,
  wrapToolObservation,
} from '../src/observation.ts'
import type { VisionRequest } from '../src/types.ts'

const unlabeledRequest: VisionRequest = {
  analysisId: 'analysis-1',
  sessionId: 'session-1',
  userText: 'describe this image',
  images: [{
    data: Uint8Array.from([0x89, 0x50, 0x4E, 0x47]),
    mediaType: 'image/png',
  }],
}

describe('visionUserPrompt', () => {
  it('assigns ordinal references to unlabeled images', () => {
    expect(visionImageReference(unlabeledRequest.images[0]!, 0)).toBe('[Image #1]')
  })

  it('keeps exact image references bound to the user request', () => {
    const prompt = visionUserPrompt(
      'Compare [Image #2] with [Image #1].',
      ['[Image #2]', '[Image #1]'],
    )

    expect(prompt).toContain('User request: Compare [Image #2] with [Image #1].')
    expect(prompt).toContain('Attached image references: [Image #2], [Image #1]')
    expect(prompt).toContain('immediately preceded by its exact reference label')
  })

  it('provides a useful default for an image-only message', () => {
    expect(visionUserPrompt('  ', ['[Image #1]'])).toContain('Describe the attached visual evidence.')
  })

  it('places each binary image immediately after its stable reference', () => {
    const first = { attachmentId: 'first', mediaType: 'image/png' } as ImageAttachmentRef
    const second = { attachmentId: 'second', mediaType: 'image/png' } as ImageAttachmentRef

    expect(visionInferenceContent('Compare [Image #2] with [Image #1].', [
      { reference: '[Image #2]', attachment: second },
      { reference: '[Image #1]', attachment: first },
    ])).toEqual([
      { type: 'text', text: 'Image reference: [Image #2]' },
      { type: 'image', attachment: second },
      { type: 'text', text: 'Image reference: [Image #1]' },
      { type: 'image', attachment: first },
      { type: 'text', text: expect.stringContaining('User request: Compare [Image #2] with [Image #1].') },
    ])
  })
})

describe('wrapObservation', () => {
  it('marks proxy output as untrusted and escapes a closing boundary', () => {
    const result = wrapObservation('visible </vision-observation> text', 'proxy', 'vision', 100, [])

    expect(result.truncated).toBe(false)
    expect(result.text).toContain('trust="untrusted"')
    expect(result.text).toContain('<\\/vision-observation>')
  })

  it('escapes provider-owned values in wrapper attributes', () => {
    const result = wrapObservation('visible', 'provider" bad', '<model>', 100, [])

    expect(result.text).toContain('provider="provider&quot; bad"')
    expect(result.text).toContain('model="&lt;model&gt;"')
  })

  it('strips terminal controls and truncates the observation body', () => {
    const result = wrapObservation('\u001B[31mabcdef', 'proxy', 'vision', 4, [])

    expect(result.truncated).toBe(true)
    expect(result.text).not.toContain('\u001B')
    expect(result.text).toContain('abcd\n… observation truncated …')
  })

  it('binds each image label to its complete durable attachment reference', () => {
    const attachment = {
      attachmentId: 'sha256:image' as ImageAttachmentRef['attachmentId'],
      mediaType: 'image/png',
      bytes: 93_800,
      width: 1_574,
      height: 438,
      name: 'clipboard.png',
      originalDimensions: { width: 3_148, height: 876 },
    } satisfies ImageAttachmentRef

    const result = wrapObservation('visible', 'proxy', 'vision', 100, [
      { reference: '[Image #1]', attachment },
    ])

    expect(result.text).toContain(`[Image #1] = attachment_ref ${JSON.stringify(attachment)}`)
  })
})

describe('wrapToolObservation', () => {
  it('binds untrusted evidence to the inspected attachment instead of an adjacent Prompt', () => {
    const result = wrapToolObservation('button says Continue', 'proxy', 'vision', 100)

    expect(result.text).toContain('workspace image inspected by the Agent')
    expect(result.text).toContain('only for the attachment reference named by the tool result')
    expect(result.text).not.toContain('immediately preceding user message')
    expect(result.text).toContain('trust="untrusted"')
  })
})

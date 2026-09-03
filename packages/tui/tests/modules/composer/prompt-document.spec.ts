import { describe, expect, it } from 'vitest'
import {
  imageMarkerInsertion,
  removeImageMarker,
} from '../../../src/modules/composer/image-reference.ts'
import { compilePromptDocument } from '../../../src/modules/composer/prompt-document.ts'

describe('inline Prompt content', () => {
  it('inserts a marker at the current cursor with word separators', () => {
    expect(imageMarkerInsertion(['beforeafter'], { line: 0, col: 6 }, '[Image #1]'))
      .toBe(' [Image #1] ')
    expect(imageMarkerInsertion(['after'], { line: 0, col: 0 }, '[Image #1]'))
      .toBe('[Image #1] ')
  })

  it('orders images by marker position while preserving the visible text', () => {
    const first = { id: 'first', placeholder: '[Image #1]' }
    const second = { id: 'second', placeholder: '[Image #2]' }
    const text = `before ${second.placeholder} between ${first.placeholder} after`
    const compiled = compilePromptDocument(text, [first, second])

    expect(compiled.text).toBe(text)
    expect(compiled.images).toEqual([second, first])
    expect(compiled.parts).toEqual([
      { type: 'text', text: `before ${second.placeholder}` },
      { type: 'image', image: second },
      { type: 'text', text: ` between ${first.placeholder}` },
      { type: 'image', image: first },
      { type: 'text', text: ' after' },
    ])
  })

  it('rejects incomplete or ambiguous live image references instead of guessing', () => {
    const first = { id: 'first', placeholder: '[Image #1]' }

    expect(() => compilePromptDocument('inspect this', [first]))
      .toThrow('Attached image is missing its inline reference: [Image #1]')
    expect(() => compilePromptDocument('[Image #1] then [Image #1]', [first]))
      .toThrow('Image reference appears more than once: [Image #1]')
    expect(() => compilePromptDocument('[Image #1] and [Image #2]', [first]))
      .toThrow('Image reference has no attachment: [Image #2]')
  })

  it('removes every binding for one image without joining surrounding words', () => {
    expect(removeImageMarker('before [Image #1] after', '[Image #1]')).toBe('before after')
    expect(removeImageMarker('[Image #1] after', '[Image #1]')).toBe('after')
    expect(removeImageMarker('[Image #1] before [Image #1] after', '[Image #1]')).toBe('before after')
  })
})

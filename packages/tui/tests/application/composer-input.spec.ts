import { describe, expect, it } from 'vitest'
import {
  ComposerInputController,
  type ComposerDraft,
} from '../../src/application/composer-input.ts'

interface TestAttachment {
  id: string
}

function draft(
  text: string,
  attachments: readonly TestAttachment[] = [],
): ComposerDraft<TestAttachment> {
  return { text, attachments }
}

describe('ComposerInputController', () => {
  it('clears a draft on the first Escape and opens Rewind on the second', () => {
    const input = new ComposerInputController<TestAttachment>(600)

    expect(input.pressEscape(draft('unfinished prompt'), 1_000)).toEqual({
      type: 'clear-and-arm-rewind',
    })
    expect(input.snapshot).toEqual({
      rewindArmed: true,
      draftRecovery: 'stored',
    })
    expect(input.pressEscape(draft(''), 1_500)).toEqual({ type: 'open-rewind' })
    expect(input.snapshot).toEqual({
      rewindArmed: false,
      draftRecovery: 'stored',
    })
  })

  it('starts a new Escape sequence after the double-press window', () => {
    const input = new ComposerInputController<TestAttachment>(600)

    expect(input.pressEscape(draft(''), 1_000)).toEqual({ type: 'arm-rewind' })
    expect(input.pressEscape(draft(''), 1_601)).toEqual({ type: 'arm-rewind' })
    expect(input.snapshot.rewindArmed).toBe(true)
  })

  it('uses Up and Down as one-level recovery for a cleared draft', () => {
    const input = new ComposerInputController<TestAttachment>()
    input.pressEscape(draft('unfinished prompt'), 1_000)

    expect(input.navigateDraft('up', draft(''))).toEqual({
      type: 'restore-draft',
      draft: draft('unfinished prompt'),
    })
    expect(input.snapshot.draftRecovery).toBe('restored')
    expect(input.navigateDraft('down', draft('unfinished prompt'))).toEqual({
      type: 'clear-restored-draft',
    })
    expect(input.snapshot.draftRecovery).toBe('stored')
  })

  it('treats image attachments as part of the same recoverable draft', () => {
    const input = new ComposerInputController<TestAttachment>()
    const image = { id: 'image-1' }

    expect(input.pressEscape(draft('', [image]), 1_000)).toEqual({
      type: 'clear-and-arm-rewind',
    })
    expect(input.navigateDraft('up', draft(''))).toEqual({
      type: 'restore-draft',
      draft: draft('', [image]),
    })
    expect(input.observeAttachments([image])).toBe(false)
    expect(input.navigateDraft('down', draft('', [image]))).toEqual({
      type: 'clear-restored-draft',
    })
  })

  it('drops draft recovery after the user edits either state', () => {
    const hidden = new ComposerInputController<TestAttachment>()
    hidden.pressEscape(draft('old draft'), 1_000)
    expect(hidden.observeEditorText('new')).toBe(true)
    expect(hidden.snapshot.draftRecovery).toBe('none')

    const restored = new ComposerInputController<TestAttachment>()
    restored.pressEscape(draft('old draft'), 1_000)
    restored.navigateDraft('up', draft(''))
    expect(restored.observeEditorText('old draft!')).toBe(true)
    expect(restored.snapshot.draftRecovery).toBe('none')
  })

  it('drops draft recovery after attachments change', () => {
    const input = new ComposerInputController<TestAttachment>()
    const image = { id: 'image-1' }
    input.pressEscape(draft('', [image]), 1_000)

    expect(input.observeAttachments([{ id: 'image-2' }])).toBe(true)
    expect(input.snapshot.draftRecovery).toBe('none')
  })
})

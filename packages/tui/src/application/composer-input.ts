export const REWIND_ESCAPE_WINDOW_MS = 600

export interface ComposerDraft<Attachment> {
  text: string
  attachments: readonly Attachment[]
}

export type ComposerInputAction<Attachment> =
  | { type: 'arm-rewind' }
  | { type: 'clear-and-arm-rewind' }
  | { type: 'open-rewind' }
  | { type: 'restore-draft'; draft: ComposerDraft<Attachment> }
  | { type: 'clear-restored-draft' }
  | { type: 'pass' }

export interface ComposerInputSnapshot {
  rewindArmed: boolean
  draftRecovery: 'none' | 'stored' | 'restored'
}

interface RecoverableDraft<Attachment> {
  draft: ComposerDraft<Attachment>
  visible: boolean
}

/** Coordinates idle-composer Escape and one-level draft recovery. */
export class ComposerInputController<Attachment = never> {
  private rewindArmedAt: number | undefined
  private recoverableDraft: RecoverableDraft<Attachment> | undefined

  constructor(private readonly rewindWindowMs = REWIND_ESCAPE_WINDOW_MS) {}

  get snapshot(): Readonly<ComposerInputSnapshot> {
    return {
      rewindArmed: this.rewindArmedAt !== undefined,
      draftRecovery: this.recoverableDraft === undefined
        ? 'none'
        : this.recoverableDraft.visible ? 'restored' : 'stored',
    }
  }

  pressEscape(draft: ComposerDraft<Attachment>, now: number): ComposerInputAction<Attachment> {
    if (this.rewindArmedAt !== undefined) {
      const elapsed = now - this.rewindArmedAt
      if (elapsed >= 0 && elapsed <= this.rewindWindowMs) {
        this.rewindArmedAt = undefined
        return { type: 'open-rewind' }
      }
    }

    this.rewindArmedAt = now
    if (this.isEmpty(draft)) return { type: 'arm-rewind' }

    this.recoverableDraft = {
      draft: { text: draft.text, attachments: [...draft.attachments] },
      visible: false,
    }
    return { type: 'clear-and-arm-rewind' }
  }

  navigateDraft(
    direction: 'up' | 'down',
    current: ComposerDraft<Attachment>,
  ): ComposerInputAction<Attachment> {
    const recovery = this.recoverableDraft
    if (recovery === undefined) return { type: 'pass' }

    if (direction === 'up' && !recovery.visible && this.isEmpty(current)) {
      recovery.visible = true
      return { type: 'restore-draft', draft: recovery.draft }
    }
    if (direction === 'down' && recovery.visible && this.matches(recovery.draft, current)) {
      recovery.visible = false
      return { type: 'clear-restored-draft' }
    }
    return { type: 'pass' }
  }

  observeEditorText(text: string): boolean {
    const recovery = this.recoverableDraft
    if (recovery === undefined) return false
    const expected = recovery.visible ? recovery.draft.text : ''
    if (text === expected) return false
    this.recoverableDraft = undefined
    return true
  }

  observeAttachments(attachments: readonly Attachment[]): boolean {
    const recovery = this.recoverableDraft
    if (recovery === undefined) return false
    const expected = recovery.visible ? recovery.draft.attachments : []
    if (this.sameAttachments(expected, attachments)) return false
    this.recoverableDraft = undefined
    return true
  }

  disarmRewind(): boolean {
    if (this.rewindArmedAt === undefined) return false
    this.rewindArmedAt = undefined
    return true
  }

  reset(): boolean {
    if (this.rewindArmedAt === undefined && this.recoverableDraft === undefined) return false
    this.rewindArmedAt = undefined
    this.recoverableDraft = undefined
    return true
  }

  private isEmpty(draft: ComposerDraft<Attachment>): boolean {
    return draft.text === '' && draft.attachments.length === 0
  }

  private matches(expected: ComposerDraft<Attachment>, current: ComposerDraft<Attachment>): boolean {
    return expected.text === current.text
      && this.sameAttachments(expected.attachments, current.attachments)
  }

  private sameAttachments(left: readonly Attachment[], right: readonly Attachment[]): boolean {
    return left.length === right.length && left.every((attachment, index) => attachment === right[index])
  }
}

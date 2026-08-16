import { randomUUID } from 'node:crypto'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

export type AttachmentSource = 'file' | 'clipboard'

/** One local, session-scoped image that has not yet been accepted by the Host. */
export interface AttachmentDraft {
  id: string
  name: string
  mediaType: ImageMediaType
  data: Uint8Array
  source: AttachmentSource
  width?: number
  height?: number
  error?: string | undefined
}

export type NewAttachmentDraft = Omit<AttachmentDraft, 'id' | 'error'>

/** Small observable store; binary drafts never enter global TUI state or the session log. */
export class AttachmentDraftStore {
  private items: AttachmentDraft[] = []
  private readonly listeners = new Set<(drafts: readonly AttachmentDraft[]) => void>()

  get snapshot(): readonly AttachmentDraft[] {
    return this.items
  }

  add(input: NewAttachmentDraft): AttachmentDraft {
    const draft: AttachmentDraft = { ...input, id: randomUUID() }
    this.items = [...this.items, draft]
    this.emit()
    return draft
  }

  remove(id: string): boolean {
    const next = this.items.filter(item => item.id !== id)
    if (next.length === this.items.length) return false
    this.items = next
    this.emit()
    return true
  }

  removeLast(): boolean {
    const last = this.items.at(-1)
    return last === undefined ? false : this.remove(last.id)
  }

  removeAt(index: number): boolean {
    const draft = this.items[index]
    return draft === undefined ? false : this.remove(draft.id)
  }

  setError(ids: readonly string[], error: string): void {
    const selected = new Set(ids)
    this.items = this.items.map(item => selected.has(item.id)
      ? { ...item, error }
      : item)
    this.emit()
  }

  /** Restore a failed or cancelled submission while preserving stable attachment ids. */
  restore(drafts: readonly AttachmentDraft[], error?: string): void {
    if (drafts.length === 0) return
    const currentIds = new Set(this.items.map(item => item.id))
    const restored = drafts
      .filter(item => !currentIds.has(item.id))
      .map(item => error === undefined
        ? { ...item, error: undefined }
        : { ...item, error })
    if (restored.length === 0) return
    this.items = [...restored, ...this.items]
    this.emit()
  }

  /** Replace the current Composer attachments while preserving draft identity and errors. */
  replaceAll(drafts: readonly AttachmentDraft[]): void {
    if (drafts.length === this.items.length
      && drafts.every((draft, index) => draft === this.items[index])) return
    this.items = [...drafts]
    this.emit()
  }

  clear(): void {
    this.replaceAll([])
  }

  onChange(listener: (drafts: readonly AttachmentDraft[]) => void): () => void {
    this.listeners.add(listener)
    listener(this.items)
    return () => { this.listeners.delete(listener) }
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.items)
  }
}

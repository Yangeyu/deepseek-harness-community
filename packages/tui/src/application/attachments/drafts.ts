import { randomUUID } from 'node:crypto'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

export type AttachmentSource = 'file' | 'clipboard'
export type AttachmentDraftStatus = 'ready' | 'analyzing' | 'error'

/** One local, session-scoped image that has not yet been accepted by the Host. */
export interface AttachmentDraft {
  id: string
  name: string
  mediaType: ImageMediaType
  data: Uint8Array
  source: AttachmentSource
  width?: number
  height?: number
  status: AttachmentDraftStatus
  error?: string | undefined
}

export type NewAttachmentDraft = Omit<AttachmentDraft, 'id' | 'status' | 'error'>

/** Small observable store; binary drafts never enter global TUI state or the session log. */
export class AttachmentDraftStore {
  private items: AttachmentDraft[] = []
  private readonly listeners = new Set<(drafts: readonly AttachmentDraft[]) => void>()

  get snapshot(): readonly AttachmentDraft[] {
    return this.items
  }

  get busy(): boolean {
    return this.items.some(item => item.status === 'analyzing')
  }

  add(input: NewAttachmentDraft): AttachmentDraft {
    const draft: AttachmentDraft = { ...input, id: randomUUID(), status: 'ready' }
    this.items = [...this.items, draft]
    this.emit()
    return draft
  }

  remove(id: string): boolean {
    if (this.busy) return false
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

  setStatus(ids: readonly string[], status: AttachmentDraftStatus, error?: string): void {
    const selected = new Set(ids)
    this.items = this.items.map(item => selected.has(item.id)
      ? { ...item, status, ...error === undefined ? { error: undefined } : { error } }
      : item)
    this.emit()
  }

  clear(): void {
    if (this.items.length === 0) return
    this.items = []
    this.emit()
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

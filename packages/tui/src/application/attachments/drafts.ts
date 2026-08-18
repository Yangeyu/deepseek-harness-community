import { randomUUID } from 'node:crypto'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import {
  imageMarkerNumber,
  nextImageMarker,
} from '../../prompt-content.ts'

export type AttachmentSource = 'file' | 'clipboard' | 'rewind'

/** One local, session-scoped image that has not yet been accepted by the Host. */
export interface AttachmentDraft {
  id: string
  placeholder: string
  name: string
  mediaType: ImageMediaType
  data: Uint8Array
  source: AttachmentSource
  width?: number
  height?: number
  error?: string | undefined
}

export type NewAttachmentDraft = Omit<AttachmentDraft, 'id' | 'placeholder' | 'error'>

export interface AttachmentReservation {
  readonly id: string
  readonly placeholder: string
}

function markerNumber(draft: AttachmentDraft): number {
  return imageMarkerNumber(draft.placeholder) ?? 0
}

/** Small observable store; binary drafts never enter global TUI state or the session log. */
export class AttachmentDraftStore {
  private active: AttachmentDraft[] = []
  private detached: AttachmentDraft[] = []
  private readonly reservations = new Map<string, string>()
  private nextMarkerNumber = 1
  private readonly listeners = new Set<(drafts: readonly AttachmentDraft[]) => void>()

  get snapshot(): readonly AttachmentDraft[] {
    return this.active
  }

  get placeholders(): readonly string[] {
    return [
      ...this.active.map(item => item.placeholder),
      ...this.detached.map(item => item.placeholder),
      ...this.reservations.values(),
    ]
  }

  reserve(occupiedText = ''): AttachmentReservation {
    const { marker, next } = nextImageMarker(
      occupiedText,
      [...this.active.map(item => item.placeholder), ...this.reservations.values()],
      this.nextMarkerNumber,
    )
    this.nextMarkerNumber = next
    const reservation = { id: randomUUID(), placeholder: marker }
    this.reservations.set(reservation.id, reservation.placeholder)
    this.emit()
    return reservation
  }

  complete(reservation: AttachmentReservation, input: NewAttachmentDraft): AttachmentDraft | undefined {
    if (this.reservations.get(reservation.id) !== reservation.placeholder) return undefined
    this.reservations.delete(reservation.id)
    const draft: AttachmentDraft = { ...input, ...reservation }
    this.active = [...this.active, draft]
    this.emit()
    return draft
  }

  discard(reservation: AttachmentReservation): boolean {
    const removed = this.reservations.delete(reservation.id)
    if (removed) this.emit()
    return removed
  }

  add(input: NewAttachmentDraft, occupiedText = ''): AttachmentDraft {
    const reservation = this.reserve(occupiedText)
    const draft = this.complete(reservation, input)
    if (draft === undefined) throw new Error('Attachment reservation expired before completion.')
    return draft
  }

  setError(ids: readonly string[], error: string): void {
    const selected = new Set(ids)
    this.active = this.active.map(item => selected.has(item.id)
      ? { ...item, error }
      : item)
    this.detached = this.detached.map(item => selected.has(item.id)
      ? { ...item, error }
      : item)
    this.emit()
  }

  /** Restore a failed or cancelled submission while preserving stable attachment ids. */
  restore(drafts: readonly AttachmentDraft[], error?: string): void {
    if (drafts.length === 0) return
    const currentIds = new Set([...this.active, ...this.detached].map(item => item.id))
    const restored = drafts
      .filter(item => !currentIds.has(item.id))
      .map(item => error === undefined
        ? { ...item, error: undefined }
        : { ...item, error })
    if (restored.length === 0) return
    this.active = [...restored, ...this.active]
    this.advanceMarkerCounter(this.active)
    this.emit()
  }

  /** Replace the current Composer attachments while preserving draft identity and errors. */
  replaceAll(drafts: readonly AttachmentDraft[]): void {
    if (this.detached.length === 0
      && this.reservations.size === 0
      && drafts.length === this.active.length
      && drafts.every((draft, index) => draft === this.active[index])) return
    this.active = [...drafts]
    this.detached = []
    this.reservations.clear()
    this.nextMarkerNumber = 1
    this.advanceMarkerCounter(drafts)
    this.emit()
  }

  /** Reconcile active attachments from the inline tokens while retaining undoable bytes. */
  reconcileText(text: string): boolean {
    const all = [...this.active, ...this.detached]
      .sort((left, right) => markerNumber(left) - markerNumber(right))
    const active: AttachmentDraft[] = []
    const detached: AttachmentDraft[] = []
    for (const item of all) {
      if (text.includes(item.placeholder)) active.push(item)
      else detached.push(item)
    }
    if (active.length === this.active.length
      && active.every((item, index) => item === this.active[index])) return false
    this.active = active
    this.detached = detached
    this.emit()
    return true
  }

  /** Finish one submitted draft without disturbing attachments created for the next draft. */
  discardDetached(): void {
    if (this.detached.length === 0) return
    this.detached = []
    if (this.active.length === 0 && this.reservations.size === 0) this.nextMarkerNumber = 1
    this.emit()
  }

  clear(): void {
    const changed = this.active.length > 0 || this.detached.length > 0 || this.reservations.size > 0
    this.active = []
    this.detached = []
    this.reservations.clear()
    this.nextMarkerNumber = 1
    if (changed) this.emit()
  }

  onChange(listener: (drafts: readonly AttachmentDraft[]) => void): () => void {
    this.listeners.add(listener)
    listener(this.active)
    return () => { this.listeners.delete(listener) }
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.active)
  }

  private advanceMarkerCounter(drafts: readonly AttachmentDraft[]): void {
    const greatest = drafts
      .map(markerNumber)
      .reduce((maximum, number) => Math.max(maximum, number), 0)
    this.nextMarkerNumber = Math.max(this.nextMarkerNumber, greatest + 1)
  }
}

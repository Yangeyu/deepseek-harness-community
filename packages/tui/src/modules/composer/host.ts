import type { Component } from '@earendil-works/pi-tui'
import { AtomicSnapshotStore, type SnapshotListener } from '../../runtime/dispatch/snapshot-store.ts'
import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import { ComponentSlot } from '../../presentation/primitives/component-slot.ts'
import type { AttachmentDraft } from './attachments/drafts.ts'
import type { ComposerAutocompleteProvider } from './autocomplete.ts'
import type { ComposerCursor, ComposerEditorPort } from './editor-port.ts'
import type { ComposerDraft } from './input.ts'
import { ComposerProcess, type ComposerSnapshot } from './process.ts'

const EMPTY_SNAPSHOT: ComposerSnapshot = {
  text: '',
  attachments: [],
  imageSubmissionBusy: false,
  clipboardPastePending: false,
  attachmentRailFocused: false,
  input: { rewindArmed: false, draftRecovery: 'none' },
}

class ComposerEditorSlot implements ComposerEditorPort {
  private target: ComposerEditorPort | undefined
  private isFocused = false

  onChange?: (text: string) => void
  onSubmit?: (text: string) => void

  get focused(): boolean {
    return this.isFocused
  }

  set focused(value: boolean) {
    this.isFocused = value
    if (this.target !== undefined) this.target.focused = value
  }

  replace(target: ComposerEditorPort | undefined): void {
    this.target = target
    if (target !== undefined) target.focused = this.isFocused
  }

  handleInput(data: string): void { this.target?.handleInput(data) }
  setAutocompleteProvider(provider: ComposerAutocompleteProvider): void {
    this.target?.setAutocompleteProvider(provider)
  }
  isShowingAutocomplete(): boolean { return this.target?.isShowingAutocomplete() ?? false }
  getText(): string { return this.target?.getText() ?? '' }
  getExpandedText(): string { return this.target?.getExpandedText() ?? '' }
  getLines(): string[] { return this.target?.getLines() ?? [''] }
  getCursor(): ComposerCursor { return this.target?.getCursor() ?? { line: 0, col: 0 } }
  setText(text: string): void { this.target?.setText(text) }
  insertTextAtCursor(text: string): void { this.target?.insertTextAtCursor(text) }
  addToHistory(text: string): void { this.target?.addToHistory(text) }
  decodeReferences(text: string): string { return this.target?.decodeReferences(text) ?? text }
  invalidate(): void { this.target?.invalidate() }
  render(width: number): string[] { return this.target?.render(width) ?? [] }
}

/**
 * Application-stable shell facade over a replaceable Session-owned Composer.
 * Layout and input keep this identity while every Session receives fresh state,
 * editor, attachment store, timers, and asynchronous work.
 */
export class ComposerHost {
  readonly editor = new ComposerEditorSlot()
  readonly attachmentRail = new ComponentSlot()
  readonly editorFrame = new ComponentSlot()

  private readonly store = new AtomicSnapshotStore<ComposerSnapshot>(EMPTY_SNAPSHOT)
  private process: ComposerProcess | undefined
  private detachProcess: (() => void) | undefined

  get current(): Readonly<ComposerSnapshot> { return this.store.current }
  get draft(): ComposerDraft<AttachmentDraft> {
    return this.process?.draft ?? { text: '', attachments: [] }
  }
  get empty(): boolean { return this.process?.empty ?? true }

  subscribe(listener: SnapshotListener<ComposerSnapshot>): () => void {
    return this.store.subscribe(listener)
  }

  bind(process: ComposerProcess | undefined, owner?: LifecycleScope): void {
    this.detachProcess?.()
    this.detachProcess = undefined
    this.process = process
    this.editor.replace(process?.editor)
    this.attachmentRail.replace(process?.attachmentRail)
    this.editorFrame.replace(process?.editorFrame)
    this.store.replace(process?.current ?? EMPTY_SNAPSHOT)
    if (process === undefined) return
    this.detachProcess = process.subscribe(snapshot => { this.store.replace(snapshot as ComposerSnapshot) })
    owner?.onDispose(() => {
      if (this.process === process) this.bind(undefined)
    })
  }

  focusAttachments(): boolean { return this.process?.focusAttachments() ?? false }
  leaveAttachmentRail(): void { this.process?.leaveAttachmentRail() }
  navigateAttachments(direction: -1 | 1): void { this.process?.navigateAttachments(direction) }
  removeSelectedAttachment(): void { this.process?.removeSelectedAttachment() }
  removeLatestAttachment(): boolean { return this.process?.removeLatestAttachment() ?? false }
  pasteImage(): Promise<void> { return this.require().pasteImage() }
  attachPath(path: string, cwd?: string): Promise<AttachmentDraft> {
    return this.require().attachPath(path, cwd)
  }
  loadImagePaths(paths: readonly string[], cwd?: string): Promise<void> {
    return this.require().loadImagePaths(paths, cwd)
  }
  submitEditor(mode: 'queue' | 'steer'): Promise<void> { return this.require().submitEditor(mode) }
  submit(value: string, forcedMode?: 'queue' | 'steer'): Promise<void> {
    return this.require().submit(value, forcedMode)
  }
  navigateDraft(direction: 'up' | 'down'): boolean {
    return this.process?.navigateDraft(direction) ?? false
  }
  pressEscape(now?: number): boolean { return this.process?.pressEscape(now) ?? false }
  clearDraft(): boolean { return this.process?.clearDraft() ?? false }
  disarmRewind(): void { this.process?.disarmRewind() }
  resetInput(publish?: boolean): void { this.process?.resetInput(publish) }
  restoreDraft(draft: ComposerDraft<AttachmentDraft>): void { this.require().restoreDraft(draft) }
  cancelImageSubmission(restoreDrafts?: boolean): void {
    this.process?.cancelImageSubmission(restoreDrafts)
  }
  refreshAutocomplete(): void { this.process?.refreshAutocomplete() }

  /** Focus callbacks passed to the concrete process keep stable shell identities. */
  focusPort(setFocus: (component: Component) => void): { editor(): void; attachments(): void } {
    return {
      editor: () => { setFocus(this.editor) },
      attachments: () => { setFocus(this.attachmentRail) },
    }
  }

  private require(): ComposerProcess {
    if (this.process === undefined) throw new Error('no terminal session Composer is active')
    return this.process
  }
}

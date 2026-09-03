import type {
  AutocompleteItem,
  SlashCommand,
} from '@earendil-works/pi-tui'
import type { ModelSelection } from '../../runtime/session/contracts.ts'
import type { TuiTheme } from '../../presentation/primitives/theme.ts'
import { AttachmentRail } from './view/attachment-rail.ts'
import { ComposerEditorFrame } from './view/editor-frame.ts'
import { AtomicSnapshotStore, type SnapshotListener } from '../../runtime/dispatch/snapshot-store.ts'
import { ResourceSlot } from '../../runtime/lifecycle/resource-slot.ts'
import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import type { RuntimeSessionSnapshot } from '../../runtime/session/snapshot.ts'
import { selectedModel } from '../../runtime/session/model-selection.ts'
import type { PreparedPrompt, PromptPreparationContext } from '../../runtime/session/prompt.ts'
import { ComposerAutocompleteProvider, type WorkspacePathSource } from './autocomplete.ts'
import {
  AttachmentCoordinator,
  type VisionGateway,
} from './attachments/coordinator.ts'
import {
  AttachmentDraftStore,
  type AttachmentDraft,
  type AttachmentReservation,
  type NewAttachmentDraft,
} from './attachments/drafts.ts'
import { imageDraftFromPath } from './attachments/files.ts'
import type { ClipboardImageLoader } from './attachments/clipboard.ts'
import {
  ComposerInputController,
  REWIND_ESCAPE_WINDOW_MS,
  type ComposerDraft,
  type ComposerInputAction,
  type ComposerInputSnapshot,
} from './input.ts'
import { imageMarkerInsertion, removeImageMarker } from './image-reference.ts'
import { composerExecutionActivity } from './execution-activity.ts'
import type { ComposerEditorFactory, ComposerEditorPort } from './editor-port.ts'

export interface ComposerSessionPort {
  readonly current: Readonly<RuntimeSessionSnapshot>
  subscribe(listener: (snapshot: Readonly<RuntimeSessionSnapshot>) => void): () => void
  prompt(text: string, mode: 'queue' | 'steer'): Promise<void>
  promptWithPreparation(
    text: string,
    mode: 'queue' | 'steer',
    prepareContent: (context: PromptPreparationContext) => Promise<PreparedPrompt>,
  ): Promise<void>
  notice(message: string): void
}

export interface ComposerCommandPort {
  dispatch(text: string): Promise<boolean>
  autocompleteItems(): readonly (AutocompleteItem | SlashCommand)[]
}

export interface ComposerSnapshot {
  readonly text: string
  readonly attachments: readonly AttachmentDraft[]
  readonly imageSubmissionBusy: boolean
  readonly clipboardPastePending: boolean
  readonly attachmentRailFocused: boolean
  readonly input: Readonly<ComposerInputSnapshot>
}

export interface ComposerProcessOptions {
  readonly focus: {
    editor(): void
    attachments(): void
  }
  readonly theme: TuiTheme
  readonly session: ComposerSessionPort
  readonly commands: ComposerCommandPort
  readonly workspacePaths: WorkspacePathSource
  readonly clipboardImage: ClipboardImageLoader
  readonly vision?: VisionGateway
  readonly createEditor: ComposerEditorFactory
  readonly followTranscript: () => void
  readonly openRewind: () => void
  readonly scope: LifecycleScope
}

/** Session-bound Composer state, views, attachments, and submission workflow. */
export class ComposerProcess {
  readonly editor: ComposerEditorPort
  readonly attachmentRail: AttachmentRail
  readonly editorFrame: ComposerEditorFrame

  private readonly drafts = new AttachmentDraftStore()
  private readonly input = new ComposerInputController<AttachmentDraft>()
  private readonly coordinator: AttachmentCoordinator | undefined
  private readonly rewindTimer: ResourceSlot<ReturnType<typeof setTimeout>>
  private readonly store: AtomicSnapshotStore<ComposerSnapshot>
  private started = false
  private autocompleteCwd: string
  private attachmentRailFocused = false
  private clipboardPastePending = false

  constructor(private readonly options: ComposerProcessOptions) {
    this.coordinator = options.vision === undefined
      ? undefined
      : new AttachmentCoordinator(this.drafts, options.vision)
    this.rewindTimer = options.scope.own(new ResourceSlot(timer => { clearTimeout(timer) }))
    this.attachmentRail = new AttachmentRail(
      options.theme,
      index => { this.removeAttachmentAt(index) },
      () => { this.leaveAttachmentRail() },
    )
    this.editor = options.createEditor(() => this.drafts.placeholders)
    this.editorFrame = new ComposerEditorFrame(this.editor)
    this.autocompleteCwd = options.session.current.cwd
    this.editor.onChange = text => {
      this.drafts.reconcileText(text)
      this.input.observeEditorText(text)
      this.publish()
    }
    this.editor.onSubmit = (text) => {
      const decoded = this.editor.decodeReferences(text)
      this.resetInput(false)
      this.editor.addToHistory(decoded)
      void this.submit(decoded)
    }
    this.store = new AtomicSnapshotStore(this.createSnapshot())
  }

  get current(): Readonly<ComposerSnapshot> {
    return this.store.current
  }

  get draft(): ComposerDraft<AttachmentDraft> {
    return {
      text: this.editor.getExpandedText(),
      attachments: this.drafts.snapshot,
    }
  }

  get empty(): boolean {
    return this.current.text === '' && this.current.attachments.length === 0
  }

  subscribe(listener: SnapshotListener<ComposerSnapshot>): () => void {
    return this.store.subscribe(listener)
  }

  start(): void {
    if (this.started) throw new Error('ComposerProcess has already started.')
    this.started = true
    this.editor.setAutocompleteProvider(this.createAutocompleteProvider(this.autocompleteCwd))
    this.options.scope.onDispose(this.options.session.subscribe(snapshot => this.bindSession(snapshot)))
    this.options.scope.onDispose(this.drafts.onChange((drafts) => {
      if (!this.options.scope.active) return
      this.input.observeAttachments(drafts)
      this.attachmentRail.setDrafts(drafts)
      if (drafts.length === 0 && this.attachmentRailFocused) this.leaveAttachmentRail()
      this.publish()
    }))
    this.options.scope.onDispose(() => { this.coordinator?.cancel(false) })
  }

  focusAttachments(): boolean {
    if (this.drafts.snapshot.length === 0) return false
    this.attachmentRailFocused = true
    this.options.focus.attachments()
    this.publish()
    return true
  }

  leaveAttachmentRail(): void {
    if (!this.attachmentRailFocused) return
    this.attachmentRailFocused = false
    this.options.focus.editor()
    this.publish()
  }

  navigateAttachments(direction: -1 | 1): void {
    this.attachmentRail.handleAction(direction < 0 ? 'surface.previous' : 'surface.next')
    this.publish()
  }

  removeSelectedAttachment(): void {
    this.attachmentRail.handleAction('surface.confirm')
    this.publish()
  }

  removeLatestAttachment(): boolean {
    const draft = this.drafts.snapshot.at(-1)
    if (draft === undefined) return false
    this.removeAttachment(draft)
    return true
  }

  async pasteImage(): Promise<void> {
    if (this.clipboardPastePending) return
    this.ensureVisionAvailable()
    if (this.current.imageSubmissionBusy) throw new Error('Vision analysis is already in progress.')
    this.clipboardPastePending = true
    this.publish()
    const reservation = this.reserveImageMarker()
    try {
      const draft = await this.options.clipboardImage()
      if (!this.options.scope.active) {
        this.removeMarker(reservation.placeholder)
        this.drafts.discard(reservation)
        return
      }
      if (!this.editor.getExpandedText().includes(reservation.placeholder)) {
        this.drafts.discard(reservation)
        return
      }
      if (this.drafts.complete(reservation, draft) === undefined) {
        this.removeMarker(reservation.placeholder)
      }
    } catch (error: unknown) {
      this.removeMarker(reservation.placeholder)
      this.drafts.discard(reservation)
      throw error
    } finally {
      this.clipboardPastePending = false
      this.publish()
    }
  }

  async attachPath(path: string, cwd = this.options.session.current.cwd): Promise<AttachmentDraft> {
    this.ensureVisionAvailable()
    if (this.current.imageSubmissionBusy) throw new Error('Vision analysis is already in progress.')
    return this.insertImageDraft(await imageDraftFromPath(path, cwd))
  }

  async loadImagePaths(paths: readonly string[], cwd = this.options.session.current.cwd): Promise<void> {
    if (paths.length === 0) return
    this.ensureVisionAvailable()
    const drafts = await Promise.all(paths.map(path => imageDraftFromPath(path, cwd)))
    for (const draft of drafts) this.insertImageDraft(draft)
  }

  async submitEditor(mode: 'queue' | 'steer'): Promise<void> {
    const text = this.editor.getExpandedText()
    if (text.trim() === '' && this.drafts.snapshot.length === 0) return
    this.resetInput()
    this.editor.setText('')
    this.editor.addToHistory(text)
    await this.submit(text, mode)
  }

  async submit(value: string, forcedMode?: 'queue' | 'steer'): Promise<void> {
    const text = this.editor.decodeReferences(value).trim()
    this.drafts.reconcileText(text)
    if (text === '' && this.drafts.snapshot.length === 0) return
    try {
      if (text.startsWith('/')) {
        const submittedIds = new Set(this.drafts.snapshot.map(draft => draft.id))
        if (await this.options.commands.dispatch(text)) {
          this.drafts.replaceAll(this.drafts.snapshot.filter(draft => !submittedIds.has(draft.id)))
          return
        }
      }
      const mode = forcedMode ?? (composerExecutionActivity(this.options.session.current) === undefined
        ? 'queue'
        : 'steer')
      this.options.followTranscript()
      if (this.drafts.snapshot.length === 0) {
        await this.options.session.prompt(text, mode)
        this.drafts.discardDetached()
        return
      }
      await this.submitImages(text, mode)
    } catch (error: unknown) {
      if (this.editor.getExpandedText() === '') this.editor.setText(text)
      this.options.session.notice(error instanceof Error ? error.message : String(error))
    } finally {
      this.publish()
    }
  }

  navigateDraft(direction: 'up' | 'down'): boolean {
    return this.applyInputAction(this.input.navigateDraft(direction, this.draft))
  }

  pressEscape(now = Date.now()): boolean {
    return this.applyInputAction(this.input.pressEscape(this.draft, now))
  }

  clearDraft(): boolean {
    return this.applyInputAction(this.input.clearDraft(this.draft))
  }

  disarmRewind(): void {
    this.rewindTimer.clear()
    if (this.input.disarmRewind()) this.publish()
  }

  resetInput(publish = true): void {
    this.rewindTimer.clear()
    if (this.input.reset() && publish) this.publish()
  }

  restoreDraft(draft: ComposerDraft<AttachmentDraft>): void {
    this.resetInput(false)
    this.editor.setText(draft.text)
    this.drafts.replaceAll(draft.attachments)
    this.publish()
  }

  cancelImageSubmission(restoreDrafts = true): void {
    this.coordinator?.cancel(restoreDrafts)
    this.publish()
  }

  refreshAutocomplete(cwd = this.options.session.current.cwd): void {
    if (!this.options.scope.active) return
    this.editor.setAutocompleteProvider(this.createAutocompleteProvider(cwd))
    this.autocompleteCwd = cwd
    this.publish()
  }

  private bindSession(snapshot: Readonly<RuntimeSessionSnapshot>): void {
    if (snapshot.cwd !== this.autocompleteCwd) this.refreshAutocomplete(snapshot.cwd)
    else this.publish()
  }

  private async submitImages(text: string, mode: 'queue' | 'steer'): Promise<void> {
    const coordinator = this.coordinator
    const state = this.options.session.current
    const selection: ModelSelection | undefined = selectedModel(state.modelCatalog, state.projections)
    if (coordinator === undefined) throw new Error('Vision is unavailable in this profile.')
    if (state.sessionId === undefined || selection === undefined) {
      throw new Error('Wait for the active session and model before submitting images.')
    }
    const submission = coordinator.submit(
      String(state.sessionId),
      selection,
      text,
      mode,
      (displayText, submitMode, prepareContent) => this.options.session.promptWithPreparation(
        displayText,
        submitMode,
        prepareContent,
      ),
    )
    this.publish()
    await submission
  }

  private applyInputAction(action: ComposerInputAction<AttachmentDraft>): boolean {
    switch (action.type) {
      case 'pass':
        return false
      case 'clear-draft':
      case 'clear-restored-draft':
        this.editor.setText('')
        this.drafts.clear()
        break
      case 'arm-rewind':
        break
      case 'open-rewind':
        this.options.openRewind()
        return true
      case 'restore-draft':
        this.editor.setText(action.draft.text)
        this.drafts.replaceAll(action.draft.attachments)
        break
    }
    if (this.input.snapshot.rewindArmed) this.scheduleRewindDisarm()
    this.publish()
    return true
  }

  private scheduleRewindDisarm(): void {
    this.rewindTimer.replace(setTimeout(() => {
      this.rewindTimer.clear()
      if (this.input.disarmRewind() && this.options.scope.active) this.publish()
    }, REWIND_ESCAPE_WINDOW_MS))
  }

  private reserveImageMarker(): AttachmentReservation {
    const reservation = this.drafts.reserve(this.editor.getExpandedText())
    this.editor.insertTextAtCursor(imageMarkerInsertion(
      this.editor.getLines(),
      this.editor.getCursor(),
      reservation.placeholder,
    ))
    return reservation
  }

  private insertImageDraft(input: NewAttachmentDraft): AttachmentDraft {
    const reservation = this.reserveImageMarker()
    const draft = this.drafts.complete(reservation, input)
    if (draft === undefined) throw new Error('Attachment marker was removed before the image loaded.')
    return draft
  }

  private removeAttachmentAt(index: number): void {
    const draft = this.drafts.snapshot[index]
    if (draft !== undefined) this.removeAttachment(draft)
  }

  private removeAttachment(draft: AttachmentDraft): void {
    this.removeMarker(draft.placeholder)
    this.drafts.reconcileText(this.editor.getExpandedText())
  }

  private removeMarker(marker: string): void {
    const current = this.editor.getExpandedText()
    const next = removeImageMarker(current, marker)
    if (next !== current) this.editor.setText(next)
  }

  private ensureVisionAvailable(): void {
    if (this.coordinator === undefined) throw new Error('Vision is unavailable in this profile.')
  }

  private createAutocompleteProvider(cwd: string): ComposerAutocompleteProvider {
    return new ComposerAutocompleteProvider(
      this.options.commands.autocompleteItems(),
      cwd,
      this.options.workspacePaths,
    )
  }

  private createSnapshot(): ComposerSnapshot {
    return {
      text: this.editor.getExpandedText(),
      attachments: this.drafts.snapshot,
      imageSubmissionBusy: this.coordinator?.busy === true,
      clipboardPastePending: this.clipboardPastePending,
      attachmentRailFocused: this.attachmentRailFocused,
      input: this.input.snapshot,
    }
  }

  private publish(): void {
    if (!this.options.scope.active) return
    this.store.replace(this.createSnapshot())
  }
}

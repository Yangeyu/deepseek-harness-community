import type { RuntimeSessionSnapshot } from '../runtime/session/snapshot.ts'
import type { LifecycleScope } from '../runtime/lifecycle/scope.ts'
import { composerExecutionActivity } from '../modules/composer/execution-activity.ts'
import type { PointerAction, TerminalGesture } from '../presentation/shell/input/gesture.ts'
import type { KeymapAction } from '../presentation/shell/input/keymap.ts'
import { resolveTerminalInput } from '../presentation/shell/input/resolve-terminal-input.ts'
import type { ClipboardTextWriter } from '../presentation/shell/input/contracts.ts'
import {
  isSurfaceInputAction,
  type SurfaceInputAction,
  type SurfaceInputContext,
  type SurfacePointerGesture,
} from '../presentation/primitives/surface-input.ts'
import { ActionDispatcher } from '../runtime/dispatch/dispatcher.ts'
import { ScopedEffectRunner } from '../runtime/dispatch/effect-runner.ts'

export interface InputSessionPort {
  readonly current: Readonly<RuntimeSessionSnapshot>
  subscribe(listener: (snapshot: Readonly<RuntimeSessionSnapshot>) => void): () => void
  cancel(): Promise<void>
  notice(message: string): void
}

export interface InputComposerPort {
  readonly current: {
    readonly text: string
    readonly imageSubmissionBusy: boolean
    readonly attachments: readonly unknown[]
    readonly attachmentRailFocused: boolean
  }
  readonly empty: boolean
  readonly editor: { isShowingAutocomplete(): boolean }
  subscribe(listener: () => void): () => void
  disarmRewind(): void
  submitEditor(mode: 'queue' | 'steer'): Promise<void>
  pasteImage(): Promise<void>
  focusAttachments(): boolean
  leaveAttachmentRail(): void
  navigateAttachments(direction: -1 | 1): void
  removeLatestAttachment(): boolean
  removeSelectedAttachment(): void
  navigateDraft(direction: 'up' | 'down'): boolean
  pressEscape(): boolean
  cancelImageSubmission(): void
  clearDraft(): boolean
}

export interface InputInteractionPort {
  readonly active: boolean
  readonly activeKey: string | undefined
  cancel(): void
}

export interface InputConfigurationPort {
  readonly details: boolean
  setDetails(expanded: boolean): void
  cycleReasoningEffort(): Promise<void>
}

export interface InputLayoutPort {
  pageTranscript(direction: -1 | 1): boolean
  scrollTranscript(direction: -1 | 1): boolean
  transcriptRowAt(screenRow: number, viewportTop: number): number
  preserveTranscriptViewport(): void
}

export interface InputTranscriptPort {
  handlePointer(line: number, action: 'move' | 'click' | 'wheel-up' | 'wheel-down'): boolean
  isTrailingBlock(line: number): boolean
}

export interface InputScreenPort {
  clearTextSelection(): boolean
  beginTextSelection(x: number, y: number): boolean
  updateTextSelection(x: number, y: number): boolean
  finishTextSelection(x: number, y: number):
    | { kind: 'none'; changed: false }
    | { kind: 'click'; changed: boolean }
    | { kind: 'selection'; changed: boolean; text: string }
  captureRenderState(): { previousViewportTop: number }
}

export interface InputCoordinatorOptions {
  readonly session: InputSessionPort
  readonly composer: InputComposerPort
  readonly interactions: InputInteractionPort
  readonly configuration: InputConfigurationPort
  readonly surfaces: {
    readonly active: boolean
    readonly inputContext: SurfaceInputContext | undefined
    dispatchInput(action: SurfaceInputAction): boolean
    handlePointer(pointer: SurfacePointerGesture, viewportTop: number): boolean
  }
  readonly layout: InputLayoutPort
  readonly transcript: InputTranscriptPort
  readonly screen: InputScreenPort
  readonly clipboard: ClipboardTextWriter
  readonly requestExit: (code: number) => Promise<void>
  readonly invalidate: () => void
  readonly scope: LifecycleScope
}

/** Dispatches normalized terminal gestures to their owning feature ports. */
export class InputCoordinator {
  private interruptingActivityKey: string | undefined
  private readonly actions = new ActionDispatcher<KeymapAction>()
  private readonly effects: ScopedEffectRunner

  constructor(private readonly options: InputCoordinatorOptions) {
    this.effects = new ScopedEffectRunner(options.scope, (error) => {
      options.session.notice(error instanceof Error ? error.message : String(error))
    })
    this.registerActions()
    options.scope.onDispose(options.session.subscribe(snapshot => { this.reconcile(snapshot) }))
    options.scope.onDispose(options.composer.subscribe(() => { this.reconcile() }))
  }

  get interruptingKey(): string | undefined {
    return this.interruptingActivityKey
  }

  interruptionTarget(state: Readonly<RuntimeSessionSnapshot> = this.options.session.current): string | undefined {
    return composerExecutionActivity(state)?.key
      ?? (this.options.composer.current.imageSubmissionBusy ? 'vision:preparation' : undefined)
      ?? this.options.interactions.activeKey
  }

  reconcile(state: Readonly<RuntimeSessionSnapshot> = this.options.session.current): void {
    if (this.interruptingActivityKey === undefined) return
    if (this.interruptingActivityKey !== this.interruptionTarget(state)) {
      this.interruptingActivityKey = undefined
    }
  }

  handle(gesture: TerminalGesture): { consume?: boolean } | undefined {
    const composer = this.options.composer
    const resolution = resolveTerminalInput(gesture, {
      working: composerExecutionActivity(this.options.session.current) !== undefined,
      imageSubmissionBusy: composer.current.imageSubmissionBusy,
      hasAttachments: composer.current.attachments.length > 0,
      composerEmpty: composer.current.text === '',
      autocompleteVisible: composer.editor.isShowingAutocomplete(),
      interactionActive: this.options.interactions.active,
      surfaceActive: this.options.surfaces.active,
      ...this.options.surfaces.inputContext === undefined
        ? {}
        : { surfaceInput: this.options.surfaces.inputContext },
      attachmentRailFocused: composer.current.attachmentRailFocused,
    })
    if (resolution.clearSelection && this.options.screen.clearTextSelection()) this.options.invalidate()
    if (resolution.disarmRewind) composer.disarmRewind()
    if (resolution.route.kind === 'passthrough') return undefined
    if (resolution.route.kind === 'suppressed') return { consume: true }
    if (resolution.route.kind === 'pointer') {
      this.handlePointer(resolution.route.action)
      return { consume: true }
    }
    return this.dispatch(resolution.route.action) ? { consume: true } : undefined
  }

  private dispatch(action: KeymapAction): boolean {
    if (this.actions.dispatch(action)) return true
    return isSurfaceInputAction(action) && this.options.surfaces.dispatchInput(action)
  }

  private registerActions(): void {
    const { composer, configuration, layout } = this.options
    this.actions.register('application', 'app.cancel-or-exit', () => { this.cancelOrExit() })
    this.actions.register('interaction', 'interaction.cancel', () => this.cancelActiveInteraction())
    this.actions.register('composer', 'turn.queue', () => {
      this.effects.start(async () => { await composer.submitEditor('queue') })
    })
    this.actions.register('composer', 'vision.paste', () => {
      this.effects.start(async () => { await composer.pasteImage() })
    })
    this.actions.register('composer', 'attachments.focus', () => { composer.focusAttachments() })
    this.actions.register('composer', 'attachments.leave', () => { composer.leaveAttachmentRail() })
    this.actions.register('composer', 'attachments.previous', () => { composer.navigateAttachments(-1) })
    this.actions.register('composer', 'attachments.next', () => { composer.navigateAttachments(1) })
    this.actions.register('composer', 'attachments.remove-last', () => { composer.removeLatestAttachment() })
    this.actions.register('composer', 'attachments.remove-selected', () => { composer.removeSelectedAttachment() })
    this.actions.register('configuration', 'details.toggle', () => {
      configuration.setDetails(!configuration.details)
    })
    this.actions.register('configuration', 'reasoning.cycle', () => {
      this.effects.start(async () => { await configuration.cycleReasoningEffort() })
    })
    this.actions.register('transcript', 'history.page-up', () => {
      if (layout.pageTranscript(-1)) this.options.invalidate()
    })
    this.actions.register('transcript', 'history.page-down', () => {
      if (layout.pageTranscript(1)) this.options.invalidate()
    })
    this.actions.register('composer', 'draft.previous', () => composer.navigateDraft('up'))
    this.actions.register('composer', 'draft.next', () => composer.navigateDraft('down'))
    this.actions.register('session', 'run.interrupt', () => this.requestInterrupt())
    this.actions.register('composer', 'composer.escape', () => composer.pressEscape())
  }

  private handlePointer(pointer: PointerAction): void {
    const { layout, screen, transcript } = this.options
    const surfaceActive = this.options.surfaces.active
    if (pointer.kind === 'move') {
      const line = surfaceActive
        ? -1
        : layout.transcriptRowAt(pointer.y, screen.captureRenderState().previousViewportTop)
      if (transcript.handlePointer(line, 'move')) this.options.invalidate()
      return
    }
    const renderState = screen.captureRenderState()
    const transcriptLine = layout.transcriptRowAt(pointer.y, renderState.previousViewportTop)
    let changed = false
    if (pointer.kind === 'wheel') {
      changed = screen.clearTextSelection() || changed
      if (surfaceActive) {
        this.options.surfaces.handlePointer(pointer, renderState.previousViewportTop)
      } else {
        changed = transcript.handlePointer(transcriptLine, 'move') || changed
        const blockScrolled = transcript.handlePointer(
          transcriptLine,
          pointer.direction < 0 ? 'wheel-up' : 'wheel-down',
        )
        changed = blockScrolled || changed
        if (!blockScrolled) changed = layout.scrollTranscript(pointer.direction) || changed
      }
    } else {
      changed = transcript.handlePointer(surfaceActive ? -1 : transcriptLine, 'move') || changed
      if (pointer.kind === 'press') {
        changed = screen.beginTextSelection(pointer.x, pointer.y) || changed
      } else if (pointer.kind === 'drag') {
        changed = screen.updateTextSelection(pointer.x, pointer.y) || changed
      } else if (pointer.kind === 'release') {
        const result = screen.finishTextSelection(pointer.x, pointer.y)
        changed = result.changed || changed
        if (result.kind === 'selection') {
          void this.options.clipboard(result.text).catch((error: unknown) => {
            this.options.session.notice(`Could not copy selection: ${error instanceof Error ? error.message : String(error)}`)
          })
        } else if (result.kind === 'click') {
          if (surfaceActive) {
            this.options.surfaces.handlePointer(
              { kind: 'click', x: pointer.x, y: pointer.y },
              renderState.previousViewportTop,
            )
          } else {
            const disclosureChanged = transcript.handlePointer(transcriptLine, 'click')
            if (disclosureChanged && !transcript.isTrailingBlock(transcriptLine)) {
              layout.preserveTranscriptViewport()
            }
            changed = disclosureChanged || changed
          }
        }
      }
    }
    if (changed) this.options.invalidate()
  }

  private requestInterrupt(): boolean {
    const target = this.interruptionTarget()
    if (target === undefined) return false
    if (this.interruptingActivityKey === target) return true
    this.interruptingActivityKey = target
    if (this.options.interactions.active) this.options.interactions.cancel()
    else if (this.options.composer.current.imageSubmissionBusy) this.options.composer.cancelImageSubmission()
    else this.effects.start(async () => { await this.options.session.cancel() })
    this.options.invalidate()
    return true
  }

  private cancelOrExit(): void {
    if (!this.options.interactions.active && !this.options.composer.empty) {
      this.options.composer.clearDraft()
      return
    }
    const target = this.interruptionTarget()
    if (target !== undefined) {
      if (this.interruptingActivityKey !== target) {
        this.requestInterrupt()
        return
      }
      this.effects.start(async () => { await this.options.requestExit(0) })
      return
    }
    if (this.options.composer.clearDraft()) return
    this.effects.start(async () => { await this.options.requestExit(0) })
  }

  private cancelActiveInteraction(): boolean {
    if (!this.options.interactions.active) return false
    this.requestInterrupt()
    return true
  }

}

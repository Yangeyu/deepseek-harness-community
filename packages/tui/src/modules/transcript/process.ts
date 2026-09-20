import type { Component } from '@earendil-works/pi-tui'
import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import { ResourceSlot } from '../../runtime/lifecycle/resource-slot.ts'
import type { RuntimeSessionSnapshot } from '../../runtime/session/snapshot.ts'
import type { TuiTheme } from '../../presentation/primitives/theme.ts'
import {
  DiffLineLocator,
  type DiffTextReader,
} from './diff-location.ts'
import { TranscriptComponent } from './view.ts'
import { TranscriptModel } from './model.ts'

export interface TranscriptSessionPort {
  readonly current: Readonly<RuntimeSessionSnapshot>
  subscribe(listener: (snapshot: Readonly<RuntimeSessionSnapshot>) => void): () => void
}

/** Read-only application preference; Transcript never owns a writable copy. */
export interface TranscriptDetailsPort {
  readonly current: boolean
  /** Notify each actual change synchronously without coalescing; read the value from current. */
  subscribe(listener: () => void): () => void
}

export interface TranscriptProcessOptions {
  readonly session: TranscriptSessionPort
  readonly details: TranscriptDetailsPort
  readonly files: DiffTextReader
  readonly theme: TuiTheme
  readonly showReasoning: boolean
  readonly maxToolOutputLines: number
  readonly thinkingMaxLines: number
  readonly invalidate: () => void
  readonly scope: LifecycleScope
}

/** Coordinates content rendering, preference-driven interaction updates, diff enrichment, and animation. */
export class TranscriptProcess implements Component {
  private readonly model: TranscriptModel
  private readonly view: TranscriptComponent
  private readonly diffLines: DiffLineLocator
  private readonly animationTimer: ResourceSlot<ReturnType<typeof setTimeout>>

  constructor(private readonly options: TranscriptProcessOptions) {
    this.animationTimer = options.scope.own(new ResourceSlot(timer => { clearTimeout(timer) }))
    this.model = new TranscriptModel(options.showReasoning, options.maxToolOutputLines)
    this.view = new TranscriptComponent(
      this.model.project(options.session.current, options.details.current),
      options.theme,
      options.thinkingMaxLines,
    )
    this.diffLines = new DiffLineLocator(options.files)
    options.scope.onDispose(options.session.subscribe(snapshot => { this.resolveDiffLines(snapshot) }))
    options.scope.onDispose(options.details.subscribe(() => {
      if (!options.scope.active) return
      this.view.resetActivityDisclosure()
      options.invalidate()
    }))
    this.resolveDiffLines(options.session.current)
  }

  handlePointer(line: number, action: 'move' | 'click' | 'wheel-up' | 'wheel-down'): boolean {
    return this.view.handlePointer(line, action, this.options.details.current)
  }

  isTrailingBlock(line: number): boolean {
    return this.view.isTrailingBlock(line)
  }

  invalidate(): void {
    this.view.invalidate()
  }

  render(width: number): string[] {
    this.view.setProjection(this.model.project(this.options.session.current, this.options.details.current))
    return this.view.render(width)
  }

  /** Layout reports actual visibility after clipping; offscreen titles need no animation clock. */
  setVisibleRange(top: number, rows: number): void {
    const line = this.view.animationLine
    if (!this.options.scope.active || line === undefined || line < top || line >= top + rows) {
      this.animationTimer.clear()
      return
    }
    if (this.animationTimer.current !== undefined) return
    this.animationTimer.replace(setTimeout(() => {
      this.animationTimer.clear()
      if (this.options.scope.active) this.options.invalidate()
    }, 32))
  }

  private resolveDiffLines(snapshot: Readonly<RuntimeSessionSnapshot>): void {
    if (!this.options.scope.active) return
    this.diffLines.resolve(snapshot, () => {
      if (!this.options.scope.active
        || this.options.session.current.sessionId !== snapshot.sessionId) return
      this.view.setDiffLineStarts(this.diffLines.current)
      this.options.invalidate()
    }, this.options.scope.signal)
    this.view.setDiffLineStarts(this.diffLines.current)
  }
}

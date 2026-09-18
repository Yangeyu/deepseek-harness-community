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

export interface TranscriptProcessOptions {
  readonly session: TranscriptSessionPort
  readonly files: DiffTextReader
  readonly theme: TuiTheme
  readonly showReasoning: boolean
  readonly maxToolOutputLines: number
  readonly thinkingMaxLines: number
  readonly invalidate: () => void
  readonly scope: LifecycleScope
}

/** Owns Transcript projection, diff enrichment, disclosure, and animation state. */
export class TranscriptProcess implements Component {
  private readonly model: TranscriptModel
  private showDetails = false
  private readonly view: TranscriptComponent
  private readonly diffLines: DiffLineLocator
  private readonly animationTimer: ResourceSlot<ReturnType<typeof setTimeout>>

  constructor(private readonly options: TranscriptProcessOptions) {
    this.animationTimer = options.scope.own(new ResourceSlot(timer => { clearTimeout(timer) }))
    this.model = new TranscriptModel(options.showReasoning, options.maxToolOutputLines)
    this.view = new TranscriptComponent(
      this.model.project(options.session.current, this.showDetails),
      options.theme,
      options.thinkingMaxLines,
    )
    this.diffLines = new DiffLineLocator(options.files)
    options.scope.onDispose(options.session.subscribe(snapshot => { this.update(snapshot) }))
    this.update(options.session.current)
  }

  setDetails(expanded: boolean): void {
    this.showDetails = expanded
  }

  handlePointer(line: number, action: 'move' | 'click' | 'wheel-up' | 'wheel-down'): boolean {
    return this.view.handlePointer(line, action)
  }

  isTrailingBlock(line: number): boolean {
    return this.view.isTrailingBlock(line)
  }

  invalidate(): void {
    this.view.invalidate()
  }

  render(width: number): string[] {
    this.view.setProjection(this.model.project(this.options.session.current, this.showDetails))
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

  private update(snapshot: Readonly<RuntimeSessionSnapshot>): void {
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

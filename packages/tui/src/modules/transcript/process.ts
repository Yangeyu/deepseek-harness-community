import type { Component } from '@earendil-works/pi-tui'
import type { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import type { RuntimeSessionSnapshot } from '../../runtime/session/snapshot.ts'
import type { TuiTheme } from '../../presentation/primitives/theme.ts'
import {
  DiffLineLocator,
  type DiffTextReader,
} from './diff-location.ts'
import { TranscriptComponent } from './view.ts'

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
  private readonly view: TranscriptComponent
  private readonly diffLines: DiffLineLocator

  constructor(private readonly options: TranscriptProcessOptions) {
    this.view = new TranscriptComponent(
      options.session.current,
      options.theme,
      options.showReasoning,
      options.maxToolOutputLines,
      options.thinkingMaxLines,
    )
    this.diffLines = new DiffLineLocator(options.files)
    options.scope.onDispose(options.session.subscribe(snapshot => { this.update(snapshot) }))
    this.update(options.session.current)
  }

  setDetails(expanded: boolean): void {
    this.view.setDetails(expanded)
  }

  advanceAnimation(): void {
    this.view.advanceAnimation()
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
    return this.view.render(width)
  }

  private update(snapshot: Readonly<RuntimeSessionSnapshot>): void {
    if (!this.options.scope.active) return
    this.view.setState(snapshot)
    this.diffLines.resolve(snapshot, () => {
      if (!this.options.scope.active
        || this.options.session.current.sessionId !== snapshot.sessionId) return
      this.view.setDiffLineStarts(this.diffLines.current)
      this.options.invalidate()
    }, this.options.scope.signal)
    this.view.setDiffLineStarts(this.diffLines.current)
  }
}

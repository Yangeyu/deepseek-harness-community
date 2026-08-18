/** Resolve absolute line numbers for applied diff hunks against the live workspace. */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy'
import type { TuiState } from '../runtime/controller.ts'
import { appendedHistoryEntries } from '../runtime/event-window.ts'

/** Per-card, per-hunk starting line numbers. */
export type DiffLineStarts = ReadonlyMap<string, readonly (number | undefined)[]>

/** Find a unique hunk after-image and return its one-based file line. */
export function locateHunkStart(fileText: string, newText: string): number | undefined {
  if (newText === '') return undefined
  const normalizedFile = fileText.replaceAll('\r\n', '\n')
  const normalizedHunk = newText.replaceAll('\r\n', '\n')
  const first = normalizedFile.indexOf(normalizedHunk)
  if (first < 0 || normalizedFile.indexOf(normalizedHunk, first + 1) >= 0) return undefined
  return normalizedFile.slice(0, first).split('\n').length
}

/** Cache asynchronous workspace lookups so rendering never performs filesystem I/O. */
export class DiffLineLocator {
  private sessionId: string | undefined
  private scannedEvents: readonly HistoryEntry[] | undefined
  private readonly attempted = new Set<string>()
  private starts: DiffLineStarts = new Map()

  /** Current immutable-by-convention lookup table. */
  get current(): DiffLineStarts {
    return this.starts
  }

  /** Resolve newly arrived applied diffs and notify the caller when display data improves. */
  resolve(state: Readonly<TuiState>, onChange: () => void): void {
    const sessionId = state.sessionId === undefined ? undefined : String(state.sessionId)
    if (sessionId !== this.sessionId) {
      this.sessionId = sessionId
      this.scannedEvents = undefined
      this.attempted.clear()
      this.starts = new Map()
    }
    const entries = this.unscannedEvents(state.events)
    const pending: Promise<readonly [string, readonly (number | undefined)[]]>[] = []
    const generation = this.sessionId
    for (const entry of entries) {
      if (entry.event.type !== 'tool/result' || entry.view?.for !== 'result' || entry.view.view.card !== 'diff') continue
      const source = entry.event.data.message.source
      if (source.kind !== 'tool') continue
      const attemptKey = `${sessionId ?? ''}:${entry.event.seq}`
      if (this.attempted.has(attemptKey)) continue
      this.attempted.add(attemptKey)
      const cardKey = `${String(source.callId)}:diff`
      const diffs = entry.view.view.diffs
      pending.push(Promise.all(diffs.map(async (diff): Promise<number | undefined> => {
        if (diff.oldText === null) return 1
        try {
          const path = isAbsolute(diff.path) ? diff.path : resolve(state.cwd, diff.path)
          return locateHunkStart(await readFile(path, 'utf8'), diff.newText)
        } catch {
          return undefined
        }
      })).then(resolved => [cardKey, resolved] as const))
    }
    if (pending.length === 0) return
    void Promise.all(pending).then((resolved) => {
      if (generation !== this.sessionId) return
      const next = new Map(this.starts)
      let changed = false
      for (const [cardKey, starts] of resolved) {
        if (cardKey === '' || starts.every(value => value === undefined)) continue
        next.set(cardKey, starts)
        changed = true
      }
      if (!changed) return
      this.starts = next
      onChange()
    })
  }

  private unscannedEvents(events: readonly HistoryEntry[]): readonly HistoryEntry[] {
    const previous = this.scannedEvents
    const appended = previous === undefined ? undefined : appendedHistoryEntries(previous, events)
    this.scannedEvents = events
    return appended ?? events
  }
}

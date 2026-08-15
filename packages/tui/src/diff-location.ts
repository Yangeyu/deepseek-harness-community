/** Resolve absolute line numbers for applied diff hunks against the live workspace. */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { TuiState } from './controller.ts'

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
  private readonly attempted = new Set<string>()
  private readonly starts = new Map<string, readonly (number | undefined)[]>()

  /** Current immutable-by-convention lookup table. */
  get current(): DiffLineStarts {
    return this.starts
  }

  /** Resolve newly arrived applied diffs and notify the caller when display data improves. */
  resolve(state: Readonly<TuiState>, onChange: () => void): void {
    const sessionId = state.sessionId === undefined ? undefined : String(state.sessionId)
    if (sessionId !== this.sessionId) {
      this.sessionId = sessionId
      this.attempted.clear()
      this.starts.clear()
    }
    for (const entry of state.events) {
      if (entry.event.type !== 'tool/result' || entry.view?.for !== 'result' || entry.view.view.card !== 'diff') continue
      const source = entry.event.data.message.source
      if (source.kind !== 'tool') continue
      const attemptKey = `${sessionId ?? ''}:${entry.event.seq}`
      if (this.attempted.has(attemptKey)) continue
      this.attempted.add(attemptKey)
      const cardKey = `${String(source.callId)}:diff`
      const diffs = entry.view.view.diffs
      const generation = this.sessionId
      void Promise.all(diffs.map(async (diff): Promise<number | undefined> => {
        if (diff.oldText === null) return 1
        try {
          const path = isAbsolute(diff.path) ? diff.path : resolve(state.cwd, diff.path)
          return locateHunkStart(await readFile(path, 'utf8'), diff.newText)
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          return undefined
        }
      })).then((resolved) => {
        if (generation !== this.sessionId || resolved.every(value => value === undefined)) return
        this.starts.set(cardKey, resolved)
        onChange()
      })
    }
  }
}

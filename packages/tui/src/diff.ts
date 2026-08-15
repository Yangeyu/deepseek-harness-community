/** Terminal-friendly projection for Harness file-diff render intent. */

import { highlight, supportsLanguage, type Theme as SyntaxTheme } from 'cli-highlight'
import { diffLines } from 'diff'
import type { ToolResultView } from '@deepseek-ai/dsh-host-apiproxy'
import type { TuiTheme } from './theme.ts'

type FileDiff = Extract<ToolResultView, { card: 'diff' }>['diffs'][number]

const CONTEXT_RADIUS = 2

/** One visible row in an inline file-edit card. */
export interface DiffDisplayLine {
  kind: 'context' | 'del' | 'add' | 'file' | 'gap'
  path: string
  text: string
  number?: number | undefined
}

/** Presentation data shared by the diff title, summary, and body. */
export interface DiffDisplayModel {
  operation: string
  target: string
  lines: DiffDisplayLine[]
  added: number
  removed: number
  files: number
}

function contentLines(text: string): string[] {
  if (text === '') return []
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

function operationName(title: string, diffs: readonly FileDiff[]): string {
  if (/^(?:edit|update)\b/i.test(title)) return 'Update'
  if (/^write\b/i.test(title)) return diffs.every(diff => diff.oldText === null) ? 'Write' : 'Update'
  if (/^(?:delete|remove)\b/i.test(title)) return 'Delete'
  const firstWord = title.trim().split(/\s+/, 1)[0]
  return firstWord === undefined || firstWord === '' ? 'Update' : firstWord
}

function compactContext(lines: readonly DiffDisplayLine[], path: string): DiffDisplayLine[] {
  const changed = lines
    .map((line, index) => line.kind === 'add' || line.kind === 'del' ? index : -1)
    .filter(index => index >= 0)
  if (changed.length === 0) return [...lines]

  const visible = new Set<number>()
  for (const index of changed) {
    const first = Math.max(0, index - CONTEXT_RADIUS)
    const last = Math.min(lines.length - 1, index + CONTEXT_RADIUS)
    for (let cursor = first; cursor <= last; cursor += 1) visible.add(cursor)
  }

  const compacted: DiffDisplayLine[] = []
  let omitted = false
  for (const [index, line] of lines.entries()) {
    if (!visible.has(index)) {
      omitted = true
      continue
    }
    if (omitted) compacted.push({ kind: 'gap', path, text: '⋯' })
    compacted.push(line)
    omitted = false
  }
  if (omitted) compacted.push({ kind: 'gap', path, text: '⋯' })
  return compacted
}

function pushHunk(
  lines: DiffDisplayLine[],
  diff: FileDiff,
  start: number | undefined,
): { added: number; removed: number } {
  let added = 0
  let removed = 0
  let oldNumber = start
  let newNumber = start
  if (diff.oldText === null) {
    newNumber = 1
    for (const text of contentLines(diff.newText)) {
      lines.push({ kind: 'add', path: diff.path, text, number: newNumber })
      newNumber = (newNumber ?? 0) + 1
      added += 1
    }
    return { added, removed }
  }
  const hunkLines: DiffDisplayLine[] = []
  for (const change of diffLines(diff.oldText, diff.newText, { ignoreNewlineAtEof: true })) {
    for (const text of contentLines(change.value)) {
      if (change.removed === true) {
        hunkLines.push({ kind: 'del', path: diff.path, text, number: oldNumber })
        if (oldNumber !== undefined) oldNumber += 1
        removed += 1
      } else if (change.added === true) {
        hunkLines.push({ kind: 'add', path: diff.path, text, number: newNumber })
        if (newNumber !== undefined) newNumber += 1
        added += 1
      } else {
        hunkLines.push({ kind: 'context', path: diff.path, text, number: newNumber })
        if (oldNumber !== undefined) oldNumber += 1
        if (newNumber !== undefined) newNumber += 1
      }
    }
  }
  lines.push(...compactContext(hunkLines, diff.path))
  return { added, removed }
}

/** Build changed rows while folding unchanged context far from each edit. */
export function buildDiffDisplay(
  title: string,
  diffs: readonly FileDiff[],
  starts: readonly (number | undefined)[] = [],
): DiffDisplayModel {
  const paths = new Set(diffs.map(diff => diff.path))
  const lines: DiffDisplayLine[] = []
  let previousPath: string | undefined
  let added = 0
  let removed = 0
  for (const [index, diff] of diffs.entries()) {
    if (paths.size > 1 && diff.path !== previousPath) {
      lines.push({ kind: 'file', path: diff.path, text: diff.path })
    } else if (diff.path === previousPath) {
      lines.push({ kind: 'gap', path: diff.path, text: '⋯' })
    }
    previousPath = diff.path
    const counts = pushHunk(lines, diff, starts[index])
    added += counts.added
    removed += counts.removed
  }
  return {
    operation: operationName(title, diffs),
    target: paths.size === 1 ? diffs[0]?.path ?? '' : `${paths.size} files`,
    lines,
    added,
    removed,
    files: paths.size,
  }
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  css: 'css',
  go: 'go',
  h: 'c',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
}

function syntaxTheme(theme: TuiTheme): SyntaxTheme {
  return {
    keyword: theme.error,
    built_in: theme.accent,
    type: theme.accent,
    literal: theme.accent,
    number: theme.warning,
    regexp: theme.error,
    string: theme.warning,
    symbol: theme.warning,
    class: theme.accent,
    function: theme.success,
    title: theme.bold,
    comment: theme.reasoning,
    doctag: theme.reasoning,
    meta: theme.reasoning,
    tag: theme.accent,
    name: theme.accent,
    attr: theme.success,
    variable: theme.warning,
  }
}

/** Apply extension-selected terminal syntax colors without trusting file text as ANSI. */
export function highlightDiffText(text: string, path: string, theme: TuiTheme): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const language = LANGUAGE_BY_EXTENSION[extension]
  if (language === undefined || !supportsLanguage(language)) return text
  return highlight(text, { language, ignoreIllegals: true, theme: syntaxTheme(theme) })
}

/** Human-readable Claude-style changed-line summary. */
export function diffSummary(added: number, removed: number): string {
  const parts = []
  if (added > 0) parts.push(`Added ${added} line${added === 1 ? '' : 's'}`)
  if (removed > 0) parts.push(`removed ${removed} line${removed === 1 ? '' : 's'}`)
  return parts.length === 0 ? 'No textual changes' : parts.join(', ')
}

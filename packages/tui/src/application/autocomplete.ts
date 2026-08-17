import { spawn } from 'node:child_process'
import { rgPath } from '@vscode/ripgrep'
import {
  CombinedAutocompleteProvider,
  fuzzyFilter,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from '@earendil-works/pi-tui'

const MAX_DISCOVERY_CHARACTERS = 4 * 1024 * 1024
const MAX_DISCOVERED_FILES = 50_000
const MAX_SUGGESTIONS = 20
const PATH_DELIMITERS = new Set([' ', '\t', '"', "'", '='])

export interface WorkspacePath {
  path: string
  isDirectory: boolean
}

export type WorkspacePathSource = (
  cwd: string,
  signal: AbortSignal,
) => Promise<readonly WorkspacePath[]>

function hasUnsafePathCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (character === '"' || codePoint <= 0x1F || codePoint === 0x7F) return true
  }
  return false
}

function normalizeWorkspacePath(value: string): string | undefined {
  const normalized = value
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
  const segments = normalized.split('/')
  if (
    normalized.length === 0
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//u.test(normalized)
    || segments.some(segment => segment === '.' || segment === '..')
    || segments.includes('.git')
    || hasUnsafePathCharacter(normalized)
  ) return undefined
  return normalized
}

function parseWorkspaceFiles(output: string): readonly WorkspacePath[] {
  const lastSeparator = output.lastIndexOf('\0')
  if (lastSeparator < 0) return []
  const completeOutput = output.slice(0, lastSeparator + 1)

  const files = new Set<string>()
  for (const value of completeOutput.split('\0')) {
    if (files.size >= MAX_DISCOVERED_FILES) break
    const path = normalizeWorkspacePath(value)
    if (path !== undefined) files.add(path)
  }

  const directories = new Set<string>()
  for (const file of files) {
    let separator = file.lastIndexOf('/')
    while (separator > 0) {
      directories.add(file.slice(0, separator))
      separator = file.lastIndexOf('/', separator - 1)
    }
  }

  return [
    ...[...directories].map(path => ({ path, isDirectory: true })),
    ...[...files].map(path => ({ path, isDirectory: false })),
  ]
}

/** Discover ignored-aware, workspace-relative paths without requiring a system fd binary. */
export async function listWorkspacePaths(
  cwd: string,
  signal: AbortSignal,
  executable = rgPath,
): Promise<readonly WorkspacePath[]> {
  if (signal.aborted) return []

  return await new Promise((resolve) => {
    const child = spawn(executable, [
      '--files',
      '--hidden',
      '--no-require-git',
      '--null',
      '--glob',
      '!.git',
      '--glob',
      '!.git/**',
    ], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let output = ''
    let truncated = false
    let settled = false

    const finish = (paths: readonly WorkspacePath[]): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      resolve(paths)
    }
    const abort = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      finish([])
    }

    signal.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const remaining = MAX_DISCOVERY_CHARACTERS - output.length
      if (remaining <= 0) return
      output += chunk.slice(0, remaining)
      if (chunk.length > remaining || output.length === MAX_DISCOVERY_CHARACTERS) {
        truncated = true
        child.kill('SIGKILL')
      }
    })
    child.on('error', () => { finish([]) })
    child.on('close', (code) => {
      if (signal.aborted || (code !== 0 && !truncated)) {
        finish([])
        return
      }
      finish(parseWorkspaceFiles(output))
    })
  })
}

function isTokenStart(text: string, index: number): boolean {
  return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? '')
}

function unclosedQuoteStart(text: string): number | undefined {
  let start: number | undefined
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '"') continue
    start = start === undefined ? index : undefined
  }
  return start
}

/** Return the active @ token immediately before the cursor, including an open quote. */
export function extractWorkspaceReferencePrefix(text: string): string | undefined {
  const quoteStart = unclosedQuoteStart(text)
  if (
    quoteStart !== undefined
    && quoteStart > 0
    && text[quoteStart - 1] === '@'
    && isTokenStart(text, quoteStart - 1)
  ) return text.slice(quoteStart - 1)

  let delimiter = -1
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (!PATH_DELIMITERS.has(text[index] ?? '')) continue
    delimiter = index
    break
  }
  const tokenStart = delimiter + 1
  return text[tokenStart] === '@' ? text.slice(tokenStart) : undefined
}

function pathDepth(path: string): number {
  return path.replace(/\/$/, '').split('/').length
}

function displayPath(entry: WorkspacePath): string | undefined {
  const path = normalizeWorkspacePath(entry.path)
  if (path === undefined) return undefined
  return entry.isDirectory ? `${path}/` : path
}

function pathItems(paths: readonly WorkspacePath[], prefix: string): AutocompleteItem[] {
  const query = prefix.startsWith('@"') ? prefix.slice(2) : prefix.slice(1)
  const normalized = paths.flatMap((entry) => {
    const path = displayPath(entry)
    return path === undefined ? [] : [{ path, isDirectory: entry.isDirectory }]
  })
  const unique = [...new Map(normalized.map(entry => [entry.path, entry])).values()]
  const matches = query.length === 0
    ? unique.sort((left, right) => (
        pathDepth(left.path) - pathDepth(right.path)
        || Number(right.isDirectory) - Number(left.isDirectory)
        || left.path.localeCompare(right.path)
      ))
    : fuzzyFilter(unique, query, entry => entry.path)

  return matches.slice(0, MAX_SUGGESTIONS).map((entry) => {
    const unquoted = entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path
    const name = unquoted.slice(unquoted.lastIndexOf('/') + 1) + (entry.isDirectory ? '/' : '')
    const value = /\s/u.test(entry.path) ? `@"${entry.path}"` : `@${entry.path}`
    return {
      value,
      label: name,
      ...name === entry.path ? {} : { description: entry.path },
    }
  })
}

/** Composer-level adapter: pi-tui keeps slash/local-path behavior; the app owns @ discovery. */
export class ComposerAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters = ['@']
  private readonly delegate: CombinedAutocompleteProvider

  constructor(
    commands: readonly (AutocompleteItem | SlashCommand)[],
    private readonly cwd: string,
    private readonly workspacePaths: WorkspacePathSource = listWorkspacePaths,
  ) {
    this.delegate = new CombinedAutocompleteProvider([...commands], cwd)
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const line = lines[cursorLine] ?? ''
    const prefix = extractWorkspaceReferencePrefix(line.slice(0, cursorCol))
    if (prefix === undefined) {
      return await this.delegate.getSuggestions(lines, cursorLine, cursorCol, options)
    }

    const items = pathItems(await this.workspacePaths(this.cwd, options.signal), prefix)
    if (options.signal.aborted || items.length === 0) return null
    return { items, prefix }
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return this.delegate.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.delegate.shouldTriggerFileCompletion(lines, cursorLine, cursorCol)
  }
}

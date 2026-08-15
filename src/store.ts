/** Markdown file storage for global and project-scoped agent memory. */

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'

const MEMORY_TOPICS = ['preferences', 'conventions', 'decisions', 'debugging'] as const
const TOPIC_PATTERN = /^[a-z][a-z0-9-]*$/u

/** Stable memory scope selected by callers and model-facing tools. */
export type MemoryScope = 'global' | 'project'

/** One supported topic file below a scope's compact MEMORY.md index. */
export type MemoryTopic = (typeof MEMORY_TOPICS)[number]

/** Project identity and local storage directory resolved from one working directory. */
export interface MemoryProject {
  readonly id: string
  readonly root: string
  readonly directory: string
}

/** One Markdown document available in a memory scope. */
export interface MemoryDocument {
  readonly scope: MemoryScope
  readonly topic?: MemoryTopic
  readonly path: string
  readonly exists: boolean
  readonly content: string
  readonly bytes: number
}

/** Before/after bytes for one reversible memory file write. */
export interface MemoryFileMutation {
  readonly path: string
  readonly before: string | null
  readonly after: string | null
}

/** One logical memory update, possibly touching an index and topic file. */
export interface MemoryStoreMutation {
  readonly files: readonly MemoryFileMutation[]
  readonly changed: boolean
}

/** Input accepted by a deterministic Markdown memory write. */
export interface MemoryWriteInput {
  readonly cwd: string
  readonly scope: MemoryScope
  readonly summary: string
  readonly topic?: MemoryTopic
  readonly details?: string
}

/** Input accepted by deterministic removal of one remembered summary. */
export interface MemoryForgetInput {
  readonly cwd: string
  readonly scope: MemoryScope
  readonly summary: string
  readonly topic?: MemoryTopic
}

/** File store construction policy. */
export interface MemoryFileStoreOptions {
  readonly root: string
  readonly maxDocumentBytes: number
  readonly maxSummaryChars: number
  readonly maxDetailsChars: number
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function normalizedLine(value: string): string {
  return value.trim().replaceAll(/\s+/gu, ' ')
}

function normalizedKey(value: string): string {
  return normalizedLine(value).toLocaleLowerCase('en-US')
}

function safeSlug(value: string): string {
  const normalized = value.normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
  return normalized === '' ? 'project' : normalized.slice(0, 48)
}

function normalizeRemote(value: string): string {
  const trimmed = value.trim().replace(/\.git$/u, '')
  try {
    const url = new URL(trimmed)
    url.username = ''
    url.password = ''
    url.hash = ''
    url.search = ''
    return url.toString().replace(/\/$/u, '')
  } catch {
    return trimmed.replace(/^[^@\s]+@/u, '')
  }
}

function runGit(cwd: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolveOutput) => {
    execFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 3_000,
    }, (error, stdout) => {
      resolveOutput(error === null ? stdout.trim() : undefined)
    })
  })
}

async function readableFile(path: string, maxBytes: number): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`memory path is not a regular file: ${path}`)
    if (info.size > maxBytes) {
      throw new Error(`memory document exceeds maxDocumentBytes ${String(maxBytes)}: ${path}`)
    }
    const content = await readFile(path, 'utf8')
    if (utf8Bytes(content) > maxBytes) {
      throw new Error(`memory document exceeds maxDocumentBytes ${String(maxBytes)}: ${path}`)
    }
    return content
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(path), `.memory-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function documentTitle(scope: MemoryScope, topic?: MemoryTopic): string {
  if (topic !== undefined) {
    return `# ${topic[0]?.toLocaleUpperCase('en-US') ?? ''}${topic.slice(1)} memory\n\n`
  }
  return scope === 'global' ? '# Global memory\n\n' : '# Project memory\n\n'
}

function ensureTrailingNewline(value: string): string {
  return `${value.replaceAll(/\n+$/gu, '')}\n`
}

function appendUniqueBullet(content: string | null, title: string, bullet: string, key: string): string {
  const base = content === null || content.trim() === '' ? title : ensureTrailingNewline(content)
  const found = base.split('\n').some((line) => {
    if (!line.startsWith('- ')) return false
    const remembered = normalizedKey(line.slice(2).replace(/\s+\(\[[^\]]+\]\([^)]+\)\)$/u, ''))
    return remembered === key || remembered.startsWith(`${key} — `)
  })
  return found ? base : `${base.endsWith('\n\n') ? base : `${base}\n`}- ${bullet}\n`
}

function removeBullet(content: string | null, summary: string): string | null {
  if (content === null) return null
  const key = normalizedKey(summary)
  const lines = content.split('\n')
  const kept = lines.filter((line) => {
    if (!line.startsWith('- ')) return true
    const remembered = normalizedKey(line.slice(2).replace(/\s+\(\[[^\]]+\]\([^)]+\)\)$/u, ''))
    return remembered !== key && !remembered.startsWith(`${key} — `)
  })
  return ensureTrailingNewline(kept.join('\n'))
}

function assertTopic(topic: string | undefined): asserts topic is MemoryTopic | undefined {
  if (topic === undefined) return
  if (!TOPIC_PATTERN.test(topic) || !(MEMORY_TOPICS as readonly string[]).includes(topic)) {
    throw new Error(`unsupported memory topic "${topic}"`)
  }
}

function containsSensitiveMaterial(value: string): boolean {
  return /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/u.test(value)
    || /\b(?:api[_ -]?key|password|passwd|secret|access[_ -]?token)\s*[:=]\s*[^\s*`]{8,}/iu.test(value)
}

/** Local Markdown implementation used by the Harness service. */
export class MemoryFileStore {
  readonly root: string
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly options: MemoryFileStoreOptions) {
    this.root = resolve(expandHome(options.root))
    for (const [name, value] of Object.entries({
      maxDocumentBytes: options.maxDocumentBytes,
      maxSummaryChars: options.maxSummaryChars,
      maxDetailsChars: options.maxDetailsChars,
    })) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`memory: ${name} must be a positive safe integer`)
      }
    }
  }

  /** Resolve a stable project directory, sharing identity across clones with the same origin URL. */
  async project(cwd: string): Promise<MemoryProject> {
    const gitRoot = await runGit(cwd, ['rev-parse', '--show-toplevel'])
    const root = await realpath(gitRoot === undefined || gitRoot === '' ? cwd : gitRoot)
    const remote = await runGit(root, ['config', '--get', 'remote.origin.url'])
    const identity = remote === undefined || remote === '' ? root : normalizeRemote(remote)
    const digest = createHash('sha256').update(identity).digest('hex').slice(0, 12)
    const id = `${safeSlug(basename(root))}-${digest}`
    return { id, root, directory: join(this.root, 'projects', id) }
  }

  /** Read one bounded Markdown memory document without creating it. */
  async read(cwd: string, scope: MemoryScope, topic?: MemoryTopic): Promise<MemoryDocument> {
    assertTopic(topic)
    const project = await this.project(cwd)
    const path = this.pathFor(project, scope, topic)
    const content = await readableFile(path, this.options.maxDocumentBytes)
    return {
      scope,
      ...topic === undefined ? {} : { topic },
      path,
      exists: content !== null,
      content: content ?? '',
      bytes: content === null ? 0 : utf8Bytes(content),
    }
  }

  /** List existing Markdown documents for both memory scopes. */
  async list(cwd: string): Promise<MemoryDocument[]> {
    const project = await this.project(cwd)
    const documents: MemoryDocument[] = []
    for (const scope of ['project', 'global'] as const) {
      const directory = scope === 'global' ? join(this.root, 'global') : project.directory
      let names: string[]
      try {
        names = await readdir(directory)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      const markdown = names.filter(name => name === 'MEMORY.md' || name.endsWith('.md')).sort()
      for (const name of markdown) {
        const topic = name === 'MEMORY.md' ? undefined : name.slice(0, -3)
        if (topic !== undefined && !(MEMORY_TOPICS as readonly string[]).includes(topic)) continue
        documents.push(await this.read(cwd, scope, topic as MemoryTopic | undefined))
      }
    }
    return documents
  }

  /** Append one deduplicated memory and return the exact reversible file mutation. */
  async write(input: MemoryWriteInput): Promise<MemoryStoreMutation> {
    assertTopic(input.topic)
    const summary = this.cleanText('summary', input.summary, this.options.maxSummaryChars)
    const details = input.details === undefined
      ? undefined
      : this.cleanText('details', input.details, this.options.maxDetailsChars)
    if (containsSensitiveMaterial(`${summary}\n${details ?? ''}`)) {
      throw new Error('memory: refusing to persist content that looks like a credential or secret')
    }
    const project = await this.project(input.cwd)
    const directory = input.scope === 'global' ? join(this.root, 'global') : project.directory
    return this.enqueue(directory, async () => {
      const indexPath = this.pathFor(project, input.scope)
      const beforeIndex = await readableFile(indexPath, this.options.maxDocumentBytes)
      const link = input.topic === undefined ? summary : `${summary} ([${input.topic}](${input.topic}.md))`
      const afterIndex = appendUniqueBullet(
        beforeIndex,
        documentTitle(input.scope),
        link,
        normalizedKey(summary),
      )
      const mutations: MemoryFileMutation[] = []
      if (afterIndex !== beforeIndex) {
        this.assertDocumentSize(afterIndex)
        await atomicWrite(indexPath, afterIndex)
        mutations.push({ path: indexPath, before: beforeIndex, after: afterIndex })
      }
      if (input.topic !== undefined) {
        const topicPath = this.pathFor(project, input.scope, input.topic)
        const beforeTopic = await readableFile(topicPath, this.options.maxDocumentBytes)
        const bullet = details === undefined ? summary : `${summary} — ${details}`
        const afterTopic = appendUniqueBullet(
          beforeTopic,
          documentTitle(input.scope, input.topic),
          bullet,
          normalizedKey(summary),
        )
        if (afterTopic !== beforeTopic) {
          this.assertDocumentSize(afterTopic)
          await atomicWrite(topicPath, afterTopic)
          mutations.push({ path: topicPath, before: beforeTopic, after: afterTopic })
        }
      }
      return { files: mutations, changed: mutations.length > 0 }
    })
  }

  /** Remove one exact remembered summary from its index and optional topic. */
  async forget(input: MemoryForgetInput): Promise<MemoryStoreMutation> {
    assertTopic(input.topic)
    const summary = this.cleanText('summary', input.summary, this.options.maxSummaryChars)
    const project = await this.project(input.cwd)
    const directory = input.scope === 'global' ? join(this.root, 'global') : project.directory
    return this.enqueue(directory, async () => {
      const paths = [
        this.pathFor(project, input.scope),
        ...input.topic === undefined ? [] : [this.pathFor(project, input.scope, input.topic)],
      ]
      const mutations: MemoryFileMutation[] = []
      for (const path of paths) {
        const before = await readableFile(path, this.options.maxDocumentBytes)
        const after = removeBullet(before, summary)
        if (before === null || after === before) continue
        this.assertDocumentSize(after ?? '')
        await atomicWrite(path, after ?? '')
        mutations.push({ path, before, after })
      }
      return { files: mutations, changed: mutations.length > 0 }
    })
  }

  /** Apply an exact before/after mutation direction with stale-state protection. */
  async restore(files: readonly MemoryFileMutation[], direction: 'before' | 'after'): Promise<void> {
    const ordered = direction === 'before' ? [...files].reverse() : [...files]
    if (ordered.length === 0) return
    const directories = new Set(ordered.map(file => dirname(file.path)))
    if (directories.size !== 1) throw new Error('memory mutation files must share one scope directory')
    for (const file of ordered) {
      if (!this.isOwnedPath(file.path)) throw new Error(`memory mutation path is outside the memory root: ${file.path}`)
    }
    await this.enqueue(dirname(ordered[0]?.path ?? this.root), async () => {
      const expected = ordered.map(file => direction === 'before' ? file.after : file.before)
      const replacement = ordered.map(file => direction === 'before' ? file.before : file.after)
      const current = await Promise.all(ordered.map(file => readableFile(file.path, this.options.maxDocumentBytes)))
      for (const [index, file] of ordered.entries()) {
        if (current[index] !== expected[index]) {
          throw new Error(`memory document changed after the checkpoint preview: ${file.path}`)
        }
      }
      const applied: number[] = []
      try {
        for (const [index, file] of ordered.entries()) {
          const content = replacement[index]
          if (content === null) await rm(file.path, { force: true })
          else if (content !== undefined) await atomicWrite(file.path, content)
          applied.push(index)
        }
      } catch (error: unknown) {
        for (const index of applied.reverse()) {
          const file = ordered[index]
          const content = current[index]
          if (file === undefined) continue
          if (content === null) await rm(file.path, { force: true })
          else if (content !== undefined) await atomicWrite(file.path, content)
        }
        throw error
      }
    })
  }

  private pathFor(project: MemoryProject, scope: MemoryScope, topic?: MemoryTopic): string {
    const directory = scope === 'global' ? join(this.root, 'global') : project.directory
    return join(directory, topic === undefined ? 'MEMORY.md' : `${topic}.md`)
  }

  private cleanText(name: string, value: string, maxChars: number): string {
    const normalized = normalizedLine(value)
    if (normalized === '') throw new Error(`memory: ${name} must not be empty`)
    if (normalized.length > maxChars) {
      throw new Error(`memory: ${name} exceeds ${String(maxChars)} characters`)
    }
    return normalized
  }

  private assertDocumentSize(content: string): void {
    const bytes = utf8Bytes(content)
    if (bytes > this.options.maxDocumentBytes) {
      throw new Error(`memory: write would exceed maxDocumentBytes ${String(this.options.maxDocumentBytes)}`)
    }
  }

  private isOwnedPath(path: string): boolean {
    const absolute = resolve(path)
    return absolute === path && absolute.startsWith(`${this.root}${sep}`)
  }

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    this.queues.set(key, current)
    void current.finally(() => {
      if (this.queues.get(key) === current) this.queues.delete(key)
    }).catch(() => {})
    return current
  }
}

/** Public topic vocabulary shared by tools and UI consumers. */
export const memoryTopics: readonly MemoryTopic[] = MEMORY_TOPICS

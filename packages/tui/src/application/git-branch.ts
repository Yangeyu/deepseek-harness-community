import { watch, type FSWatcher } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export type GitBranchSource = (
  cwd: string,
  onChange: (branch: string | undefined) => void,
) => () => void

interface GitHead {
  branch: string | undefined
  path: string
}

async function findGitHead(cwd: string): Promise<string | undefined> {
  let directory = resolve(cwd)
  while (true) {
    const dotGit = join(directory, '.git')
    try {
      const metadata = await stat(dotGit)
      if (metadata.isDirectory()) return join(dotGit, 'HEAD')
      if (metadata.isFile()) {
        const pointer = await readFile(dotGit, 'utf8')
        const gitDirectory = /^gitdir:\s*(.+)\s*$/mu.exec(pointer)?.[1]
        if (gitDirectory !== undefined) return join(resolve(directory, gitDirectory), 'HEAD')
      }
    } catch {
      // Missing, unreadable, and malformed .git entries all mean no status for this level.
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

function parseHead(value: string): string | undefined {
  const head = value.trim()
  if (head.startsWith('ref: refs/heads/')) return head.slice('ref: refs/heads/'.length)
  if (head.startsWith('ref: ')) return head.slice('ref: '.length).replace(/^refs\//u, '')
  return /^[0-9a-f]{7,64}$/iu.test(head) ? `detached@${head.slice(0, 8)}` : undefined
}

async function inspectGitHead(cwd: string): Promise<GitHead | undefined> {
  const path = await findGitHead(cwd)
  if (path === undefined) return undefined
  try {
    return { branch: parseHead(await readFile(path, 'utf8')), path }
  } catch {
    return undefined
  }
}

/** Resolve the nearest repository's symbolic branch, including linked Git worktrees. */
export async function readGitBranch(cwd: string): Promise<string | undefined> {
  return (await inspectGitHead(cwd))?.branch
}

/** Publish branch changes from Git's HEAD file without polling or render-time subprocesses. */
export const watchGitBranch: GitBranchSource = (cwd, onChange) => {
  let disposed = false
  let generation = 0
  let initialized = false
  let published: string | undefined
  let watcher: FSWatcher | undefined
  let watchedDirectory: string | undefined
  let watchedHeadName: string | undefined

  const replaceWatcher = (headPath: string | undefined): void => {
    const nextDirectory = headPath === undefined ? undefined : dirname(headPath)
    const nextHeadName = headPath === undefined ? undefined : basename(headPath)
    if (nextDirectory === watchedDirectory && nextHeadName === watchedHeadName) return
    watcher?.close()
    watcher = undefined
    watchedDirectory = nextDirectory
    watchedHeadName = nextHeadName
    if (nextDirectory === undefined || nextHeadName === undefined) return
    try {
      const next = watch(nextDirectory, { persistent: false }, (_event, filename) => {
        if (filename === null || filename.toString() === nextHeadName) void refresh()
      })
      next.on('error', () => {
        if (watcher !== next) return
        next.close()
        watcher = undefined
        watchedDirectory = undefined
        watchedHeadName = undefined
      })
      watcher = next
    } catch {
      watchedDirectory = undefined
      watchedHeadName = undefined
    }
  }

  async function refresh(): Promise<void> {
    const currentGeneration = ++generation
    const head = await inspectGitHead(cwd)
    if (disposed || currentGeneration !== generation) return
    replaceWatcher(head?.path)
    if (initialized && head?.branch === published) return
    initialized = true
    published = head?.branch
    onChange(published)
  }

  void refresh()
  return () => {
    if (disposed) return
    disposed = true
    generation += 1
    watcher?.close()
  }
}

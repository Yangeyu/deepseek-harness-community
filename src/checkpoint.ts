import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'

const GIT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024

interface Checkpoint {
  id: string
  sessionId: string
  turn: number
  cwd: string
  root: string
  tree: string
  prompt: string
  createdAt: number
  previousTurnEndSeq?: number
}

interface PromptMessage {
  source: { kind: string }
  content: readonly { type: string; text?: string }[]
}

/** One file that differs from the pre-turn worktree checkpoint. */
export interface CheckpointFileChange {
  path: string
  added?: number
  removed?: number
}

/** Lightweight row shown before one checkpoint is inspected. */
export interface RewindCheckpointSummary {
  checkpointId: string
  sessionId: string
  turn: number
  prompt: string
  createdAt: number
  turnChangedFiles?: number
}

/** Immutable confirmation payload for one selected-turn rewind. */
export interface RewindPreview {
  checkpointId: string
  sessionId: string
  turn: number
  prompt: string
  createdAt: number
  previousTurnEndSeq?: number
  files: CheckpointFileChange[]
  currentTree: string
}

function runGit(root: string, args: string[], extraEnv?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile('git', ['-C', root, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
      maxBuffer: GIT_MAX_OUTPUT_BYTES,
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolveOutput(stdout)
        return
      }
      const detail = stderr.trim()
      reject(new Error(detail === '' ? error.message : detail))
    })
  })
}

async function repositoryRoot(cwd: string): Promise<string> {
  const root = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim()
  if (root === '') throw new Error(`directory is not inside a Git worktree: ${cwd}`)
  return realpath(root)
}

async function captureTree(root: string): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-rewind-index-'))
  const index = join(temporary, 'index')
  const env = { GIT_INDEX_FILE: index }
  try {
    const baseTree = (await runGit(root, ['write-tree'])).trim()
    await runGit(root, ['read-tree', baseTree], env)
    await runGit(root, ['add', '-A', '--', '.'], env)
    return (await runGit(root, ['write-tree'], env)).trim()
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

function parseNulList(output: string): string[] {
  return output.split('\0').filter(value => value !== '')
}

async function changedFiles(root: string, before: string, after: string): Promise<CheckpointFileChange[]> {
  const [namesOutput, statsOutput] = await Promise.all([
    runGit(root, ['diff', '--name-only', '-z', '--no-renames', before, after]),
    runGit(root, ['diff', '--numstat', '-z', '--no-renames', before, after]),
  ])
  const stats = new Map<string, Pick<CheckpointFileChange, 'added' | 'removed'>>()
  for (const record of parseNulList(statsOutput)) {
    const first = record.indexOf('\t')
    const second = first === -1 ? -1 : record.indexOf('\t', first + 1)
    if (first === -1 || second === -1) continue
    const addedRaw = record.slice(0, first)
    const removedRaw = record.slice(first + 1, second)
    stats.set(record.slice(second + 1), {
      ...addedRaw === '-' ? {} : { added: Number.parseInt(addedRaw, 10) },
      ...removedRaw === '-' ? {} : { removed: Number.parseInt(removedRaw, 10) },
    })
  }
  return parseNulList(namesOutput).map(path => ({ path, ...stats.get(path) }))
}

function worktreePath(root: string, path: string): string {
  const absolute = resolve(root, path)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (!absolute.startsWith(prefix) || relative(root, absolute).startsWith(`..${sep}`)) {
    throw new Error(`checkpoint contains an invalid worktree path: ${path}`)
  }
  return absolute
}

async function optionalLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function removeEmptyParents(root: string, start: string): Promise<void> {
  let current = start
  while (current !== root && current.startsWith(`${root}${sep}`)) {
    try {
      await rmdir(current)
    } catch (error: unknown) {
      if (['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return
      throw error
    }
    current = dirname(current)
  }
}

async function replaceFromStage(root: string, stage: string, path: string): Promise<void> {
  const source = worktreePath(stage, path)
  const destination = worktreePath(root, path)
  const [sourceInfo, destinationInfo] = await Promise.all([optionalLstat(source), optionalLstat(destination)])
  if (sourceInfo === undefined) {
    if (destinationInfo?.isDirectory()) throw new Error(`cannot remove directory while restoring file path: ${path}`)
    await rm(destination, { force: true })
    await removeEmptyParents(root, dirname(destination))
    return
  }
  if (sourceInfo.isDirectory() || destinationInfo?.isDirectory()) {
    throw new Error(`submodules or file/directory replacements are not supported by rewind: ${path}`)
  }
  await mkdir(dirname(destination), { recursive: true })
  const temporary = join(dirname(destination), `.dsh-rewind-${randomUUID()}`)
  try {
    if (sourceInfo.isSymbolicLink()) {
      await symlink(await readlink(source), temporary)
    } else if (sourceInfo.isFile()) {
      await copyFile(source, temporary, fsConstants.COPYFILE_FICLONE)
      await chmod(temporary, Number(sourceInfo.mode) & 0o777)
    } else {
      throw new Error(`unsupported checkpoint entry type: ${path}`)
    }
    try {
      await rename(temporary, destination)
    } catch (error: unknown) {
      if (!['EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await rm(destination, { force: true })
      await rename(temporary, destination)
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

async function applyTree(root: string, targetTree: string, expectedTree: string): Promise<void> {
  const actualTree = await captureTree(root)
  if (actualTree !== expectedTree) {
    throw new Error('workspace changed after the rewind preview; open the preview again')
  }
  const changes = await changedFiles(root, targetTree, actualTree)
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-rewind-tree-'))
  const index = join(temporary, 'index')
  const stage = join(temporary, 'worktree')
  try {
    await mkdir(stage)
    const env = { GIT_INDEX_FILE: index }
    await runGit(root, ['read-tree', targetTree], env)
    await runGit(root, ['checkout-index', '--all', '--force', `--prefix=${stage}${sep}`], env)
    for (const change of changes) await replaceFromStage(root, stage, change.path)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  if (await captureTree(root) !== targetTree) throw new Error('workspace did not match the checkpoint after restore')
}

function promptText(messages: readonly PromptMessage[]): string | undefined {
  const prompt = messages.find(message => message.source.kind === 'user')
  if (prompt === undefined) return undefined
  const text = prompt.content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('\n')
  return text.trim() === '' ? undefined : text
}

/** Bounded in-memory turn history backed by detached Git worktree trees. */
export class WorkspaceCheckpointStore {
  private readonly checkpoints = new Map<string, Checkpoint[]>()
  private readonly failures = new Map<string, string>()

  constructor(private readonly historyLimit: number) {
    if (!Number.isInteger(historyLimit) || historyLimit < 1) {
      throw new Error('checkpoint history limit must be a positive integer')
    }
  }

  /** Capture the current worktree before one user-authored turn enters its first step. */
  async capture(input: {
    sessionId: string
    turn: number
    cwd: string
    prompt: string
    previousTurnEndSeq?: number
  }): Promise<void> {
    const existing = this.checkpoints.get(input.sessionId) ?? []
    if (existing.at(-1)?.turn === input.turn) return
    const root = await repositoryRoot(input.cwd)
    const tree = await captureTree(root)
    const next = [...existing, {
      id: randomUUID(),
      ...input,
      createdAt: Date.now(),
      root,
      tree,
    }]
    this.checkpoints.set(input.sessionId, next.slice(-this.historyLimit))
    this.failures.delete(input.sessionId)
  }

  /** Remember a non-fatal capture failure for the next rewind request. */
  fail(sessionId: string, error: unknown): void {
    this.failures.set(sessionId, error instanceof Error ? error.message : String(error))
  }

  /** Return newest-last checkpoint rows without reading the live worktree. */
  list(sessionId: string): RewindCheckpointSummary[] {
    return this.requireCheckpoints(sessionId).map(checkpoint => ({
      checkpointId: checkpoint.id,
      sessionId,
      turn: checkpoint.turn,
      prompt: checkpoint.prompt,
      createdAt: checkpoint.createdAt,
    }))
  }

  /** Add per-turn changed-file counts after the list is already visible. */
  async describe(sessionId: string): Promise<RewindCheckpointSummary[]> {
    const checkpoints = this.requireCheckpoints(sessionId)
    const currentTrees = new Map<string, Promise<string>>()
    return Promise.all(checkpoints.map(async (checkpoint, index) => {
      const next = checkpoints[index + 1]
      let turnEndTree: string
      if (next?.root === checkpoint.root) {
        turnEndTree = next.tree
      } else {
        let currentTree = currentTrees.get(checkpoint.root)
        if (currentTree === undefined) {
          currentTree = captureTree(checkpoint.root)
          currentTrees.set(checkpoint.root, currentTree)
        }
        turnEndTree = await currentTree
      }
      const names = await runGit(checkpoint.root, [
        'diff',
        '--name-only',
        '-z',
        '--no-renames',
        checkpoint.tree,
        turnEndTree,
      ])
      return {
        checkpointId: checkpoint.id,
        sessionId,
        turn: checkpoint.turn,
        prompt: checkpoint.prompt,
        createdAt: checkpoint.createdAt,
        turnChangedFiles: parseNulList(names).length,
      }
    }))
  }

  /** Compare the live worktree with one selected user-turn checkpoint. */
  async preview(sessionId: string, checkpointId: string): Promise<RewindPreview> {
    const checkpoint = this.requireCheckpoints(sessionId)
      .find(candidate => candidate.id === checkpointId)
    if (checkpoint === undefined) throw new Error('the selected rewind checkpoint is no longer available')
    const currentTree = await captureTree(checkpoint.root)
    return {
      checkpointId: checkpoint.id,
      sessionId,
      turn: checkpoint.turn,
      prompt: checkpoint.prompt,
      createdAt: checkpoint.createdAt,
      ...checkpoint.previousTurnEndSeq === undefined ? {} : { previousTurnEndSeq: checkpoint.previousTurnEndSeq },
      files: await changedFiles(checkpoint.root, checkpoint.tree, currentTree),
      currentTree,
    }
  }

  /** Restore a confirmed preview and return a guarded rollback for later session-fork failure. */
  async restore(preview: RewindPreview): Promise<() => Promise<void>> {
    const checkpoint = this.checkpoints.get(preview.sessionId)
      ?.find(candidate => candidate.id === preview.checkpointId)
    if (checkpoint === undefined) throw new Error('the selected rewind checkpoint is no longer available')
    await applyTree(checkpoint.root, checkpoint.tree, preview.currentTree)
    return async () => applyTree(checkpoint.root, preview.currentTree, checkpoint.tree)
  }

  /** Move checkpoints before the restored turn onto the forked conversation. */
  continueFrom(preview: RewindPreview, targetSessionId: string): void {
    const checkpoints = this.checkpoints.get(preview.sessionId)
    const selectedIndex = checkpoints?.findIndex(checkpoint => checkpoint.id === preview.checkpointId) ?? -1
    if (selectedIndex === -1) throw new Error('the restored rewind checkpoint is no longer available')
    const ancestors = checkpoints?.slice(0, selectedIndex).map(checkpoint => ({
      ...checkpoint,
      sessionId: targetSessionId,
    })) ?? []

    this.checkpoints.delete(preview.sessionId)
    this.failures.delete(preview.sessionId)
    if (ancestors.length === 0) {
      this.checkpoints.delete(targetSessionId)
    } else {
      this.checkpoints.set(targetSessionId, ancestors)
    }
    this.failures.delete(targetSessionId)
  }

  private requireCheckpoints(sessionId: string): Checkpoint[] {
    const checkpoints = this.checkpoints.get(sessionId)
    if (checkpoints !== undefined && checkpoints.length > 0) return checkpoints
    const failure = this.failures.get(sessionId)
    throw new Error(failure === undefined
      ? 'no rewind checkpoint is available for this session'
      : `the latest checkpoint capture failed: ${failure}`)
  }
}

/** Capture user turns through the documented pre-step waterfall without changing its decision. */
export function installCheckpointCapture(ctx: Context, store: WorkspaceCheckpointStore): void {
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step }, next): Promise<PreStepDecision> => {
    const prompt = step === 1 ? promptText(messages) : undefined
    if (prompt !== undefined) {
      const previous = agent.session.events.findLast(event => event.type === 'turn/end' && event.data.turn < turn)
      try {
        await store.capture({
          sessionId: String(agent.session.id),
          turn,
          cwd: agent.session.header.cwd ?? process.cwd(),
          prompt,
          ...previous === undefined ? {} : { previousTurnEndSeq: previous.seq },
        })
      } catch (error: unknown) {
        store.fail(String(agent.session.id), error)
        ctx.logger.warn(`tui rewind checkpoint failed for session "${agent.session.id}": ${String(error)}`)
      }
    }
    return next()
  })
}

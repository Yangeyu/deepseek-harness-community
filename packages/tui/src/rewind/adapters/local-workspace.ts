import { isUtf8 } from 'node:buffer'
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  CanonicalWorkspaceMutation,
  PreparedWorkspaceRewind,
  RewindFilePlan,
  RewindPlanState,
  WorkspaceMutation,
  WorkspaceMutationInput,
  WorkspaceRewindBackend,
} from '../contracts.ts'
import { planWorkspaceContent } from '../domain/planner.ts'

const MAX_CURRENT_FILE_BYTES = 16 * 1024 * 1024

interface WorkspaceState {
  readonly workspaceRoot: string
  readonly absolutePath: string
  readonly expected: string | null
  readonly target: string | null
}

type PreparedWorkspaceFile =
  | {
    readonly kind: 'applicable'
    readonly plan: Extract<RewindFilePlan, { readonly state: 'safe' | 'mergeable' }>
    readonly state: WorkspaceState
  }
  | {
    readonly kind: 'blocked'
    readonly plan: Extract<RewindFilePlan, { readonly state: 'conflict' | 'unsupported' }>
  }

function nodeErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

function isContained(root: string, path: string): boolean {
  const candidate = relative(root, path)
  return candidate !== '' && candidate !== '..' && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate)
}

function relativeWorkspacePath(root: string, path: string): string | undefined {
  if (!isAbsolute(path)) return undefined
  const candidate = resolve(path)
  const display = relative(root, candidate)
  if (display === '' || display === '..' || display.startsWith(`..${sep}`) || isAbsolute(display)) return undefined
  return display
}

async function assertWorkspacePath(root: string, path: string): Promise<void> {
  const canonicalRoot = await realpath(root)
  let canonicalPath: string
  try {
    canonicalPath = await realpath(path)
  } catch (error: unknown) {
    if (nodeErrorCode(error) !== 'ENOENT') throw error
    canonicalPath = join(await realpath(dirname(path)), basename(path))
  }
  if (!isContained(canonicalRoot, canonicalPath)) {
    throw new Error(`rewind target resolves outside the active workspace: ${path}`)
  }
}

async function readTextState(root: string, path: string): Promise<string | null> {
  await assertWorkspacePath(root, path)
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (error: unknown) {
    if (nodeErrorCode(error) === 'ENOENT') return null
    throw error
  }
  if (!info.isFile()) throw new Error(`rewind supports regular text files only: ${path}`)
  if (info.size > MAX_CURRENT_FILE_BYTES) throw new Error(`file is too large to inspect safely: ${path}`)
  const bytes = await readFile(path)
  if (!isUtf8(bytes)) throw new Error(`file is no longer UTF-8 text: ${path}`)
  return bytes.toString('utf8')
}

async function atomicReplace(root: string, path: string, content: string | null): Promise<void> {
  await assertWorkspacePath(root, path)
  let mode = 0o600
  try {
    const info = await lstat(path)
    if (!info.isFile()) throw new Error(`rewind supports regular text files only: ${path}`)
    mode = info.mode & 0o777
  } catch (error: unknown) {
    if (nodeErrorCode(error) !== 'ENOENT') throw error
  }
  if (content === null) {
    await rm(path, { force: true })
    return
  }
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.dsh-rewind-${globalThis.crypto.randomUUID()}`)
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await chmod(temporary, mode)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function aggregateState(states: readonly RewindPlanState[]): RewindPlanState {
  if (states.includes('unsupported')) return 'unsupported'
  if (states.includes('conflict')) return 'conflict'
  if (states.includes('mergeable')) return 'mergeable'
  return 'safe'
}

async function applyStates(states: readonly WorkspaceState[]): Promise<void> {
  const current = await Promise.all(states.map(state => readTextState(state.workspaceRoot, state.absolutePath)))
  for (const [index, state] of states.entries()) {
    if (current[index] !== state.expected) {
      throw new Error(`workspace changed after the rewind plan: ${state.absolutePath}`)
    }
  }
  const applied: number[] = []
  try {
    for (const [index, state] of states.entries()) {
      await atomicReplace(state.workspaceRoot, state.absolutePath, state.target)
      applied.push(index)
    }
  } catch (error: unknown) {
    const rollbackErrors: unknown[] = []
    for (const index of applied.reverse()) {
      const state = states[index]
      if (state === undefined) continue
      try {
        await atomicReplace(state.workspaceRoot, state.absolutePath, current[index] ?? null)
      } catch (rollbackError: unknown) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`workspace restore failed (${String(error)}) and rollback also failed (${rollbackErrors.map(String).join('; ')})`)
    }
    throw error
  }
}

async function prepareFile(
  workspaceRoot: string,
  path: string,
  mutations: readonly WorkspaceMutation[],
): Promise<PreparedWorkspaceFile> {
  const unsupported = mutations.find(mutation => mutation.kind === 'unsupported')
  if (unsupported?.kind === 'unsupported') {
    return {
      kind: 'blocked',
      plan: { path, state: 'unsupported', reason: unsupported.reason },
    }
  }
  const reversible = mutations.filter((mutation): mutation is Extract<WorkspaceMutation, { kind: 'reversible' }> => (
    mutation.kind === 'reversible'
  ))
  const absolutePath = resolve(workspaceRoot, path)
  let current: string | null
  try {
    current = await readTextState(workspaceRoot, absolutePath)
  } catch (error: unknown) {
    return {
      kind: 'blocked',
      plan: {
        path,
        state: 'conflict',
        reason: error instanceof Error ? error.message : String(error),
      },
    }
  }
  const content = planWorkspaceContent(current, reversible)
  if (content.state === 'conflict') {
    return { kind: 'blocked', plan: { path, state: 'conflict', reason: content.reason } }
  }
  return {
    kind: 'applicable',
    plan: {
      path,
      state: content.state,
      ...content.added === undefined ? {} : { added: content.added },
      ...content.removed === undefined ? {} : { removed: content.removed },
    },
    state: { workspaceRoot, absolutePath, expected: current, target: content.target },
  }
}

/** Local UTF-8 workspace adapter with containment checks and guarded compensation. */
export class LocalWorkspaceRewind implements WorkspaceRewindBackend {
  canonicalizeRoot(root: string): string {
    return resolve(root)
  }

  canonicalizeMutation(pointRoot: string, input: WorkspaceMutationInput): CanonicalWorkspaceMutation {
    const path = relativeWorkspacePath(pointRoot, input.path)
    if (path === undefined) {
      return { kind: 'unsupported', path: input.path, reason: 'The filesystem target is outside the active local workspace.' }
    }
    if (resolve(input.workspaceRoot) !== pointRoot) {
      return { kind: 'unsupported', path, reason: 'The workspace root changed during the turn.' }
    }
    if (input.kind === 'unsupported') return { kind: 'unsupported', path, reason: input.reason }
    return {
      kind: 'reversible',
      path,
      before: input.before,
      after: input.after,
      bytes: new TextEncoder().encode(input.before ?? '').byteLength + new TextEncoder().encode(input.after).byteLength,
    }
  }

  async prepare(workspaceRoot: string, mutations: readonly WorkspaceMutation[]): Promise<PreparedWorkspaceRewind> {
    const byPath = new Map<string, WorkspaceMutation[]>()
    for (const mutation of mutations) {
      const existing = byPath.get(mutation.path) ?? []
      existing.push(mutation)
      byPath.set(mutation.path, existing)
    }
    const prepared = (await Promise.all([...byPath].map(([path, pathMutations]) => (
      prepareFile(workspaceRoot, path, pathMutations)
    )))).sort((left, right) => left.plan.path.localeCompare(right.plan.path))
    const state = aggregateState(prepared.map(file => file.plan.state))
    return {
      state,
      files: prepared.map(file => file.plan),
      apply: async () => {
        if (state === 'conflict' || state === 'unsupported') {
          throw new Error(`the ${state} rewind plan cannot be restored`)
        }
        const applicable = prepared.flatMap(file => file.kind === 'applicable' ? [file.state] : [])
        await applyStates(applicable)
        return async () => applyStates(applicable.map(file => ({
          workspaceRoot: file.workspaceRoot,
          absolutePath: file.absolutePath,
          expected: file.target,
          target: file.expected,
        })))
      },
    }
  }
}

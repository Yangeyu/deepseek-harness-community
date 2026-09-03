import { isUtf8 } from 'node:buffer'
import { lstatSync, realpathSync } from 'node:fs'
import { chmod, lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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

function displayPath(root: string, path: string): string {
  return isContained(root, path) ? relative(root, path) : path
}

async function inspectLocalPath(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (error: unknown) {
    if (nodeErrorCode(error) !== 'ENOENT') throw error
    const parent = dirname(path)
    if (await realpath(parent) !== parent) {
      throw new Error(`rewind target parent identity changed: ${path}`)
    }
    return undefined
  }
  if (info.isSymbolicLink()) throw new Error(`rewind does not restore symbolic links: ${path}`)
  if (!info.isFile()) throw new Error(`rewind supports regular text files only: ${path}`)
  if (info.nlink > 1) throw new Error(`rewind does not restore hard-linked files: ${path}`)
  if (await realpath(path) !== path) throw new Error(`rewind target identity changed: ${path}`)
  return info
}

async function readTextState(path: string): Promise<string | null> {
  const info = await inspectLocalPath(path)
  if (info === undefined) return null
  if (info.size > MAX_CURRENT_FILE_BYTES) throw new Error(`file is too large to inspect safely: ${path}`)
  const bytes = await readFile(path)
  if (!isUtf8(bytes)) throw new Error(`file is no longer UTF-8 text: ${path}`)
  return bytes.toString('utf8')
}

async function atomicReplace(path: string, content: string | null): Promise<void> {
  const info = await inspectLocalPath(path)
  const mode = info === undefined ? 0o600 : Number(info.mode) & 0o777
  if (content === null) {
    await rm(path, { force: true })
    return
  }
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
  const current = await Promise.all(states.map(state => readTextState(state.absolutePath)))
  for (const [index, state] of states.entries()) {
    if (current[index] !== state.expected) {
      throw new Error(`workspace changed after the rewind plan: ${state.absolutePath}`)
    }
  }
  const applied: number[] = []
  try {
    for (const [index, state] of states.entries()) {
      await atomicReplace(state.absolutePath, state.target)
      applied.push(index)
    }
  } catch (error: unknown) {
    const rollbackErrors: unknown[] = []
    for (const index of applied.reverse()) {
      const state = states[index]
      if (state === undefined) continue
      try {
        await atomicReplace(state.absolutePath, current[index] ?? null)
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
  absolutePath: string,
  mutations: readonly WorkspaceMutation[],
): Promise<PreparedWorkspaceFile> {
  const path = displayPath(workspaceRoot, absolutePath)
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
  let current: string | null
  try {
    current = await readTextState(absolutePath)
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
    state: { absolutePath, expected: current, target: content.target },
  }
}

/** Local UTF-8 target adapter with stable identities and guarded compensation. */
export class LocalWorkspaceRewind implements WorkspaceRewindBackend {
  canonicalizeRoot(root: string): string {
    return realpathSync(resolve(root))
  }

  canonicalizeMutation(input: WorkspaceMutationInput): CanonicalWorkspaceMutation {
    const absolutePath = isAbsolute(input.targetKey) ? resolve(input.targetKey) : resolve(input.path)
    if (!isAbsolute(input.path) || !isAbsolute(input.targetKey)) {
      return {
        kind: 'unsupported',
        absolutePath,
        reason: 'The filesystem backend did not provide a local absolute target identity.',
      }
    }
    try {
      const lexicalRoot = resolve(input.sourceRoot)
      const projectedTarget = resolve(
        realpathSync(lexicalRoot),
        relative(lexicalRoot, resolve(input.path)),
      )
      if (projectedTarget !== absolutePath) {
        return {
          kind: 'unsupported',
          absolutePath,
          reason: 'Rewind does not restore paths that resolve through symbolic links.',
        }
      }
      const displayInfo = lstatSync(resolve(input.path))
      if (displayInfo.isSymbolicLink()) {
        return { kind: 'unsupported', absolutePath, reason: 'Rewind does not restore symbolic links.' }
      }
      const targetInfo = lstatSync(absolutePath)
      if (!targetInfo.isFile()) {
        return { kind: 'unsupported', absolutePath, reason: 'Rewind supports regular text files only.' }
      }
      if (targetInfo.nlink > 1) {
        return { kind: 'unsupported', absolutePath, reason: 'Rewind does not restore hard-linked files.' }
      }
    } catch (error: unknown) {
      if (nodeErrorCode(error) !== 'ENOENT') {
        return {
          kind: 'unsupported',
          absolutePath,
          reason: `The local filesystem target could not be inspected: ${String(error)}`,
        }
      }
    }
    if (input.kind === 'unsupported') return { kind: 'unsupported', absolutePath, reason: input.reason }
    return {
      kind: 'reversible',
      absolutePath,
      before: input.before,
      after: input.after,
      bytes: new TextEncoder().encode(input.before ?? '').byteLength + new TextEncoder().encode(input.after).byteLength,
    }
  }

  async prepare(workspaceRoot: string, mutations: readonly WorkspaceMutation[]): Promise<PreparedWorkspaceRewind> {
    const byPath = new Map<string, WorkspaceMutation[]>()
    for (const mutation of mutations) {
      const existing = byPath.get(mutation.absolutePath) ?? []
      existing.push(mutation)
      byPath.set(mutation.absolutePath, existing)
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
          absolutePath: file.absolutePath,
          expected: file.target,
          target: file.expected,
        })))
      },
    }
  }
}

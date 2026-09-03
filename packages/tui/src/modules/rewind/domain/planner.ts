import { applyPatch, diffLines, structuredPatch } from 'diff'
import type { RewindApplicableState, WorkspaceMutation } from '../contracts.ts'

type ReversibleWorkspaceMutation = Extract<WorkspaceMutation, { readonly kind: 'reversible' }>

export type WorkspaceContentPlan =
  | {
    readonly state: RewindApplicableState
    readonly target: string | null
    readonly added?: number
    readonly removed?: number
  }
  | {
    readonly state: 'conflict'
    readonly reason: string
  }

function countChangedLines(before: string | null, after: string | null): { readonly added?: number; readonly removed?: number } {
  let added = 0
  let removed = 0
  for (const change of diffLines(before ?? '', after ?? '')) {
    const lines = change.count ?? 0
    if (change.added) added += lines
    if (change.removed) removed += lines
  }
  return {
    ...added === 0 ? {} : { added },
    ...removed === 0 ? {} : { removed },
  }
}

function reverseMutation(
  current: string | null,
  mutation: ReversibleWorkspaceMutation,
): WorkspaceContentPlan {
  if (current === mutation.after) return { target: mutation.before, state: 'safe' }
  if (current === null) return { state: 'conflict', reason: 'The file was removed after the AI edit.' }
  if (mutation.before === null) {
    return { state: 'conflict', reason: 'The AI-created file has subsequent changes and cannot be removed safely.' }
  }
  const patch = structuredPatch(
    mutation.absolutePath,
    mutation.absolutePath,
    mutation.after,
    mutation.before,
    undefined,
    undefined,
    {
    context: 4,
    },
  )
  const merged = applyPatch(current, patch, { fuzzFactor: 0 })
  if (merged === false) return { state: 'conflict', reason: 'A later change overlaps the AI edit.' }
  return { target: merged, state: 'mergeable' }
}

/** Build a pure reverse-content plan while preserving non-overlapping later edits. */
export function planWorkspaceContent(
  current: string | null,
  mutations: readonly ReversibleWorkspaceMutation[],
): WorkspaceContentPlan {
  let target = current
  let state: RewindApplicableState = 'safe'
  for (const mutation of [...mutations].reverse()) {
    const reversed = reverseMutation(target, mutation)
    if (reversed.state === 'conflict') return reversed
    target = reversed.target
    if (reversed.state === 'mergeable') state = 'mergeable'
  }
  return { state, target, ...countChangedLines(target, current) }
}

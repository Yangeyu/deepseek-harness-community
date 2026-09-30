import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Context } from '@deepseek-ai/cordis'
import type { FsObservation, FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { RewindWorkspaceSink, WorkspaceMutationInput } from '../contracts.ts'

type ObservedMutationOutcome =
  | Pick<Extract<WorkspaceMutationInput, { readonly kind: 'reversible' }>, 'kind' | 'targetKey' | 'path' | 'before' | 'after'>
  | Pick<Extract<WorkspaceMutationInput, { readonly kind: 'unsupported' }>, 'kind' | 'targetKey' | 'path' | 'reason'>

type MutationSource = Pick<WorkspaceMutationInput, 'sessionId' | 'turn' | 'callId' | 'rootCallId' | 'sourceRoot'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
}

/** Decode the shared filesystem result contract without reading provider or tool names. */
export function decodeWorkspaceMutation(
  target: FsTarget,
  value: unknown,
): ObservedMutationOutcome | undefined {
  if (!isRecord(value) || typeof value.path !== 'string' || value.path !== target.displayPath
    || typeof value.after !== 'string') return undefined
  if (exactKeys(value, ['path', 'before', 'after'])) {
    if (typeof value.before !== 'string' || value.before === value.after) return undefined
    return { kind: 'reversible', targetKey: String(target.targetKey), path: value.path, before: value.before, after: value.after }
  }
  if (!exactKeys(value, ['path', 'operation', 'before', 'after'])
    || (value.operation !== 'create' && value.operation !== 'update')
    || (value.before !== null && typeof value.before !== 'string')
    || value.before === value.after) return undefined
  if (value.operation === 'create') {
    if (value.before !== null) return undefined
    return { kind: 'reversible', targetKey: String(target.targetKey), path: value.path, before: null, after: value.after }
  }
  if (value.before === null) {
    return {
      kind: 'unsupported',
      targetKey: String(target.targetKey),
      path: value.path,
      reason: 'The overwritten file was too large or non-text, so the provider omitted its before-state.',
    }
  }
  return { kind: 'reversible', targetKey: String(target.targetKey), path: value.path, before: value.before, after: value.after }
}

function sourceFor(ctx: Context, exec: Readonly<ToolExecution>): MutationSource | undefined {
  const agent = exec.agent
  if (agent === undefined) return undefined
  const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
  if (boundary === undefined || boundary.openTurnStartSeq === null) return undefined
  return {
    sessionId: String(agent.session.id),
    turn: boundary.lastTurn,
    callId: String(exec.callId),
    rootCallId: String(exec.rootCallId),
    sourceRoot: agent.session.header.cwd ?? process.cwd(),
  }
}

/** Attribute normalized filesystem outcomes to their originating Agent turn. */
export function installRewindWorkspaceAdapter(ctx: Context, sink: RewindWorkspaceSink): void {
  const observed = new WeakMap<object, { readonly target: FsTarget; readonly order: number }>()
  const sources = new WeakMap<object, MutationSource>()
  ctx.on('tools/pre-execute', (exec, next) => {
    const source = sourceFor(ctx, exec)
    if (source !== undefined) sources.set(exec, source)
    return next()
  })
  let mutationOrder = 0
  ctx.on('fs/observed', (target: FsTarget, observation: FsObservation, actor: object | undefined) => {
    if (actor !== undefined && observation.kind === 'present') {
      mutationOrder += 1
      observed.set(actor, { target, order: mutationOrder })
    }
  })
  ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    const observation = observed.get(exec)
    observed.delete(exec)
    const source = sources.get(exec)
    sources.delete(exec)
    if (observation === undefined || result.isError) return
    const outcome = decodeWorkspaceMutation(observation.target, result.value)
    if (source === undefined || outcome === undefined) return
    sink.recordWorkspaceMutation({ ...source, ...outcome, order: observation.order })
  })
}

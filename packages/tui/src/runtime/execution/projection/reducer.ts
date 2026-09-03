import type {
  ExecutionBoundary,
  ExecutionDiagnostic,
  ExecutionDiagnosticCode,
  ExecutionError,
  ExecutionKey,
  ExecutionKind,
  ExecutionNode,
  ExecutionOutcome,
} from './types.ts'

interface MutableExecutionNode {
  key: ExecutionKey
  kind: ExecutionKind
  parentKey?: ExecutionKey
  state: ExecutionNode['state']
  durability: ExecutionNode['durability']
}

export const EXECUTION_DIAGNOSTIC_LIMIT = 100

function sameIdentity(
  node: MutableExecutionNode,
  kind: ExecutionKind,
  parentKey: ExecutionKey | undefined,
): boolean {
  return node.kind === kind && node.parentKey === parentKey
}

export class ExecutionReducer {
  private readonly nodes = new Map<ExecutionKey, MutableExecutionNode>()
  private readonly order: ExecutionKey[] = []
  private readonly openKeys = new Set<ExecutionKey>()
  private readonly openByParent = new Map<ExecutionKey, Set<ExecutionKey>>()
  private readonly issues: ExecutionDiagnostic[] = []
  private readonly diagnosticKeys = new Set<string>()

  get(key: ExecutionKey): ExecutionNode | undefined {
    return this.nodes.get(key)
  }

  declare(
    key: ExecutionKey,
    kind: ExecutionKind,
    parentKey: ExecutionKey | undefined,
    at?: ExecutionBoundary,
    durability: ExecutionNode['durability'] = 'durable',
  ): void {
    const current = this.nodes.get(key)
    if (current === undefined) {
      this.diagnoseMissingParent(parentKey, key, at?.seq)
      this.add({
        key,
        kind,
        ...parentKey === undefined ? {} : { parentKey },
        state: { phase: 'pending', ...at === undefined ? {} : { declared: at } },
        durability,
      })
      return
    }
    if (!sameIdentity(current, kind, parentKey)) {
      this.diagnose('identity-conflict', `Execution identity ${key} changed kind or parent.`, key, at?.seq)
      return
    }
    if (current.state.phase === 'settled') {
      this.diagnose('terminal-reopened', `Settled execution ${key} received a declaration.`, key, at?.seq)
    }
  }

  start(
    key: ExecutionKey,
    kind: ExecutionKind,
    parentKey: ExecutionKey | undefined,
    at: ExecutionBoundary,
    durability: ExecutionNode['durability'] = 'durable',
  ): void {
    const current = this.nodes.get(key)
    if (current === undefined) {
      this.diagnoseMissingParent(parentKey, key, at.seq)
      this.add({
        key,
        kind,
        ...parentKey === undefined ? {} : { parentKey },
        state: { phase: 'running', started: at },
        durability,
      })
      return
    }
    if (!sameIdentity(current, kind, parentKey)) {
      this.diagnose('identity-conflict', `Execution identity ${key} changed kind or parent.`, key, at.seq)
      return
    }
    if (current.state.phase === 'pending') {
      current.state = { phase: 'running', started: at }
      return
    }
    if (current.state.phase === 'settled') {
      this.diagnose('terminal-reopened', `Settled execution ${key} received a start.`, key, at.seq)
    }
  }

  settle(
    key: ExecutionKey,
    kind: ExecutionKind,
    parentKey: ExecutionKey | undefined,
    outcome: ExecutionOutcome,
    at: ExecutionBoundary,
    error?: ExecutionError,
  ): void {
    const current = this.nodes.get(key)
    if (current === undefined) {
      this.diagnoseMissingParent(parentKey, key, at.seq)
      this.add({
        key,
        kind,
        ...parentKey === undefined ? {} : { parentKey },
        state: { phase: 'settled', outcome, ended: at, ...error === undefined ? {} : { error } },
        durability: 'durable',
      })
      this.diagnose('missing-start', `Execution ${key} settled without a visible start.`, key, at.seq)
      return
    }
    if (!sameIdentity(current, kind, parentKey)) {
      this.diagnose('identity-conflict', `Execution identity ${key} changed kind or parent.`, key, at.seq)
      return
    }
    if (current.state.phase === 'settled') {
      if (current.state.outcome !== outcome) {
        this.diagnose('conflicting-outcome', `Execution ${key} received conflicting terminal outcomes.`, key, at.seq)
      }
      return
    }
    const started = current.state.phase === 'running' ? current.state.started : undefined
    current.state = {
      phase: 'settled',
      outcome,
      ...started === undefined ? {} : { started },
      ended: at,
      ...error === undefined ? {} : { error },
    }
    this.close(current)
  }

  diagnose(code: ExecutionDiagnosticCode, message: string, key?: ExecutionKey, seq?: number): void {
    const diagnosticKey = `${code}\u0000${String(key ?? '')}\u0000${String(seq ?? '')}\u0000${message}`
    if (this.diagnosticKeys.has(diagnosticKey) || this.issues.length >= EXECUTION_DIAGNOSTIC_LIMIT) return
    this.diagnosticKeys.add(diagnosticKey)
    this.issues.push({ code, message, ...key === undefined ? {} : { key }, ...seq === undefined ? {} : { seq } })
  }

  openChildren(parentKey: ExecutionKey, recursive = false): ExecutionNode[] {
    const direct = [...this.openByParent.get(parentKey) ?? []]
      .flatMap((key): ExecutionNode[] => {
        const node = this.nodes.get(key)
        return node === undefined ? [] : [node]
      })
    const all = recursive
      ? direct.flatMap(node => [node, ...this.openChildren(node.key, true)])
      : direct
    return all
  }

  openNodes(): ExecutionNode[] {
    return [...this.openKeys].flatMap((key): ExecutionNode[] => {
      const node = this.nodes.get(key)
      return node === undefined ? [] : [node]
    })
  }

  has(key: ExecutionKey): boolean {
    return this.nodes.has(key)
  }

  /** Fork disposable derived state without replaying durable history. */
  fork(): ExecutionReducer {
    const fork = new ExecutionReducer()
    for (const [key, node] of this.nodes) fork.nodes.set(key, { ...node })
    fork.order.push(...this.order)
    for (const key of this.openKeys) fork.openKeys.add(key)
    for (const [parentKey, children] of this.openByParent) {
      fork.openByParent.set(parentKey, new Set(children))
    }
    fork.issues.push(...this.issues)
    for (const key of this.diagnosticKeys) fork.diagnosticKeys.add(key)
    return fork
  }

  result(): { nodes: readonly ExecutionNode[]; diagnostics: readonly ExecutionDiagnostic[] } {
    const nodes = this.order.flatMap((key): ExecutionNode[] => {
      const node = this.nodes.get(key)
      if (node === undefined) return []
      const state = node.state.phase === 'pending'
        ? Object.freeze({
            ...node.state,
            ...node.state.declared === undefined ? {} : { declared: Object.freeze({ ...node.state.declared }) },
          })
        : node.state.phase === 'running'
          ? Object.freeze({ ...node.state, started: Object.freeze({ ...node.state.started }) })
          : Object.freeze({
              ...node.state,
              ...node.state.started === undefined ? {} : { started: Object.freeze({ ...node.state.started }) },
              ended: Object.freeze({ ...node.state.ended }),
              ...node.state.error === undefined ? {} : { error: Object.freeze({ ...node.state.error }) },
            })
      return [Object.freeze({ ...node, state })]
    })
    return {
      nodes: Object.freeze(nodes),
      diagnostics: Object.freeze(this.issues.map(issue => Object.freeze({ ...issue }))),
    }
  }

  private add(node: MutableExecutionNode): void {
    this.nodes.set(node.key, node)
    this.order.push(node.key)
    if (node.state.phase === 'settled') return
    this.openKeys.add(node.key)
    if (node.parentKey === undefined) return
    const siblings = this.openByParent.get(node.parentKey) ?? new Set<ExecutionKey>()
    siblings.add(node.key)
    this.openByParent.set(node.parentKey, siblings)
  }

  private close(node: MutableExecutionNode): void {
    this.openKeys.delete(node.key)
    if (node.parentKey === undefined) return
    const siblings = this.openByParent.get(node.parentKey)
    siblings?.delete(node.key)
    if (siblings?.size === 0) this.openByParent.delete(node.parentKey)
  }

  private diagnoseMissingParent(
    parentKey: ExecutionKey | undefined,
    key: ExecutionKey,
    seq: number | undefined,
  ): void {
    if (parentKey !== undefined && !this.nodes.has(parentKey)) {
      this.diagnose('missing-parent', `Execution ${key} references missing parent ${parentKey}.`, key, seq)
    }
  }
}

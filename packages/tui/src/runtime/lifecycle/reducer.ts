import type {
  LifecycleBoundary,
  LifecycleDiagnostic,
  LifecycleDiagnosticCode,
  LifecycleError,
  LifecycleKey,
  LifecycleKind,
  LifecycleNode,
  LifecycleOutcome,
} from './types.ts'

interface MutableLifecycleNode {
  key: LifecycleKey
  kind: LifecycleKind
  parentKey?: LifecycleKey
  state: LifecycleNode['state']
  durability: LifecycleNode['durability']
}

export const LIFECYCLE_DIAGNOSTIC_LIMIT = 100

function sameIdentity(
  node: MutableLifecycleNode,
  kind: LifecycleKind,
  parentKey: LifecycleKey | undefined,
): boolean {
  return node.kind === kind && node.parentKey === parentKey
}

export class LifecycleReducer {
  private readonly nodes = new Map<LifecycleKey, MutableLifecycleNode>()
  private readonly order: LifecycleKey[] = []
  private readonly openKeys = new Set<LifecycleKey>()
  private readonly openByParent = new Map<LifecycleKey, Set<LifecycleKey>>()
  private readonly issues: LifecycleDiagnostic[] = []
  private readonly diagnosticKeys = new Set<string>()

  get(key: LifecycleKey): LifecycleNode | undefined {
    return this.nodes.get(key)
  }

  declare(
    key: LifecycleKey,
    kind: LifecycleKind,
    parentKey: LifecycleKey | undefined,
    at?: LifecycleBoundary,
    durability: LifecycleNode['durability'] = 'durable',
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
      this.diagnose('identity-conflict', `Lifecycle identity ${key} changed kind or parent.`, key, at?.seq)
      return
    }
    if (current.state.phase === 'settled') {
      this.diagnose('terminal-reopened', `Settled lifecycle ${key} received a declaration.`, key, at?.seq)
    }
  }

  start(
    key: LifecycleKey,
    kind: LifecycleKind,
    parentKey: LifecycleKey | undefined,
    at: LifecycleBoundary,
    durability: LifecycleNode['durability'] = 'durable',
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
      this.diagnose('identity-conflict', `Lifecycle identity ${key} changed kind or parent.`, key, at.seq)
      return
    }
    if (current.state.phase === 'pending') {
      current.state = { phase: 'running', started: at }
      return
    }
    if (current.state.phase === 'settled') {
      this.diagnose('terminal-reopened', `Settled lifecycle ${key} received a start.`, key, at.seq)
    }
  }

  settle(
    key: LifecycleKey,
    kind: LifecycleKind,
    parentKey: LifecycleKey | undefined,
    outcome: LifecycleOutcome,
    at: LifecycleBoundary,
    error?: LifecycleError,
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
      this.diagnose('missing-start', `Lifecycle ${key} settled without a visible start.`, key, at.seq)
      return
    }
    if (!sameIdentity(current, kind, parentKey)) {
      this.diagnose('identity-conflict', `Lifecycle identity ${key} changed kind or parent.`, key, at.seq)
      return
    }
    if (current.state.phase === 'settled') {
      if (current.state.outcome !== outcome) {
        this.diagnose('conflicting-outcome', `Lifecycle ${key} received conflicting terminal outcomes.`, key, at.seq)
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

  diagnose(code: LifecycleDiagnosticCode, message: string, key?: LifecycleKey, seq?: number): void {
    const diagnosticKey = `${code}\u0000${String(key ?? '')}\u0000${String(seq ?? '')}\u0000${message}`
    if (this.diagnosticKeys.has(diagnosticKey) || this.issues.length >= LIFECYCLE_DIAGNOSTIC_LIMIT) return
    this.diagnosticKeys.add(diagnosticKey)
    this.issues.push({ code, message, ...key === undefined ? {} : { key }, ...seq === undefined ? {} : { seq } })
  }

  openChildren(parentKey: LifecycleKey, recursive = false): LifecycleNode[] {
    const direct = [...this.openByParent.get(parentKey) ?? []]
      .flatMap((key): LifecycleNode[] => {
        const node = this.nodes.get(key)
        return node === undefined ? [] : [node]
      })
    const all = recursive
      ? direct.flatMap(node => [node, ...this.openChildren(node.key, true)])
      : direct
    return all
  }

  openNodes(): LifecycleNode[] {
    return [...this.openKeys].flatMap((key): LifecycleNode[] => {
      const node = this.nodes.get(key)
      return node === undefined ? [] : [node]
    })
  }

  has(key: LifecycleKey): boolean {
    return this.nodes.has(key)
  }

  result(): { nodes: readonly LifecycleNode[]; diagnostics: readonly LifecycleDiagnostic[] } {
    const nodes = this.order.flatMap((key): LifecycleNode[] => {
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

  private add(node: MutableLifecycleNode): void {
    this.nodes.set(node.key, node)
    this.order.push(node.key)
    if (node.state.phase === 'settled') return
    this.openKeys.add(node.key)
    if (node.parentKey === undefined) return
    const siblings = this.openByParent.get(node.parentKey) ?? new Set<LifecycleKey>()
    siblings.add(node.key)
    this.openByParent.set(node.parentKey, siblings)
  }

  private close(node: MutableLifecycleNode): void {
    this.openKeys.delete(node.key)
    if (node.parentKey === undefined) return
    const siblings = this.openByParent.get(node.parentKey)
    siblings?.delete(node.key)
    if (siblings?.size === 0) this.openByParent.delete(node.parentKey)
  }

  private diagnoseMissingParent(
    parentKey: LifecycleKey | undefined,
    key: LifecycleKey,
    seq: number | undefined,
  ): void {
    if (parentKey !== undefined && !this.nodes.has(parentKey)) {
      this.diagnose('missing-parent', `Lifecycle ${key} references missing parent ${parentKey}.`, key, seq)
    }
  }
}

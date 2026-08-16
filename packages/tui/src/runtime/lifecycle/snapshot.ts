import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy'
import type {
  LifecycleDiagnostic,
  LifecycleKey,
  LifecycleNode,
  LifecycleSnapshot,
} from './types.ts'

export class ImmutableLifecycleSnapshot implements LifecycleSnapshot {
  private readonly byKey: ReadonlyMap<LifecycleKey, LifecycleNode>
  private readonly byParent: ReadonlyMap<LifecycleKey, readonly LifecycleNode[]>
  private readonly bySeq: ReadonlyMap<number, HistoryEntry>
  private readonly activeNodes: readonly LifecycleNode[]

  constructor(
    readonly sessionId: string | undefined,
    readonly generation: number,
    private readonly nodes: readonly LifecycleNode[],
    private readonly issues: readonly LifecycleDiagnostic[],
    entries: readonly HistoryEntry[],
  ) {
    this.byKey = new Map(nodes.map(node => [node.key, node]))
    const children = new Map<LifecycleKey, LifecycleNode[]>()
    for (const node of nodes) {
      if (node.parentKey === undefined) continue
      const siblings = children.get(node.parentKey) ?? []
      siblings.push(node)
      children.set(node.parentKey, siblings)
    }
    this.byParent = new Map([...children].map(([key, value]) => [key, Object.freeze(value)]))
    this.bySeq = new Map(entries.map(entry => [entry.event.seq, entry]))
    this.activeNodes = Object.freeze(nodes.filter(node => node.state.phase !== 'settled'))
  }

  ordered(): readonly LifecycleNode[] {
    return this.nodes
  }

  get(key: LifecycleKey | string): LifecycleNode | undefined {
    return this.byKey.get(key as LifecycleKey)
  }

  childrenOf(key: LifecycleKey | string): readonly LifecycleNode[] {
    return this.byParent.get(key as LifecycleKey) ?? []
  }

  active(): readonly LifecycleNode[] {
    return this.activeNodes
  }

  diagnostics(): readonly LifecycleDiagnostic[] {
    return this.issues
  }

  entry(seq: number | undefined): HistoryEntry | undefined {
    return seq === undefined ? undefined : this.bySeq.get(seq)
  }
}

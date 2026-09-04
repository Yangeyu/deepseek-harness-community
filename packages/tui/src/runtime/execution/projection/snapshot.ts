import type { HistoryEntry } from '../../session/contracts.ts'
import { resolveModelRequest, type StepModelCall } from './model-call.ts'
import type {
  ExecutionDiagnostic,
  ExecutionKey,
  ExecutionNode,
  ExecutionSnapshot,
} from './types.ts'

export class ImmutableExecutionSnapshot implements ExecutionSnapshot {
  private readonly byKey: ReadonlyMap<ExecutionKey, ExecutionNode>
  private readonly byParent: ReadonlyMap<ExecutionKey, readonly ExecutionNode[]>
  private readonly bySeq: ReadonlyMap<number, HistoryEntry>
  private readonly modelCalls: ReadonlyMap<ExecutionKey, StepModelCall>
  private readonly activeNodes: readonly ExecutionNode[]

  constructor(
    readonly sessionId: string | undefined,
    readonly epoch: number,
    private readonly nodes: readonly ExecutionNode[],
    private readonly issues: readonly ExecutionDiagnostic[],
    calls: readonly StepModelCall[],
    private readonly entries: readonly HistoryEntry[],
  ) {
    this.byKey = new Map(nodes.map(node => [node.key, node]))
    const children = new Map<ExecutionKey, ExecutionNode[]>()
    for (const node of nodes) {
      if (node.parentKey === undefined) continue
      const siblings = children.get(node.parentKey) ?? []
      siblings.push(node)
      children.set(node.parentKey, siblings)
    }
    this.byParent = new Map([...children].map(([key, value]) => [key, Object.freeze(value)]))
    this.bySeq = new Map(entries.map(entry => [entry.event.seq, entry]))
    this.modelCalls = new Map(calls.map(call => [call.key, call]))
    this.activeNodes = Object.freeze(nodes.filter(node => node.state.phase !== 'settled'))
  }

  ordered(): readonly ExecutionNode[] {
    return this.nodes
  }

  get(key: ExecutionKey | string): ExecutionNode | undefined {
    return this.byKey.get(key as ExecutionKey)
  }

  childrenOf(key: ExecutionKey | string): readonly ExecutionNode[] {
    return this.byParent.get(key as ExecutionKey) ?? []
  }

  active(): readonly ExecutionNode[] {
    return this.activeNodes
  }

  diagnostics(): readonly ExecutionDiagnostic[] {
    return this.issues
  }

  entry(seq: number | undefined): HistoryEntry | undefined {
    return seq === undefined ? undefined : this.bySeq.get(seq)
  }

  modelCall(key: ExecutionKey | string): StepModelCall | undefined {
    return this.modelCalls.get(key as ExecutionKey)
  }

  modelRequest(key: ExecutionKey | string) {
    return resolveModelRequest(this.entries, this.modelCall(key)?.request)
  }
}

import {
  deriveEventMessage,
  type EpochHeader,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import { SurfaceManager } from '@deepseek-ai/dsh-session/surface'
import type { HistoryEntry } from '../../session/contracts.ts'
import { stepExecutionKey } from './keys.ts'
import type { ExecutionKey } from './types.ts'

type DerivedMessage = NonNullable<ReturnType<typeof deriveEventMessage>>

export interface ModelRequestBoundary {
  /** Inclusive end of the durable request inputs. */
  readonly throughSeq: number
  readonly header: EpochHeader | undefined
  /** Process-local input revision. Replay replaces it; unrelated appends do not. */
  readonly version: symbol
}

export interface StepModelCall {
  readonly key: ExecutionKey
  readonly turn: number
  readonly step: number
  readonly request?: ModelRequestBoundary
  readonly responseSeq?: number
}

export type ModelRequest = EpochHeader['config'] & {
  readonly messages: readonly DerivedMessage[]
  readonly tools?: EpochHeader['tools']
}

export interface ModelRequestIdentity {
  readonly sessionId: string | undefined
  readonly epoch: number
  readonly stepKey: ExecutionKey
  readonly throughSeq: number
}

/** One entry per canonical message, in exactly the same order as request.messages. */
export interface ModelRequestMessageProvenance {
  readonly seq: number
  readonly messageId: DerivedMessage['id']
  readonly source: DerivedMessage['source']
  readonly surfaceOp: SessionEvent['surfaceOp']
  readonly sourceEventSeqs: readonly number[] | undefined
}

export interface ModelRequestDocument {
  /** Harness canonical input, not a captured provider HTTP payload. */
  readonly request: ModelRequest
  readonly provenance: readonly ModelRequestMessageProvenance[]
}

export type ModelRequestAvailability =
  | {
    readonly status: 'available'
    readonly identity: ModelRequestIdentity
    /** Compare with === only, scoped to identity; never persist this token. */
    readonly version: symbol
    /** Replays the canonical Surface on demand; neither descriptor nor runtime caches the result. */
    read(): ModelRequestDocument
  }
  | {
    readonly status: 'missing-history'
    readonly requiredFromSeq: 0
    readonly throughSeq: number
    readonly firstMissingSeq: number
  }
  | {
    readonly status: 'missing-request'
    readonly reason: 'boundary' | 'header'
  }

interface MutableModelCall {
  readonly key: ExecutionKey
  readonly turn: number
  readonly step: number
  request?: ModelRequestBoundary
  responseSeq?: number
}

/** Fold the request/response evidence that belongs to each Step. */
export class StepModelCallAccumulator {
  private readonly calls = new Map<ExecutionKey, MutableModelCall>()
  private activeStep: MutableModelCall | undefined
  private header: EpochHeader | undefined

  apply(entry: HistoryEntry): void {
    const event = entry.event
    switch (event.type) {
      case 'turn/start':
      case 'turn/end':
      case 'step/end':
        this.activeStep = undefined
        return
      case 'step/start':
        this.activeStep = this.call(event.data.turn, event.data.step)
        break
      case 'request/header':
        this.header = event.data.header
        break
      case 'system/message':
      case 'user/message':
      case 'tool/result':
        break
      case 'assistant/message':
        if (event.surfaceOp === 'append') this.call(event.data.turn, event.data.step).responseSeq = event.seq
        return
      default:
        return
    }
    if (this.activeStep !== undefined && this.activeStep.responseSeq === undefined) {
      this.activeStep.request = { throughSeq: event.seq, header: this.header, version: Symbol() }
    }
  }

  result(): readonly StepModelCall[] {
    return [...this.calls.values()].map(call => Object.freeze({ ...call }))
  }

  private call(turn: number, step: number): MutableModelCall {
    const key = stepExecutionKey(turn, step)
    const current = this.calls.get(key)
    if (current !== undefined) return current
    const created = { key, turn, step }
    this.calls.set(key, created)
    return created
  }

}

/**
 * O(1) availability read against a snapshot's validated contiguous prefix.
 * The closure retains only the immutable input log and header, not the snapshot graph.
 * Versions follow ExecutionProjector's immutable append/replay contract, not content hashing.
 */
export function resolveModelRequest(
  entries: readonly HistoryEntry[],
  boundary: ModelRequestBoundary | undefined,
  identity: Omit<ModelRequestIdentity, 'throughSeq'>,
  firstMissingSeq: number,
): ModelRequestAvailability {
  if (boundary === undefined) return { status: 'missing-request', reason: 'boundary' }
  const { throughSeq, header, version } = boundary
  if (firstMissingSeq <= throughSeq) {
    return { status: 'missing-history', requiredFromSeq: 0, throughSeq, firstMissingSeq }
  }
  if (header === undefined) return { status: 'missing-request', reason: 'header' }
  return {
    status: 'available',
    identity: { ...identity, throughSeq },
    version,
    read: () => rebuildModelRequest(entries, throughSeq, header),
  }
}

/** The only canonical reconstruction path, shared by every Request consumer. */
function rebuildModelRequest(
  entries: readonly HistoryEntry[],
  throughSeq: number,
  header: EpochHeader,
): ModelRequestDocument {
  // Availability guarantees the complete contiguous prefix, so seq is its exact index.
  const events = entries.slice(0, throughSeq + 1).map(entry => entry.event)
  const surface = new SurfaceManager(events)
  const messages: DerivedMessage[] = []
  const provenance: ModelRequestMessageProvenance[] = []
  for (const seq of surface.nodes) {
    const event = events[seq]!
    const message = deriveEventMessage(event)
    if (message === null) continue
    messages.push(message)
    provenance.push({
      seq: event.seq,
      messageId: message.id,
      source: message.source,
      surfaceOp: event.surfaceOp,
      sourceEventSeqs: event.sourceEventSeqs,
    })
  }
  return {
    request: {
      ...header.config,
      messages,
      ...header.tools === undefined ? {} : { tools: header.tools },
    },
    provenance,
  }
}

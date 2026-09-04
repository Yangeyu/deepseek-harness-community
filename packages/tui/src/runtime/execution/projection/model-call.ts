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
  readonly seq: number
  readonly header: EpochHeader | undefined
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
  readonly system?: string
  readonly tools?: EpochHeader['tools']
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
        this.activeStep = undefined
        return
      case 'step/start':
        this.activeStep = this.call(event.data.turn, event.data.step)
        return
      case 'step/end':
        this.call(event.data.turn, event.data.step)
        this.activeStep = undefined
        return
      case 'request/header':
        this.header = event.data.header
        if (this.activeStep !== undefined) {
          this.activeStep.request = { seq: event.seq, header: this.header }
        }
        return
      case 'request/context':
        if (this.activeStep !== undefined) this.captureRequest(this.activeStep, event.seq)
        return
      case 'assistant/chunk':
        this.captureRequest(this.call(event.data.turn, event.data.step), event.seq)
        return
      case 'assistant/message': {
        if (event.surfaceOp !== 'append') return
        const call = this.call(event.data.turn, event.data.step)
        this.captureRequest(call, event.seq)
        call.responseSeq ??= event.seq
        return
      }
      default:
        return
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

  private captureRequest(call: MutableModelCall, seq: number): void {
    call.request ??= { seq, header: this.header }
  }
}

/** Rebuild the model-visible request only when its detail is inspected. */
export function resolveModelRequest(
  entries: readonly HistoryEntry[],
  boundary: ModelRequestBoundary | undefined,
): ModelRequest | undefined {
  if (boundary?.header === undefined || entries[0]?.event.seq !== 0) return undefined
  const boundaryIndex = entries.findIndex(entry => entry.event.seq === boundary.seq)
  if (boundaryIndex < 0) return undefined

  const events = entries.slice(0, boundaryIndex).map(entry => entry.event)
  const bySeq = new Map<number, SessionEvent>(events.map(event => [event.seq, event]))
  const surface = new SurfaceManager(events)
  const messages = surface.nodes.flatMap(seq => {
    const event = bySeq.get(seq)
    if (event === undefined) return []
    const message = deriveEventMessage(event)
    return message === null ? [] : [message]
  })
  const header = boundary.header
  return {
    ...header.config,
    messages,
    ...header.system === undefined ? {} : { system: header.system },
    ...header.tools === undefined ? {} : { tools: header.tools },
  }
}

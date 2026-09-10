import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { BlockAssembler, expandAssistantStream, type AssistantStreamRecord, type ContentBlock, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionAssistantStreamBaseline, SessionAssistantStreamFrame } from '@deepseek-ai/dsh-api-session-controller/types'

/** Process-local presentation for the active model attempt; never part of the Session log. */
export interface AssistantPresentation {
  readonly turn: number
  readonly step: number
  readonly content: readonly ContentBlock[]
  readonly reasoningStartedAt?: number | undefined
  readonly reasoningEndedAt?: number | undefined
}

export class AssistantStream {
  private presentation: AssistantPresentation | undefined
  private assembler = new BlockAssembler()
  private attempt: { id: string; turn: number; step: number } | undefined
  private reasoningStartedAt: number | undefined
  private reasoningEndedAt: number | undefined

  replace(baseline?: SessionAssistantStreamBaseline): AssistantPresentation | undefined {
    this.reset()
    const active = baseline?.activeAttempt
    if (active !== undefined) {
      this.attempt = { id: active.attemptId, turn: active.turn, step: active.step }
      for (const member of expandAssistantStream(active.stream as readonly AssistantStreamRecord[])) {
        this.push(member.chunk, member.time)
      }
    }
    return this.snapshot()
  }

  accept(frame: SessionAssistantStreamFrame): AssistantPresentation | undefined {
    if (frame.type === 'start') {
      this.reset()
      this.attempt = { id: frame.attemptId, turn: frame.turn, step: frame.step }
    } else if (frame.attemptId === this.attempt?.id) {
      if (frame.type === 'end') this.reset()
      else this.push(frame.chunk as StreamChunk, frame.time)
    }
    return this.snapshot()
  }

  settle(event: SessionEvent): AssistantPresentation | undefined {
    if ((event.type === 'assistant/attempt' || (event.type === 'assistant/message' && event.surfaceOp === 'append'))
      && event.data.turn === this.attempt?.turn && event.data.step === this.attempt.step) this.reset()
    return this.presentation
  }

  private reset(): void {
    this.presentation = undefined
    this.attempt = undefined
    this.assembler = new BlockAssembler()
    this.reasoningStartedAt = undefined
    this.reasoningEndedAt = undefined
  }

  private push(chunk: StreamChunk, time: number): void {
    this.assembler.push(chunk)
    if (chunk.type === 'reasoning-delta' && chunk.text !== '') this.reasoningStartedAt ??= time
    if (chunk.type === 'text-delta' && chunk.text !== '' && this.reasoningStartedAt !== undefined) this.reasoningEndedAt ??= time
  }

  private snapshot(): AssistantPresentation | undefined {
    this.presentation = this.attempt === undefined ? undefined : {
      turn: this.attempt.turn,
      step: this.attempt.step,
      content: this.assembler.interruptedBlocks(),
      reasoningStartedAt: this.reasoningStartedAt,
      reasoningEndedAt: this.reasoningEndedAt,
    }
    return this.presentation
  }
}

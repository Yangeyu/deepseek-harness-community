import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type {
  SessionHistoryRecord,
  SessionProjectionBaseline as HarnessProjectionBaseline,
  SessionWireEvent,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { snapshotSessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ToolDefinition, ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { HistoryEntry, SessionId } from '../../runtime/session/contracts.ts'
import type { SessionHistoryPage, SessionProjectionBaseline } from '../../runtime/session/history-page.ts'
import type {
  SessionControlFrame,
  SessionFollowFrame,
  SessionPromptReceipt,
  SessionTransport,
} from '../../runtime/session/transport.ts'

type SessionControllerPort = Pick<SessionController,
  | 'cancel'
  | 'control'
  | 'create'
  | 'follow'
  | 'list'
  | 'modelCatalog'
  | 'openWorkspacePath'
  | 'page'
  | 'prompt'
  | 'selectModel'
>

export interface HarnessSessionTransportOptions {
  readonly cwd: string
  readonly controller: SessionControllerPort
  readonly forkSession: SessionTransport['forkSession']
  readonly tools: Pick<ToolRuntime, 'get'>
  readonly toolScope: (sessionId: SessionId) => Parameters<ToolRuntime['get']>[1]
  readonly onStatus: SessionTransport['onStatus']
  readonly onError: SessionTransport['onError']
  readonly onPresenterError?: (message: string) => void
}

interface ToolCallArguments {
  readonly name: string
  readonly args: unknown
}

function eventFromWire(event: SessionWireEvent): SessionEvent {
  // The in-process Controller owns validation; restore its erased wire types here.
  return snapshotSessionEvent(event as unknown as SessionEvent)
}

function eventsFromRecords(records: readonly SessionHistoryRecord[]): SessionEvent[] {
  return records.map(record => eventFromWire(record.event))
}

function projectionBaseline(value: HarnessProjectionBaseline): SessionProjectionBaseline {
  return {
    asOfSeq: value.asOfSeq,
    values: value.values,
  }
}

/** Adapt Controller operations and the composed Host rewind creator to the Session kernel. */
export class HarnessSessionTransport implements SessionTransport {
  constructor(private readonly options: HarnessSessionTransportOptions) {}

  async describeHost(): Promise<{ readonly cwd: string }> {
    return { cwd: this.options.cwd }
  }

  async listSessions(signal = new AbortController().signal) {
    return (await this.options.controller.list({}, signal)).items
  }

  createSession(request: Parameters<SessionTransport['createSession']>[0]) {
    return this.options.controller.create(request)
  }

  forkSession(request: Parameters<SessionTransport['forkSession']>[0]) {
    return this.options.forkSession(request)
  }

  async page(
    request: Parameters<SessionTransport['page']>[0],
    signal: AbortSignal,
  ): Promise<SessionHistoryPage> {
    const page = await this.options.controller.page({
      address: { kind: 'session', sessionId: request.sessionId },
      throughSeq: request.throughSeq,
      maxMessages: request.maxMessages,
      ...request.beforeSeq === undefined ? {} : { beforeSeq: request.beforeSeq },
    }, signal)
    return this.presentPage(request.sessionId, eventsFromRecords(page.records), page.hasMore)
  }

  modelCatalog() {
    return this.options.controller.modelCatalog()
  }

  async selectModel(
    sessionId: Parameters<SessionTransport['selectModel']>[0],
    selection: Parameters<SessionTransport['selectModel']>[1],
  ): Promise<void> {
    await this.options.controller.selectModel({ sessionId, ...selection })
  }

  async prompt(
    request: Parameters<SessionTransport['prompt']>[0],
    signal: AbortSignal,
  ): Promise<SessionPromptReceipt> {
    await this.options.controller.prompt(request, signal)
    return { requestId: request.requestId }
  }

  async cancel(sessionId: Parameters<SessionTransport['cancel']>[0]): Promise<void> {
    this.options.controller.cancel({ sessionId })
  }

  async openPath(path: string, signal: AbortSignal): Promise<void> {
    await this.options.controller.openWorkspacePath({ path }, signal)
  }

  async *follow(
    sessionId: SessionId,
    maxMessages: number,
    signal: AbortSignal,
  ): AsyncIterable<SessionFollowFrame> {
    const calls = new Map<string, ToolCallArguments>()
    for await (const frame of this.options.controller.follow({
      address: { kind: 'session', sessionId },
      maxMessages,
      assistantStream: true,
    }, signal)) {
      if (frame.type === 'snapshot') {
        const events = eventsFromRecords(frame.records)
        calls.clear()
        this.rememberCalls(calls, events)
        yield {
          type: 'snapshot',
          cursor: frame.cursor,
          assistantStream: frame.assistantStream,
          page: this.presentPage(
            sessionId,
            events,
            frame.hasMore,
            projectionBaseline(frame.projections),
          ),
        }
        continue
      }
      if (frame.type === 'assistant-stream') {
        yield frame
        continue
      }
      const event = eventFromWire(frame.event)
      const entry = this.presentEntry(sessionId, event, callId => calls.get(callId))
      this.rememberCalls(calls, [event])
      yield { type: 'event', entry }
    }
  }

  async *control(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    for await (const frame of this.options.controller.control(signal)) {
      if (frame.type === 'baseline') {
        yield {
          type: 'baseline',
          queues: frame.value.queues,
          projections: Object.fromEntries(Object.entries(frame.value.projections)
            .map(([sessionId, value]) => [sessionId, projectionBaseline(value)])),
        }
      } else if (frame.type === 'queue') {
        yield frame
      } else if (frame.type === 'projection') {
        yield frame
      }
    }
  }

  onStatus(listener: Parameters<SessionTransport['onStatus']>[0]): () => void {
    return this.options.onStatus(listener)
  }

  onError(listener: Parameters<SessionTransport['onError']>[0]): () => void {
    return this.options.onError(listener)
  }

  private presentPage(
    sessionId: SessionId,
    events: readonly SessionEvent[],
    hasMore: boolean,
    projections?: SessionProjectionBaseline,
  ): SessionHistoryPage {
    const entries = events.map(event => this.presentEntry(
      sessionId,
      event,
      callId => this.backscanArguments(events, callId),
    ))
    return {
      events: entries,
      hasMore,
      ...projections === undefined ? {} : { projections },
    }
  }

  private presentEntry(
    sessionId: SessionId,
    event: SessionEvent,
    argumentsFor: (callId: string) => ToolCallArguments | undefined,
  ): HistoryEntry {
    const view = this.toolView(sessionId, event, argumentsFor)
    return { event, ...view === undefined ? {} : { view } }
  }

  private toolView(
    sessionId: SessionId,
    event: SessionEvent,
    argumentsFor: (callId: string) => ToolCallArguments | undefined,
  ): HistoryEntry['view'] {
    try {
      if (event.type === 'tool/call') {
        const definition = this.definition(event.data.name, sessionId)
        const view = definition?.presentCall?.(JSON.parse(event.data.arguments))
        return view === undefined ? undefined : { for: 'call', view }
      }
      if (event.type !== 'tool/result') return undefined
      const [result] = event.data.message.content
      const call = argumentsFor(String(event.data.message.source.callId))
      if (call === undefined) return undefined
      const view = this.definition(call.name, sessionId)?.presentResult?.(call.args, {
        content: result.content,
        isError: result.isError === true,
        ...event.data.meta === undefined ? {} : { meta: event.data.meta },
      })
      return view === undefined ? undefined : { for: 'result', view }
    } catch (error: unknown) {
      this.options.onPresenterError?.(
        `tool presenter failed for ${event.type}; using generic rendering: ${String(error)}`,
      )
      return undefined
    }
  }

  private definition(name: string, sessionId: SessionId): ToolDefinition | undefined {
    return this.options.tools.get(name, this.options.toolScope(sessionId))
  }

  private rememberCalls(calls: Map<string, ToolCallArguments>, events: readonly SessionEvent[]): void {
    for (const event of events) {
      if (event.type !== 'tool/call') continue
      try {
        calls.set(String(event.data.callId), {
          name: event.data.name,
          args: JSON.parse(event.data.arguments),
        })
      } catch {
        calls.delete(String(event.data.callId))
      }
    }
  }

  private backscanArguments(events: readonly SessionEvent[], callId: string): ToolCallArguments | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'tool/call' || String(event.data.callId) !== callId) continue
      try {
        return { name: event.data.name, args: JSON.parse(event.data.arguments) }
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

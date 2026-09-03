import type {
  HostFrame,
  MuxFrame,
  PromptContentPart,
  RpcId,
  SessionModels,
  SessionSummary,
} from '@deepseek-ai/dsh-host-apiproxy'
import type { ModelSelection } from '@deepseek-ai/dsh-host-apiproxy'
import type { SessionHistoryPage } from './history-page.ts'
import type { SessionId } from './snapshot.ts'

export interface SessionMuxRequest {
  readonly rpcId: RpcId
  readonly payload: MuxFrame
}

export interface SessionPromptReceipt {
  readonly rpcId: RpcId
  readonly command?: unknown
}

/** Consumer-owned Harness transport required by the Session runtime. */
export interface SessionTransport {
  describeHost(): Promise<{ readonly cwd: string }>
  listSessions(): Promise<readonly SessionSummary[]>
  createSession(request: { readonly cwd: string; readonly sessionId?: SessionId }): Promise<{ readonly sessionId: SessionId }>
  forkSession(request: { readonly sessionId: SessionId; readonly atSeq: number }): Promise<{ readonly sessionId: SessionId }>
  history(request: { readonly sessionId: SessionId; readonly maxMessages: number; readonly beforeSeq?: number }): Promise<SessionHistoryPage>
  models(sessionId: SessionId): Promise<SessionModels>
  selectModel(sessionId: SessionId, selection: ModelSelection): Promise<void>
  prompt(request: {
    readonly sessionId: SessionId
    readonly mode: 'queue' | 'steer'
    readonly content: PromptContentPart[]
    readonly clientTimeZone?: string
  }): Promise<SessionPromptReceipt>
  cancel(sessionId: SessionId): Promise<void>
  openPath(path: string, signal: AbortSignal): Promise<void>
  respond(rpcId: RpcId, value: unknown): Promise<void>
  mux(signal: AbortSignal): AsyncIterable<SessionMuxRequest>
  host(signal: AbortSignal): AsyncIterable<HostFrame>
}

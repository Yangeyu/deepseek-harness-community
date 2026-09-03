import type {
  ClientResponse,
  IApiClient,
  ModelSelection,
  RpcId,
} from '@deepseek-ai/dsh-host-apiproxy'
import type {
  SessionPromptReceipt,
  SessionTransport,
} from '../../runtime/session/transport.ts'

interface RpcResultLike<T> {
  result: { ok: true; value: T } | { ok: false; error: { message: string } }
}

function valueOf<T>(response: RpcResultLike<T>): T {
  if (response.result.ok) return response.result.value
  throw new Error(response.result.error.message)
}

/** Translate concrete ApiProxy responses into the Session runtime's consumer port. */
export class HarnessSessionTransport implements SessionTransport {
  constructor(private readonly api: IApiClient) {}

  async describeHost() {
    const host = valueOf(await this.api.host.describe({}))
    return { cwd: host.cwd }
  }

  async listSessions() {
    return valueOf(await this.api.sessions.list({})).items
  }

  async createSession(request: Parameters<SessionTransport['createSession']>[0]) {
    return valueOf(await this.api.sessions.create(request))
  }

  async forkSession(request: Parameters<SessionTransport['forkSession']>[0]) {
    return valueOf(await this.api.sessions.fork(request))
  }

  async history(request: Parameters<SessionTransport['history']>[0]) {
    return valueOf(await this.api.sessions.history(request))
  }

  async models(sessionId: Parameters<SessionTransport['models']>[0]) {
    return valueOf(await this.api.sessions.models({ sessionId }))
  }

  async selectModel(sessionId: Parameters<SessionTransport['selectModel']>[0], selection: ModelSelection) {
    valueOf(await this.api.sessions.selectModel({ sessionId, ...selection }))
  }

  async prompt(request: Parameters<SessionTransport['prompt']>[0]): Promise<SessionPromptReceipt> {
    const response = await this.api.sessions.prompt(request)
    const value = valueOf(response)
    return {
      rpcId: response.rpcId,
      ...value.command === undefined ? {} : { command: value.command },
    }
  }

  async cancel(sessionId: Parameters<SessionTransport['cancel']>[0]): Promise<void> {
    valueOf(await this.api.sessions.cancel({ sessionId }))
  }

  async openPath(path: string, signal: AbortSignal): Promise<void> {
    valueOf(await this.api.host.openPath({ path }, signal))
  }

  async respond(rpcId: RpcId, value: unknown): Promise<void> {
    const response: ClientResponse = {
      type: 'client-response',
      rpcId,
      result: { ok: true, value },
    }
    const receipt = await this.api.respond(response)
    if (!receipt.accepted) throw new Error(`interaction response was ${receipt.reason}`)
  }

  mux(signal: AbortSignal) {
    return this.api.events.mux({}, signal)
  }

  async *host(signal: AbortSignal) {
    for await (const request of this.api.events.host({}, signal)) yield request.payload
  }
}

import { WebError } from '@deepseek-ai/dsh-web'
import {
  cleanMessage,
  errorDetail,
  isAbortFailure,
  providerAborted,
  requiredApiKey,
  responsePayload,
  throwIfAborted,
  usableCredentialReference,
  usableEndpoint,
  type FetchImplementation,
} from './http.ts'

export interface TavilyClientOptions {
  apiKeyRef: string
  resolveApiKey: () => Promise<string | undefined>
  fetch?: FetchImplementation
}

function errorCode(status: number): string {
  if (status === 401 || status === 403) return 'WEB_UNAUTHORIZED'
  if (status === 429) return 'WEB_RATE_LIMITED'
  if (status === 432 || status === 433) return 'WEB_QUOTA_EXCEEDED'
  return 'WEB_PROVIDER_ERROR'
}

/** Shared Tavily authentication and JSON transport for independent Web capabilities. */
export class TavilyClient {
  constructor(private readonly options: () => TavilyClientOptions) {}

  available(endpoint: string): boolean {
    const options = this.options()
    return usableEndpoint(endpoint) && usableCredentialReference(options.apiKeyRef)
  }

  async post(
    operation: string,
    endpoint: string,
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const options = this.options()
    const apiKey = await requiredApiKey(operation, options.apiKeyRef, options.resolveApiKey, signal)
    throwIfAborted(operation, signal)
    let response: Response
    try {
      response = await (options.fetch ?? globalThis.fetch)(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortFailure(error)) throw providerAborted(operation, signal, error)
      throw new WebError(`${operation} request failed: ${cleanMessage(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    const payload = await responsePayload(response, operation, signal)
    if (!response.ok) {
      const detail = errorDetail(payload) ?? `${operation} API error (HTTP ${String(response.status)})`
      throw new WebError(detail, errorCode(response.status))
    }
    return payload
  }
}

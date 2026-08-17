import { WebError } from '@deepseek-ai/dsh-web'
import { TAVILY_PROVIDER_ID, type TavilyExtractDepth } from './config.ts'
import type { WebExtractProvider, WebExtractRequest, WebExtractResult } from './extract.ts'
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

const MAX_URL_CHARS = 8_192

export interface TavilyExtractProviderOptions {
  endpoint: string
  apiKeyRef: string
  resolveApiKey: () => Promise<string | undefined>
  extractDepth: TavilyExtractDepth
  maxOutputChars: number
  timeoutSeconds: number
  fetch?: FetchImplementation
}

function targetUrl(value: string): string {
  if (value.length > MAX_URL_CHARS) throw new WebError('Tavily extract URL is too long', 'WEB_INVALID_URL')
  let url: URL
  try {
    url = new URL(value)
  } catch (error: unknown) {
    throw new WebError('Tavily extract requires an absolute HTTP(S) URL', 'WEB_INVALID_URL', { cause: error })
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') {
    throw new WebError('Tavily extract requires an HTTP(S) URL without embedded credentials', 'WEB_INVALID_URL')
  }
  return url.href
}

function resultRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function failedDetail(payload: Record<string, unknown>): string | undefined {
  if (!Array.isArray(payload.failed_results)) return undefined
  for (const value of payload.failed_results) {
    const failed = resultRecord(value)
    if (failed === undefined) continue
    if (typeof failed.error === 'string' && failed.error.trim() !== '') return cleanMessage(failed.error)
    if (typeof failed.message === 'string' && failed.message.trim() !== '') return cleanMessage(failed.message)
  }
  return undefined
}

function mapResponse(payload: unknown, requestedUrl: string, maximum: number): WebExtractResult {
  const body = resultRecord(payload)
  if (body === undefined) throw new WebError('Tavily Extract returned an unprocessable response body', 'WEB_PROVIDER_ERROR')
  const candidates = Array.isArray(body.results) ? body.results : []
  const result = candidates.map(resultRecord).find(candidate => (
    typeof candidate?.raw_content === 'string'
    && candidate.raw_content.trim() !== ''
  ))
  if (result === undefined) {
    throw new WebError(failedDetail(body) ?? 'Tavily could not extract content from the requested URL', 'WEB_EXTRACT_FAILED')
  }
  const rawContent = result.raw_content as string
  const content = rawContent.slice(0, maximum)
  const resolvedUrl = typeof result.url === 'string' && result.url.trim() !== ''
    ? targetUrl(result.url)
    : requestedUrl
  return {
    url: resolvedUrl,
    content,
    truncated: content.length !== rawContent.length,
  }
}

function errorCode(status: number): string {
  if (status === 401 || status === 403) return 'WEB_UNAUTHORIZED'
  if (status === 429) return 'WEB_RATE_LIMITED'
  if (status === 432 || status === 433) return 'WEB_QUOTA_EXCEEDED'
  return 'WEB_PROVIDER_ERROR'
}

/** Tavily adapter for the community-owned, provider-neutral extraction seam. */
export class TavilyExtractProvider implements WebExtractProvider {
  readonly id = TAVILY_PROVIDER_ID

  constructor(private readonly options: () => TavilyExtractProviderOptions) {}

  available(): boolean {
    const options = this.options()
    return usableEndpoint(options.endpoint)
      && usableCredentialReference(options.apiKeyRef)
      && Number.isInteger(options.maxOutputChars)
      && options.maxOutputChars > 0
      && options.timeoutSeconds >= 1
      && options.timeoutSeconds <= 60
  }

  async extract(request: WebExtractRequest, signal?: AbortSignal): Promise<WebExtractResult> {
    const options = this.options()
    const url = targetUrl(request.url)
    const apiKey = await requiredApiKey('Tavily Extract', options.apiKeyRef, options.resolveApiKey, signal)
    throwIfAborted('Tavily Extract', signal)
    let response: Response
    try {
      response = await (options.fetch ?? globalThis.fetch)(options.endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          urls: url,
          extract_depth: options.extractDepth,
          include_images: false,
          format: 'markdown',
          timeout: options.timeoutSeconds,
          include_usage: true,
        }),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortFailure(error)) throw providerAborted('Tavily Extract', signal, error)
      throw new WebError(`Tavily Extract request failed: ${cleanMessage(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    const payload = await responsePayload(response, 'Tavily Extract', signal)
    if (!response.ok) {
      const detail = errorDetail(payload) ?? `Tavily Extract API error (HTTP ${String(response.status)})`
      throw new WebError(detail, errorCode(response.status))
    }
    return mapResponse(payload, url, options.maxOutputChars)
  }
}

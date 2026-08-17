import { WebError } from '@deepseek-ai/dsh-web'
import { TAVILY_PROVIDER_ID, type TavilyExtractDepth } from './config.ts'
import type { WebExtractProvider, WebExtractRequest, WebExtractResult } from './extract.ts'
import { cleanMessage } from './http.ts'
import { TavilyClient } from './tavily-client.ts'

const MAX_URL_CHARS = 8_192

export interface TavilyExtractProviderOptions {
  endpoint: string
  extractDepth: TavilyExtractDepth
  maxOutputChars: number
  timeoutSeconds: number
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

/** Tavily adapter for the community-owned, provider-neutral extraction seam. */
export class TavilyExtractProvider implements WebExtractProvider {
  readonly id = TAVILY_PROVIDER_ID

  constructor(
    private readonly client: TavilyClient,
    private readonly options: () => TavilyExtractProviderOptions,
  ) {}

  available(): boolean {
    const options = this.options()
    return this.client.available(options.endpoint)
      && Number.isInteger(options.maxOutputChars)
      && options.maxOutputChars > 0
      && options.timeoutSeconds >= 1
      && options.timeoutSeconds <= 60
  }

  async extract(request: WebExtractRequest, signal?: AbortSignal): Promise<WebExtractResult> {
    const options = this.options()
    const url = targetUrl(request.url)
    const payload = await this.client.post('Tavily Extract', options.endpoint, {
      urls: url,
      extract_depth: options.extractDepth,
      include_images: false,
      format: 'markdown',
      timeout: options.timeoutSeconds,
      include_usage: true,
    }, signal)
    return mapResponse(payload, url, options.maxOutputChars)
  }
}

import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ResolvedBailianConfig } from './config.ts'
import { translateResponse } from './response.ts'
import { parseSse } from './sse.ts'
import type { WireError, WireRequest } from './types.ts'

function retryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id')
    ?? headers.get('x-dashscope-request-id')
    ?? headers.get('request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

export function httpErrorCode(status: number, error?: WireError['error']): string {
  if (status === 401 || status === 403) return 'AUTH'
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

export async function* streamBailianResponse(input: {
  config: ResolvedBailianConfig
  apiKey: string
  body: WireRequest
  signal: AbortSignal
  onComment: () => void
}): AsyncGenerator<StreamChunk> {
  let response: Response
  try {
    response = await fetch(`${input.config.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        ...attributionHeaders(),
      },
      body: JSON.stringify(input.body),
      signal: input.signal,
    })
  } catch (error: unknown) {
    if (input.signal.aborted) throw error
    throw new LlmError(`Bailian API request to ${input.config.baseURL} failed`, 'TRANSPORT', { cause: error })
  }

  if (!response.ok) {
    let message = `Bailian API error (HTTP ${String(response.status)})`
    let providerError: WireError['error']
    try {
      const parsed = await response.json() as WireError
      providerError = parsed.error
      message = providerError?.message ?? parsed.message ?? message
    } catch {}
    const delay = retryAfterMs(response.headers.get('retry-after'))
    const id = requestId(response.headers)
    throw new LlmError(message, httpErrorCode(response.status, providerError), {
      status: response.status,
      ...delay === undefined ? {} : { providerRetryAfterMs: delay },
      ...id === undefined ? {} : { requestId: id },
    })
  }
  if (response.body === null) throw new LlmError('Bailian API returned no response body', 'EMPTY_RESPONSE')
  yield* translateResponse(parseSse(response.body, input.onComment))
}

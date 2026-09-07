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
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { translateResponse } from './response.ts'
import { parseSse } from './sse.ts'
import type { WireError, WireRequest } from './types.ts'

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

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
  baseURL: string
  streamIdleTimeoutMs: number
  apiKey: string
  body: WireRequest
  signal?: AbortSignal
}): AsyncGenerator<StreamChunk> {
  const consumer = new AbortController()
  const upstream = input.signal === undefined
    ? consumer.signal
    : AbortSignal.any([input.signal, consumer.signal])
  using watchdog = idleWatchdog(upstream, input.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
  let response: Response | undefined

  async function* request(): AsyncGenerator<StreamChunk> {
    response = await fetch(`${input.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
        'accept': 'text/event-stream',
        ...attributionHeaders(),
      },
      body: JSON.stringify(input.body),
      signal: watchdog.signal,
    })
    watchdog.pulse()

    if (!response.ok) {
      let message = `Bailian API error (HTTP ${String(response.status)})`
      let providerError: WireError['error']
      try {
        const parsed = await response.json() as WireError
        providerError = parsed.error
        message = providerError?.message ?? parsed.message ?? message
      } catch {}
      throw new LlmError(message, httpErrorCode(response.status, providerError))
    }
    if (response.body === null) throw new LlmError('Bailian API returned no response body', 'EMPTY_RESPONSE')
    yield* translateResponse(parseSse(response.body, () => watchdog.pulse()))
  }

  const iterator = request()
  try {
    while (true) {
      const result = await watchdog.next(iterator)
      if (result.done) return
      yield result.value
    }
  } catch (error: unknown) {
    const failure = timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined
      ? { message: `Bailian stream idle timeout after ${String(input.streamIdleTimeoutMs)}ms`, code: 'TIMEOUT' }
      : input.signal?.aborted
        ? { message: 'Bailian request aborted by caller', code: 'ABORTED' }
        : error instanceof LlmError
          ? error.failure
          : { message: `Bailian API request to ${input.baseURL} failed`, code: 'TRANSPORT' }
    const id = response === undefined ? undefined : requestId(response.headers)
    const delay = response === undefined || response.ok ? undefined : retryAfterMs(response.headers.get('retry-after'))
    throw new LlmError(failure.message, failure.code, {
      ...failure,
      ...response === undefined ? {} : { status: response.status },
      ...id === undefined ? {} : { requestId: id },
      ...delay === undefined ? {} : { providerRetryAfterMs: delay },
      cause: error,
    })
  } finally {
    consumer.abort('Bailian stream consumer stopped')
    try { await iterator.return(undefined) } catch {}
  }
}

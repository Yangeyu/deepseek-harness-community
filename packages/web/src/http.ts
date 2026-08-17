import { WebError } from '@deepseek-ai/dsh-web'

export type FetchImplementation = typeof globalThis.fetch

const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\x1B\[[0-?]*[ -/]*[@-~]`, 'gu')
const MAX_ERROR_DETAIL_CHARS = 500
const MAX_PROVIDER_RESPONSE_CHARS = 5_000_000

export function cleanMessage(value: unknown): string {
  const clean = String(value)
    .replaceAll(ANSI_ESCAPE_PATTERN, '')
    .replaceAll(/\p{Cc}/gu, character => character === '\n' || character === '\t' ? character : '')
    .trim()
  return clean.length <= MAX_ERROR_DETAIL_CHARS ? clean : `${clean.slice(0, MAX_ERROR_DETAIL_CHARS - 1)}…`
}

export function providerAborted(provider: string, signal?: AbortSignal, cause?: unknown): WebError {
  return new WebError(`${provider} request aborted`, 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : cause,
  })
}

export function isAbortFailure(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function throwIfAborted(provider: string, signal?: AbortSignal): void {
  if (signal?.aborted === true) throw providerAborted(provider, signal)
}

export async function abortable<T>(
  provider: string,
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) throw providerAborted(provider, signal)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(providerAborted(provider, signal))
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(value => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

export async function responsePayload(response: Response, provider: string, signal?: AbortSignal): Promise<unknown> {
  let text: string
  try {
    text = await response.text()
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortFailure(error)) throw providerAborted(provider, signal, error)
    throw new WebError(`${provider} response could not be read: ${cleanMessage(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  if (text.length > MAX_PROVIDER_RESPONSE_CHARS) {
    throw new WebError(`${provider} response exceeded the provider response limit`, 'WEB_PROVIDER_ERROR')
  }
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

export function errorDetail(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  if (typeof record.message === 'string') return cleanMessage(record.message)
  if (typeof record.error === 'string') return cleanMessage(record.error)
  if (typeof record.error === 'object' && record.error !== null && !Array.isArray(record.error)) {
    const nested = record.error as Record<string, unknown>
    if (typeof nested.message === 'string') return cleanMessage(nested.message)
    if (typeof nested.detail === 'string') return cleanMessage(nested.detail)
  }
  if (typeof record.detail === 'string') return cleanMessage(record.detail)
  if (typeof record.detail === 'object' && record.detail !== null && !Array.isArray(record.detail)) {
    const nested = record.detail as Record<string, unknown>
    if (typeof nested.error === 'string') return cleanMessage(nested.error)
    if (typeof nested.message === 'string') return cleanMessage(nested.message)
  }
  return undefined
}

export async function requiredApiKey(
  provider: string,
  reference: string,
  resolveApiKey: () => Promise<string | undefined>,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(provider, signal)
  let value: string | undefined
  try {
    value = await abortable(provider, resolveApiKey(), signal)
  } catch (error: unknown) {
    if (error instanceof WebError) throw error
    if (signal?.aborted === true || isAbortFailure(error)) throw providerAborted(provider, signal, error)
    throw new WebError(`${provider} credential resolution failed: ${cleanMessage(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  throwIfAborted(provider, signal)
  if (value === undefined || value.trim() === '') {
    throw new WebError(
      `${provider} has no API key for "${cleanMessage(reference)}"; configure it through the Harness credentials service or export it before launching dsh-tui`,
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
  return value
}

export function usableEndpoint(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && url.username === ''
      && url.password === ''
  } catch {
    return false
  }
}

export function usableCredentialReference(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
}

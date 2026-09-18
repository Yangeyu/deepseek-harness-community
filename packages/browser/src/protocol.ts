export interface BrowserAction {
  id: string
  kind: 'click' | 'fill' | 'select' | 'scroll' | 'wait'
  label: string
  role?: string
  checked?: string
  selected?: string
  expanded?: string
}

export interface Observation {
  observationId: string
  url: string
  title: string
  text: string
  actions: BrowserAction[]
  omittedActions: number
  screenshot?: string
}

export type BrowserCommand =
  | { op: 'open'; url: string }
  | { op: 'observe'; screenshot: boolean }
  | { op: 'act'; observationId: string; actionId: string; text?: string }
  | { op: 'close' }

export class BrowserError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'BrowserError'
  }
}

export function browserUrl(raw: string): URL {
  if (raw.length > 8192 || /\s/u.test(raw)) throw new BrowserError('invalid', 'Browser URL must be at most 8192 characters without whitespace.')
  let url: URL
  try { url = new URL(raw) } catch { throw new BrowserError('invalid', 'Browser URL must be an absolute HTTP(S) URL.') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new BrowserError('invalid', 'Browser URL must be HTTP(S), without embedded credentials.')
  }
  return url
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

/** Worker observations contain public evidence only; never carry executor node IDs or guards. */
export function parseObservation(value: unknown, origin: string): Observation {
  const invalid = () => new BrowserError('protocol', 'Invalid browser observation; no action is available.')
  if (!object(value) || !boundedString(value.observationId, 128) || !value.observationId
    || !boundedString(value.url, 8192) || !boundedString(value.title, 2000) || !boundedString(value.text, 20000)
    || !Array.isArray(value.actions) || value.actions.length > 253
    || !Number.isSafeInteger(value.omittedActions) || (value.omittedActions as number) < 0) throw invalid()
  if (browserUrl(value.url).origin !== origin) throw new BrowserError('origin_changed', 'Browser left its approved origin. Close it and request access to the new site separately.')
  const seen = new Set<string>()
  const actions: BrowserAction[] = value.actions.map(item => {
    if (!object(item) || !boundedString(item.id, 128) || !item.id || seen.has(item.id)
      || !['click', 'fill', 'select', 'scroll', 'wait'].includes(String(item.kind))
      || !boundedString(item.label, 2000)) throw invalid()
    seen.add(item.id)
    const action: BrowserAction = { id: item.id, kind: item.kind as BrowserAction['kind'], label: item.label }
    for (const key of ['role', 'checked', 'selected', 'expanded'] as const) {
      if (item[key] !== undefined) {
        if (!boundedString(item[key], 2000)) throw invalid()
        action[key] = item[key]
      }
    }
    return action
  })
  if (value.screenshot !== undefined && (!boundedString(value.screenshot, 16 * 1024 * 1024)
    || !value.screenshot || value.screenshot.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.screenshot))) throw invalid()
  return {
    observationId: value.observationId, url: value.url, title: value.title, text: value.text,
    actions, omittedActions: value.omittedActions as number,
    ...(value.screenshot === undefined ? {} : { screenshot: value.screenshot as string }),
  }
}

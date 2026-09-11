import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RequestBrowser } from '../../../src/modules/trajectory/request-browser.ts'
import { TextDocument } from '../../../src/presentation/primitives/text-document.ts'
import { createTheme } from '../../../src/presentation/primitives/theme.ts'
import type { SurfaceInputAction } from '../../../src/presentation/primitives/surface-input.ts'
import type { ModelRequestAvailability, ModelRequestDocument } from '../../../src/runtime/execution/projection/model-call.ts'
import { stepExecutionKey } from '../../../src/runtime/execution/projection/index.ts'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'

type Message = ModelRequestDocument['request']['messages'][number]
const scopes: LifecycleScope[] = []
afterEach(async () => { await Promise.all(scopes.splice(0).map(scope => scope.dispose())); vi.restoreAllMocks() })

function message(id: string, text: string, role: Message['role'] = 'user', source: Message['source'] = { kind: 'user' }): Message {
  return { id, role, source, content: [{ type: 'text', text }] } as Message
}

function available(messages = [message('input', 'Natural first line\nNatural second line')], extra = {}): Extract<ModelRequestAvailability, { status: 'available' }> {
  return {
    status: 'available', version: Symbol('request'),
    identity: { sessionId: 'browser-session', epoch: 1, stepKey: stepExecutionKey(1, 1), throughSeq: 42 },
    read: vi.fn(() => ({ request: { provider: 'test', model: 'test', tools: [], messages, ...extra }, provenance: [] })),
  }
}

function setup(load = vi.fn(async () => true), color = false) {
  const scope = new LifecycleScope('browser-test')
  scopes.push(scope)
  const changed = vi.fn()
  const browser = new RequestBrowser(createTheme(color), scope, changed, load)
  return { browser, scope, changed, load }
}

const text = (browser: RequestBrowser, width = 180, height = 30): string => browser.render(width, height).map(stripTerminalSequences).join('\n')
function input(browser: RequestBrowser, action: SurfaceInputAction, value: string): void {
  expect(browser.handleAction(action)).toBe(true)
  // pi-tui Input owns editing and paste semantics, not RequestBrowser.
  browser.handleInput('\u0005')
  browser.handleInput('\u0015')
  browser.handleInput(value)
  browser.handleAction('surface.confirm')
}
async function search(browser: RequestBrowser, query: string, count: number): Promise<void> {
  input(browser, 'surface.search', query)
  await vi.waitFor(() => expect(text(browser)).toContain(`${count === 0 ? 0 : 1}/${count} hits`))
}
function clickHeading(browser: RequestBrowser, heading: string): void {
  const lines = browser.render(180, 80)
  const row = lines.findIndex(line => stripTerminalSequences(line).includes(heading))
  expect(row).toBeGreaterThan(-1)
  expect(browser.handlePointer({ kind: 'click', row, column: 6 })).toBe(true)
}

const missing = { status: 'missing-history', requiredFromSeq: 0, throughSeq: 42, firstMissingSeq: 0 } as const

describe('RequestBrowser', () => {
  it('keeps canonical directory order and initially focuses the latest human input, not the last system message', async () => {
    const { browser } = setup()
    const descriptor = available([
      message('old', 'Older input'),
      message('middle', 'Instructions in actual order', 'system', { kind: 'plugin', plugin: 'system-prompt' }),
      message('latest', 'Newest human input'),
      message('tail', 'Trailing instructions', 'system', { kind: 'plugin', plugin: 'system-prompt' }),
    ])
    await browser.open(descriptor)
    expect(text(browser)).toContain('› ▾ #3 User input')
    for (let index = 0; index < 4; index++) browser.handleAction('surface.section-previous')
    const directory = text(browser, 180, 80)
    const labels = ['Config', 'Tools', '#1 User input', '#2 System instructions', '#3 User input', '#4 System instructions']
    expect(labels.map(item => directory.indexOf(item))).toEqual(labels.map(item => directory.indexOf(item)).sort((a, b) => a - b))
    expect(directory).not.toContain('Session browser-session')
    expect(browser.inputContext).toBe('request')
    for (let index = 0; index < 4; index++) browser.handleAction('surface.section-next')
    await browser.open({ ...descriptor })
    expect(descriptor.read).toHaveBeenCalledOnce()
    expect(text(browser)).toContain('› ▾ #3 User input')
  })

  it('reads natural multiline bodies in place and opens complete canonical JSON explicitly', async () => {
    const { browser } = setup()
    await browser.open(available())
    const anchor = text(browser)
    expect(anchor).toContain('    Natural first line\n    Natural second line')
    const row = browser.render(180, 30).findIndex(line => line.trim() === 'Natural second line')
    expect(browser.handlePointer({ kind: 'click', row, column: 6 })).toBe(false)
    expect(text(browser)).toBe(anchor)
    expect(browser.handleAction('surface.back')).toBe(false)
    browser.handleAction('surface.request-format')
    const json = text(browser, 180, 100)
    expect(json).toContain('"messages": [')
    expect(json).toContain('Natural first line\\nNatural second line')
    expect(json).toContain('"tools": []')
    expect(browser.handleAction('surface.back')).toBe(true)
    expect(browser.handleAction('surface.back')).toBe(false)
    expect(browser.handleAction('surface.tab-next')).toBe(false)
    expect(browser.handleAction('surface.interrupt-or-cancel')).toBe(false)
  })

  it('keeps hi compact and technical metadata folded until explicitly opened', async () => {
    const { browser } = setup()
    await browser.open(available([message('input-id', 'hi', 'user', { kind: 'user', rpcId: 'rpc-private', timezone: 'Asia/Shanghai' } as Message['source'])]))
    const directory = text(browser)
    expect(directory).toContain('▾ #1 User input\n    hi\n')
    browser.handleAction('surface.confirm')
    expect(text(browser)).toContain('▸ #1 User input · hi')
    browser.handleAction('surface.confirm')
    expect(text(browser)).toBe(directory)
    expect(directory).toContain('▸ Metadata')
    expect(directory).not.toMatch(/rpc-private|Asia\/Shanghai/u)
    clickHeading(browser, 'Metadata')
    expect(text(browser)).toContain('▾ Metadata')
    expect(text(browser)).toContain('role\n    user')
    expect(text(browser)).toContain('source.kind\n    user')
    expect(text(browser)).toContain('source.rpcId\n    rpc-private')
    expect(text(browser)).toContain('source.timezone\n    Asia/Shanghai')
    browser.handleAction('surface.confirm')
    expect(text(browser)).toContain('▸ Metadata')
    expect(text(browser)).not.toContain('rpc-private')
  })

  it('expands Config directly into continuously readable multiline values and preserves visual position on resize', async () => {
    const { browser } = setup()
    const lines = Array.from({ length: 45 }, (_, index) => `schema line ${index}`)
    await browser.open(available([], { schema: [...lines, 'SCHEMA-END'].join('\n') }))
    browser.render(80, 12)
    browser.handleAction('surface.confirm')
    expect(text(browser, 80, 12)).toContain('schema\n    schema line 0\n    schema line 1')
    for (let index = 0; index < 12; index++) browser.handleAction('surface.detail-next')
    const anchor = browser.render(80, 7)[2]
    expect(browser.render(100, 7)[2]).toBe(anchor)
    const seen: string[] = []
    for (let index = 0; index < 50; index++) {
      const first = browser.render(100, 7)[2]!
      seen.push(first)
      if (first.includes('SCHEMA-END')) break
      browser.handleAction('surface.detail-next')
    }
    expect(seen.at(-1)).toContain('SCHEMA-END')
    expect(browser.handleAction('surface.back')).toBe(false)
  })

  it('treats n and s as Input text, leaving outer Tab and Ctrl-C unconsumed', async () => {
    const { browser } = setup()
    await browser.open(available([message('input', 'ns')]))
    browser.handleAction('surface.search')
    expect(browser.inputContext).toBe('text-input')
    expect(text(browser)).toContain('▾ #1 User input')
    expect(text(browser)).toContain('/ ')
    browser.handleInput('n')
    browser.handleInput('s')
    expect(text(browser)).toContain('ns')
    expect(browser.handleAction('surface.search-next')).toBe(false)
    expect(browser.handleAction('surface.session-info')).toBe(false)
    expect(browser.handleAction('surface.tab-next')).toBe(false)
    expect(browser.handleAction('surface.interrupt-or-cancel')).toBe(false)
    browser.handleAction('surface.confirm')
    await vi.waitFor(() => expect(text(browser)).toContain('1/1 hits'))
    expect(browser.inputContext).toBe('request')
  })

  it('cycles inline highlights through config, tool names, descriptions, schemas, metadata and bodies', async () => {
    const { browser } = setup(undefined, true)
    const painted = createTheme(true).bold(createTheme(true).focusRow('Needle'))
    await browser.open(available([message('Needle-id', 'needle body')], {
      model: 'Needle', tools: [{ name: 'Needle-tool', description: 'Needle description', parameters: { type: 'object', description: 'Needle schema' } }],
    }))
    await search(browser, 'needle', 6)
    const owners = ['model', '▾ Needle-tool', '▾ Description', 'Needle schema', 'id', 'needle body']
    for (const [ordinal, owner] of owners.entries()) {
      if (ordinal > 0) browser.handleAction('surface.search-next')
      await vi.waitFor(() => expect(text(browser)).toContain(`${ordinal + 1}/6 hits`))
      expect(text(browser)).toContain(owner)
      expect(browser.render(180, 30).join('\n')).toContain(ordinal === 5
        ? createTheme(true).bold(createTheme(true).focusRow('needle')) : painted)
    }
    browser.handleAction('surface.search-next')
    await vi.waitFor(() => expect(text(browser)).toContain('1/6 hits'))
    for (let press = 0; press < 5; press++) browser.handleAction('surface.search-next')
    await vi.waitFor(() => expect(text(browser)).toContain('6/6 hits'))
    expect(text(browser)).toContain('needle body')
    for (let press = 0; press < 5; press++) browser.handleAction('surface.search-previous')
    await vi.waitFor(() => expect(text(browser)).toContain('1/6 hits'))
    browser.handleAction('surface.search-previous')
    await vi.waitFor(() => expect(text(browser)).toContain('6/6 hits'))
    browser.handleAction('surface.search-case')
    await vi.waitFor(() => expect(text(browser)).toContain('1/1 hits'))
    expect(text(browser)).toContain('case-sensitive')
    const anchor = browser.render(180, 30).map(stripTerminalSequences).slice(2, -1)
    expect(browser.handleAction('surface.back')).toBe(true)
    expect(text(browser)).toContain('Search idle')
    expect(browser.render(180, 30).map(stripTerminalSequences).slice(2, -1)).toEqual(anchor)
    expect(browser.render(180, 30).join('\n')).not.toContain(createTheme(true).bold(createTheme(true).focusRow('needle')))
    expect(browser.handleAction('surface.back')).toBe(false)
  })

  it('locates Unicode hits inline after a huge prefix and keeps their reading anchor on clearing search', async () => {
    const { browser } = setup(undefined, true)
    const source = 'x'.repeat(200_000) + '😃 针 K end'
    await browser.open(available([message('input', source)]))
    await search(browser, '针', 1)
    expect(browser.render(180, 30).join('\n')).toContain(createTheme(true).bold(createTheme(true).focusRow('针')))
    expect(text(browser)).toContain('😃 针 K end')
    const anchor = browser.render(180, 30).map(stripTerminalSequences).slice(2, -1)
    browser.handleAction('surface.back')
    expect(browser.render(180, 30).map(stripTerminalSequences).slice(2, -1)).toEqual(anchor)
    await search(browser, 'k', 1)
    expect(browser.render(180, 30).join('\n')).toContain(createTheme(true).bold(createTheme(true).focusRow('K')))
  })

  it('searches the complete explicit JSON inline and clears its highlight before returning to the directory', async () => {
    const { browser } = setup(undefined, true)
    await browser.open(available([message('input', 'secret input'), message('other', 'secret result')]))
    browser.handleAction('surface.request-format')
    await search(browser, 'secret', 2)
    expect(text(browser)).toContain('entire canonical JSON')
    expect(browser.render(180, 30).join('\n')).toContain(createTheme(true).bold(createTheme(true).focusRow('secret')))
    browser.handleAction('surface.search-next')
    await vi.waitFor(() => expect(text(browser)).toContain('2/2 hits'))
    await search(browser, '"messages"', 1)
    expect(browser.render(180, 30).join('\n')).toContain(createTheme(true).bold(createTheme(true).focusRow('"messages"')))
    expect(browser.handleAction('surface.back')).toBe(true)
    expect(text(browser)).toContain('JSON ·')
    expect(text(browser)).toContain('Search idle')
    expect(browser.handleAction('surface.back')).toBe(true)
    expect(text(browser)).toContain('Structure ·')
  })

  it('lists tool summaries lazily and expands individual schema and scrollable description groups', async () => {
    const { browser } = setup(undefined, true)
    const firstSchema = vi.fn(() => ({ type: 'object', description: 'FIRST-SCHEMA' }))
    const secondSchema = vi.fn(() => ({ type: 'object', description: 'SECOND-SCHEMA' }))
    const description = ['First summary', ...Array.from({ length: 40 }, (_, index) => `description-${index}`), 'DESCRIPTION-END'].join('\n')
    await browser.open(available(undefined, { tools: [
      { name: 'first_tool', description, get parameters() { return firstSchema() }, strict: true },
      { name: 'second_tool', description: 'Second summary', get parameters() { return secondSchema() } },
    ] }))
    browser.handleAction('surface.section-previous')
    clickHeading(browser, 'Tools')
    expect(text(browser)).toContain('▸ first_tool · First summary')
    expect(text(browser)).toContain('▸ second_tool · Second summary')
    expect(firstSchema).not.toHaveBeenCalled()
    expect(secondSchema).not.toHaveBeenCalled()
    clickHeading(browser, 'first_tool')
    expect(text(browser)).toContain('▸ Description')
    expect(text(browser)).toContain('▸ Parameters schema')
    expect(text(browser)).toContain('▸ Other attributes')
    expect(firstSchema).not.toHaveBeenCalled()
    clickHeading(browser, 'Parameters schema')
    expect(text(browser)).toContain('FIRST-SCHEMA')
    expect(secondSchema).not.toHaveBeenCalled()
    clickHeading(browser, 'Parameters schema')
    clickHeading(browser, 'Other attributes')
    expect(text(browser)).toContain('strict\n        true')
    clickHeading(browser, 'Description')
    const seen: string[] = []
    for (let index = 0; index < 65; index++) {
      const lines = browser.render(32, 8)
      expect(lines.every(line => visibleWidth(line) <= 32)).toBe(true)
      seen.push(stripTerminalSequences(lines[2]!))
      if (seen.at(-1)?.includes('DESCRIPTION-END')) break
      browser.handleAction('surface.detail-next')
    }
    expect(seen.at(-1)).toContain('DESCRIPTION-END')
    expect(seen.filter(line => line.trim().startsWith('description-'))).toHaveLength(40)
    expect(secondSchema).not.toHaveBeenCalled()
  })

  it('jumps by canonical checkpoint, original message number and latest input without inventing provenance', async () => {
    const { browser } = setup()
    const source = compactCheckpointSource('compact-1' as Parameters<typeof compactCheckpointSource>[0])
    await browser.open(available([message('checkpoint', 'summary', 'user', source), message('latest', 'newest')]))
    input(browser, 'surface.request-jump', 'checkpoint')
    expect(text(browser)).toContain('› ▾ #1 Compaction checkpoint')
    input(browser, 'surface.request-jump', '2')
    expect(text(browser)).toContain('› ▾ #2 User input')
    browser.handleAction('surface.section-previous')
    expect(text(browser)).toContain('› ▾ #1 Compaction checkpoint')
    input(browser, 'surface.request-jump', 'latest')
    expect(text(browser)).toContain('› ▾ #2 User input')
  })

  it('moves selection within the viewport and scrolls only at its edge, preserving disclosure position', async () => {
    const { browser } = setup()
    await browser.open(available([
      message('first', 'First input'),
      ...Array.from({ length: 8 }, (_, index) => message(`reply-${index}`, `Reply ${index}`, 'assistant', { kind: 'model', provider: 'test', model: 'test' })),
    ]))
    const frame = () => browser.render(100, 8).map(stripTerminalSequences)
    frame()
    browser.handleAction('surface.confirm')
    const first = frame()[2]!.slice(2)
    browser.handleAction('surface.next')
    expect(frame()[2]!.slice(2)).toBe(first)
    expect(frame()[3]).toContain('› ▸ #2 Assistant response')
    browser.handleAction('surface.next')
    expect(frame()[4]).toContain('› ▸ #3 Assistant response')
    browser.handleAction('surface.confirm')
    expect(frame()[4]).toContain('› ▾ #3 Assistant response')
    expect(frame()[2]!.slice(2)).toBe(first)
    browser.handleAction('surface.confirm')
    frame()
    expect(browser.handlePointer({ kind: 'click', row: 3, column: 6 })).toBe(true)
    expect(frame()[3]).toContain('› ▾ #2 Assistant response')
    expect(frame()[2]!.slice(2)).toBe(first)
    expect(browser.handlePointer({ kind: 'click', row: 3, column: 6 })).toBe(true)
    for (let index = 0; index < 4; index++) { browser.handleAction('surface.next'); frame() }
    expect(frame()[2]).toContain('#2 Assistant response')
    expect(frame()[6]).toContain('› ▸ #6 Assistant response')
    browser.handleAction('surface.previous')
    expect(frame()[2]).toContain('#2 Assistant response')
    expect(frame()[5]).toContain('› ▸ #5 Assistant response')
    for (let index = 0; index < 4; index++) { browser.handleAction('surface.previous'); frame() }
    expect(frame()[2]).toContain('› ▸ #1 User input')
  })

  it('scrolls every multiline body row forward and backward with J/K without selecting text or needing Enter', async () => {
    const { browser } = setup()
    const body = Array.from({ length: 90 }, (_, index) => `line-${index.toString().padStart(3, '0')} ${'x'.repeat(80)}`).join('\n')
    const entry = { ...message('input', body), content: [{ type: 'text', text: body }, { type: 'text', text: 'TAIL-MARKER' }] } as Message
    await browser.open(available([entry, message('next', 'next', 'assistant', { kind: 'model', provider: 'test', model: 'test' })]))
    browser.render(64, 7)
    browser.handleAction('surface.detail-next')
    const anchor = text(browser, 64, 7)
    browser.handleAction('surface.confirm')
    expect(text(browser, 64, 7)).toBe(anchor)
    const reads = vi.spyOn(TextDocument.prototype, 'read')
    const seen: string[] = []
    for (let index = 0; index < 185; index++) {
      const lines = browser.render(64, 7).map(stripTerminalSequences)
      seen.push(lines[2]!)
      if (lines[2]?.includes('TAIL-MARKER')) break
      browser.handleAction('surface.detail-next')
    }
    expect(seen.at(-1)).toContain('TAIL-MARKER')
    expect(seen.filter(line => /^\s+line-/u.test(line))).toHaveLength(90)
    expect(reads.mock.calls.every(([, , count]) => count <= 4)).toBe(true)
    const reversed: string[] = []
    for (let index = 0; index < seen.length - 1; index++) {
      browser.handleAction('surface.detail-previous')
      reversed.push(browser.render(64, 7).map(stripTerminalSequences)[2]!)
    }
    expect(reversed).toEqual(seen.slice(0, -1).reverse())
    expect(browser.handleAction('surface.back')).toBe(false)
    expect(text(browser, 64, 7)).toBe(anchor)
    browser.handleAction('surface.previous')
    browser.handleAction('surface.confirm')
    expect(text(browser, 64, 7)).toContain('› ▸ #1 User input')
  })

  it('requires explicit one-page history loading, cancels waiting, and ignores late results after availability changes', async () => {
    let finish!: (value: boolean) => void
    const load = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const { browser, changed } = setup(load)
    await browser.open(missing)
    expect(text(browser)).toContain('missing-history')
    expect(text(browser)).toContain('seq 0 through 42')
    expect(load).not.toHaveBeenCalled()
    browser.handleAction('surface.confirm')
    browser.handleAction('surface.confirm')
    expect(load).toHaveBeenCalledOnce()
    browser.handleAction('surface.cancel')
    expect(text(browser)).toContain('Session owner')
    const publications = changed.mock.calls.length
    finish(true)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(changed).toHaveBeenCalledTimes(publications)
    expect(load).toHaveBeenCalledOnce()
    browser.handleAction('surface.confirm')
    expect(load).toHaveBeenCalledTimes(2)
    // Session publishes its new snapshot before resolving the page request.
    await browser.open({ ...missing, firstMissingSeq: 10 })
    finish(true)
    await vi.waitFor(() => expect(text(browser)).toContain('Loaded 1 page(s)'))
    browser.handleAction('surface.confirm')
    expect(load).toHaveBeenCalledTimes(3)
    await browser.open(available())
    const readyPublications = changed.mock.calls.length
    finish(true)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(changed).toHaveBeenCalledTimes(readyPublications)
    expect(browser.phase).toBe('ready')
  })

  it('shows typed missing-request and load failure distinctly, with an explicit retry', async () => {
    const load = vi.fn(async () => { throw new Error('network offline') })
    const { browser } = setup(load)
    await browser.open({ status: 'missing-request', reason: 'header' })
    expect(text(browser)).toContain('missing-request (header)')
    expect(browser.handleAction('surface.confirm')).toBe(false)
    await browser.open(missing)
    browser.handleAction('surface.confirm')
    await vi.waitFor(() => expect(text(browser)).toContain('History load failed: network offline'))
    browser.handleAction('surface.confirm')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('retires preparation and searches on request switch and prevents late publications after owner disposal', async () => {
    const { browser, scope, changed } = setup()
    const old = available([message('old', 'a'.repeat(1_000_000))])
    const discarded = browser.open(old)
    const current = available([message('current', 'a'.repeat(1_000_000))])
    await browser.open(current)
    await discarded
    expect(old.read).not.toHaveBeenCalled()
    input(browser, 'surface.search', 'a')
    browser.handleAction('surface.cancel')
    expect(text(browser)).toContain('Search idle')
    input(browser, 'surface.search', 'a')
    await browser.open(available([message('replacement', 'Fresh replacement')]))
    expect(text(browser)).toContain('Fresh replacement')
    expect(text(browser)).toContain('Search idle')
    input(browser, 'surface.search', 'Fresh')
    await scope.dispose()
    const publications = changed.mock.calls.length
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(changed).toHaveBeenCalledTimes(publications)
    expect(browser.phase).toBe('empty')
  })

  it('suspends search editing while preserving the completed request and directory anchor for the same revision', async () => {
    const { browser } = setup()
    const descriptor = available([message('input', 'needle\n' + 'body line\n'.repeat(100))])
    await browser.open(descriptor)
    await search(browser, 'needle', 1)
    browser.render(80, 10)
    browser.handleAction('surface.detail-next')
    const anchor = text(browser, 80, 10)
    browser.handleAction('surface.search')
    browser.handleInput(' unfinished')
    browser.suspend()
    await browser.open({ ...descriptor })
    expect(text(browser, 80, 10)).toBe(anchor)
    expect(descriptor.read).toHaveBeenCalledOnce()
    expect(browser.inputContext).toBe('request')
  })

  it('bounds controls, menus, text and JSON to a fixed narrow viewport', async () => {
    const { browser } = setup(undefined, true)
    await browser.open(available([message('input', '宽😃\u001b[31m'.repeat(300))]))
    for (const action of [undefined, 'surface.search', 'surface.back', 'surface.request-jump', 'surface.back', 'surface.request-format'] as const) {
      if (action !== undefined) browser.handleAction(action)
      for (const [width, height] of [[1, 1], [8, 4], [19, 7], [0, 5], [5, 0]] as const) {
        const lines = browser.render(width, height)
        expect(lines.length).toBeLessThanOrEqual(height)
        expect(lines.every(line => visibleWidth(line) <= width)).toBe(true)
      }
    }
  })
})

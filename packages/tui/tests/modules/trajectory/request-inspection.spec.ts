import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'
import type { ModelRequestAvailability } from '../../../src/runtime/execution/projection/model-call.ts'
import { stepExecutionKey } from '../../../src/runtime/execution/projection/index.ts'
import { RequestInspection } from '../../../src/modules/trajectory/request-inspection.ts'

function available(text: string, epoch = 1): Extract<ModelRequestAvailability, { status: 'available' }> {
  return {
    status: 'available', version: Symbol('request'),
    identity: { sessionId: 'inspection', epoch, stepKey: stepExecutionKey(1, 1), throughSeq: 1 },
    read: vi.fn(() => ({
      request: { provider: 'test', model: 'test', messages: [createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text }],
      })] },
      provenance: [],
    })),
  }
}

describe('RequestInspection', () => {
  it('exposes preparation before reading and preserves a query for the same canonical revision', async () => {
    const scope = new LifecycleScope('inspection-test')
    const inspection = new RequestInspection(scope, vi.fn())
    const descriptor = available('😃 针针')
    const first = inspection.open(descriptor)
    expect(inspection.current.phase).toBe('preparing')
    expect(descriptor.read).not.toHaveBeenCalled()
    expect(inspection.open({ ...descriptor })).toBe(first)
    await first
    expect(inspection.current.phase).toBe('ready')
    await inspection.find('针')
    expect(inspection.search).toMatchObject({ phase: 'ready', totalMatches: 2, selected: { ordinal: 0, match: { start: 3, end: 4 } } })
    await inspection.selectMatch(1)
    expect(inspection.search.selected?.match).toMatchObject({ start: 4, end: 5 })
    const selected = inspection.search.selected
    await inspection.open({ ...descriptor })
    expect(inspection.search.selected).toBe(selected)
    expect(descriptor.read).toHaveBeenCalledOnce()
    await scope.dispose()
  })

  it('retires an unstarted read and an in-flight query when Request identity changes', async () => {
    const scope = new LifecycleScope('inspection-test')
    const inspection = new RequestInspection(scope, vi.fn())
    const old = available('old')
    const oldPreparation = inspection.open(old)
    const current = available('a'.repeat(1_000_000), 2)
    await inspection.open(current)
    await oldPreparation
    expect(old.read).not.toHaveBeenCalled()
    const oldQuery = inspection.find('a')
    await inspection.open(available('new epoch', 3))
    await oldQuery
    expect(inspection.current).toMatchObject({ phase: 'ready', canonical: { request: { messages: [{ content: [{ text: 'new epoch' }] }] } } })
    expect(inspection.search).toMatchObject({ phase: 'idle', totalMatches: 0, selected: undefined })
    await scope.dispose()
  })

  it('keeps missing history explicit and prepares only after a new available descriptor arrives', async () => {
    const scope = new LifecycleScope('inspection-test')
    const inspection = new RequestInspection(scope, vi.fn())
    const missing = { status: 'missing-history', requiredFromSeq: 0, throughSeq: 20, firstMissingSeq: 0 } as const
    await inspection.open(missing)
    expect(inspection.current).toEqual({ phase: 'unavailable', availability: missing })
    await inspection.find('hidden')
    expect(inspection.search.phase).toBe('idle')
    await inspection.open(available('recovered'))
    expect(inspection.current.phase).toBe('ready')
    await scope.dispose()
  })

  it('cancels superseded searches', async () => {
    const scope = new LifecycleScope('inspection-test')
    const inspection = new RequestInspection(scope, vi.fn())
    await inspection.open(available('many '.repeat(100_000) + 'needle'))
    const superseded = inspection.find('many')
    await inspection.find('needle')
    await superseded
    expect(inspection.search).toMatchObject({ phase: 'ready', query: 'needle', totalMatches: 1 })
    await scope.dispose()
  })

  it('does not publish a late query or retain its document after the owning Surface closes', async () => {
    const scope = new LifecycleScope('inspection-test')
    const changed = vi.fn()
    const inspection = new RequestInspection(scope, changed)
    await inspection.open(available('a'.repeat(1_000_000)))
    const query = inspection.find('a')
    await scope.dispose()
    const publications = changed.mock.calls.length
    await query
    expect(changed).toHaveBeenCalledTimes(publications)
    expect(inspection.current.phase).toBe('empty')
    expect(inspection.search.phase).toBe('idle')
  })
})

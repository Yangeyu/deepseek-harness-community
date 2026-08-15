import type { SessionSummary } from '@deepseek-ai/dsh-host-apiproxy'
import { describe, expect, it, vi } from 'vitest'
import {
  SkillCatalog,
  type SkillCatalogSource,
} from '../../src/runtime/skill-catalog.ts'

const first = 'session-first' as SessionSummary['sessionId']
const second = 'session-second' as SessionSummary['sessionId']

describe('SkillCatalog', () => {
  it('sorts effective rows and reuses a fresh same-session result', async () => {
    let now = 1_000
    const list = vi.fn(async () => [
      { name: 'zeta', description: 'Z', modelInvocable: true },
      { name: 'alpha', description: 'A', modelInvocable: false },
    ])
    const catalog = new SkillCatalog({ list }, vi.fn(), () => now, 10_000)

    catalog.setSession(first)
    await catalog.refresh()
    now += 100
    await catalog.refresh()

    expect(catalog.current.status).toBe('ready')
    expect(catalog.current.entries.map(entry => entry.name)).toEqual(['alpha', 'zeta'])
    expect(list).toHaveBeenCalledOnce()
  })

  it('cannot publish an older response after the active session changes', async () => {
    const releases = new Map<SessionSummary['sessionId'], (value: readonly never[]) => void>()
    const source: SkillCatalogSource = {
      list: (sessionId) => new Promise(resolve => { releases.set(sessionId, resolve) }),
    }
    const catalog = new SkillCatalog(source)

    catalog.setSession(first)
    catalog.setSession(second)
    releases.get(first)?.([])
    releases.get(second)?.([])
    await vi.waitFor(() => { expect(catalog.current.status).toBe('ready') })

    expect(catalog.current.sessionId).toBe(second)
    expect(catalog.current.entries).toEqual([])
  })

  it('retains the last good same-session rows when refresh fails', async () => {
    const list = vi.fn()
      .mockResolvedValueOnce([{ name: 'review', description: 'Review', modelInvocable: true }])
      .mockRejectedValueOnce(new Error('temporary transport failure'))
    const catalog = new SkillCatalog({ list })

    catalog.setSession(first)
    await catalog.refresh()
    await catalog.refresh(true)

    expect(catalog.current.status).toBe('stale')
    expect(catalog.current.entries.map(entry => entry.name)).toEqual(['review'])
    expect(catalog.current.error).toBe('temporary transport failure')
  })
})

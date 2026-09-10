import { TuiMainScreen, type Terminal } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { ConfigurationProcess } from '../../../src/modules/configuration/process.ts'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'
import type { RuntimeSessionSnapshot, SessionId } from '../../../src/runtime/session/snapshot.ts'
import type { ModelCatalog } from '../../../src/runtime/session/contracts.ts'
import { createTheme } from '../../../src/presentation/primitives/theme.ts'

function setup() {
  const scope = new LifecycleScope('configuration-test')
  let sessionScope = scope.fork('session-1')
  let epoch = 1
  const catalog: ModelCatalog = { default: { provider: 'deepseek', model: 'chat' }, routableProviders: ['openai-codex'], groups: [{ id: 'openai-codex', name: 'ChatGPT', models: [{ id: 'gpt-test', name: 'Test' }] }], failures: [] }
  const select = vi.fn(async () => {})
  const refresh = vi.fn(async () => catalog)
  const open = vi.fn<ConstructorParameters<typeof ConfigurationProcess>[0]['surfaces']['open']>(() => ({ close: () => true }))
  const process = new ConfigurationProcess({
    scope, theme: createTheme(false), tui: new TuiMainScreen({ columns: 80, rows: 24 } as Terminal),
    session: {
      current: { sessionId: 'session', modelCatalog: catalog, projections: {} } as unknown as RuntimeSessionSnapshot,
      subscribe: () => () => {}, notice: vi.fn(),
      captureSession: () => {
        const captured = sessionScope
        return { sessionId: 'session' as SessionId, epoch, get active() { return captured.active }, commitModelCatalog: () => captured.active }
      },
    },
    models: { select, refresh },
    surfaces: { active: false, open }, commands: { dispatch: async () => false, dispatchHost: async () => {} },
    visibleRows: () => 24, imageSubmissionBusy: () => false, setTranscriptDetails: vi.fn(), invalidate: vi.fn(),
  })
  return { process, scope, select, refresh, open, catalog,
    async rebind() { await sessionScope.dispose(); sessionScope = scope.fork(`session-${String(++epoch)}`) },
  }
}

describe('model selection', () => {
  it('refreshes the picker even when the session already has a catalog', async () => {
    const test = setup()
    const updated: ModelCatalog = { ...test.catalog, groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'new-model', name: 'New model' }] }] }
    test.refresh.mockResolvedValue(updated)
    await test.process.openModelSelector()
    expect(test.refresh).toHaveBeenCalledOnce()
    const dialog = test.open.mock.calls[0]?.[0] as unknown as { component: { render(width: number): string[] } }
    expect(dialog.component.render(100).join('\n')).toContain('New model')
    expect(test.select).not.toHaveBeenCalled()
    await test.scope.dispose()
  })

  it('selects a named model from the catalog', async () => {
    const test = setup()
    await test.process.selectNamedModel('openai-codex/gpt-test')
    expect(test.select).toHaveBeenCalledExactlyOnceWith({ provider: 'openai-codex', model: 'gpt-test' })
    await test.scope.dispose()
  })

  it('rejects a selection when the same session is rebound during catalog loading', async () => {
    const test = setup()
    let finish!: () => void
    test.refresh.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(test.catalog) }))
    const result = test.process.selectNamedModel('openai-codex/gpt-test')
    await vi.waitFor(() => expect(finish).toBeDefined())
    await test.rebind()
    finish()
    await expect(result).rejects.toThrow('Session changed')
    expect(test.select).not.toHaveBeenCalled()
    await test.scope.dispose()
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { TerminalSnapshotSources } from '../../src/application/snapshot.ts'
import { TerminalSnapshotCoordinator } from '../../src/application/snapshot.ts'
import type { ComposerSnapshot } from '../../src/modules/composer/process.ts'
import { emptyRuntimeSessionSnapshot } from '../../src/runtime/session/runtime.ts'

function fixture() {
  let application = { phase: 'running' as const, active: true }
  let session = emptyRuntimeSessionSnapshot('/workspace', { mux: 'online', host: 'online' }, 0)
  let composer: ComposerSnapshot = {
    text: '',
    attachments: [],
    imageSubmissionBusy: false,
    clipboardPastePending: false,
    attachmentRailFocused: false,
    input: { rewindArmed: false, draftRecovery: 'none' },
  }
  const sources: TerminalSnapshotSources = {
    application: () => application,
    session: () => session,
    composer: () => composer,
    interaction: () => ({ activeKey: undefined, phase: 'idle', queued: 0 }),
    rewind: () => ({ phase: 'idle', points: 0 }),
    transcript: () => ({ sessionId: undefined, epoch: undefined, revision: 0 }),
    trajectory: () => ({
      active: false,
      mode: 'list',
      selectedKey: undefined,
      records: 0,
      following: true,
    }),
    configuration: () => ({ models: undefined, detailsExpanded: false }),
    task: () => ({ running: false, queued: 0 }),
    skills: () => ({ entries: [], status: 'idle' }),
    sessionCenter: () => ({ phase: 'idle', choices: 0 }),
    memory: () => ({ state: 'idle' }),
    surfaces: () => ({ depth: 0, active: undefined }),
    focus: () => ({ surfaceOwned: false, restorePending: false }),
  }
  return {
    sources,
    setApplication: (next: typeof application) => { application = next },
    setSession: (next: typeof session) => { session = next },
    setComposer: (next: ComposerSnapshot) => { composer = next },
  }
}

describe('TerminalSnapshotCoordinator', () => {
  it('publishes all synchronously changed slices once as one coherent immutable value', async () => {
    const test = fixture()
    const coordinator = new TerminalSnapshotCoordinator(test.sources)
    const listener = vi.fn()
    coordinator.subscribe(listener)

    test.setSession({ ...test.sources.session(), notice: 'new runtime' })
    test.setComposer({ ...test.sources.composer(), text: 'new draft' })
    coordinator.invalidate()
    coordinator.invalidate()

    expect(listener).not.toHaveBeenCalled()
    await Promise.resolve()

    expect(listener).toHaveBeenCalledOnce()
    expect(coordinator.current).toMatchObject({
      sequence: 1,
      runtime: { session: { notice: 'new runtime' } },
      modules: { composer: { text: 'new draft' } },
    })
    expect(Object.isFrozen(coordinator.current)).toBe(true)
    expect(Object.isFrozen(coordinator.current.runtime)).toBe(true)
    expect(Object.isFrozen(coordinator.current.modules)).toBe(true)
  })

  it('does not publish a queued commit after disposal', async () => {
    const test = fixture()
    const coordinator = new TerminalSnapshotCoordinator(test.sources)
    const listener = vi.fn()
    coordinator.subscribe(listener)

    coordinator.invalidate()
    coordinator.dispose()
    await Promise.resolve()

    expect(listener).not.toHaveBeenCalled()
    expect(coordinator.flush()).toBe(false)
  })
})

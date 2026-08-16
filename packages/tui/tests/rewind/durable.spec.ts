import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MemoryMutation } from '@vascent/deepseek-harness-memory'
import {
  FileRewindRepository,
  LocalWorkspaceRewind,
  MemoryRewindParticipant,
  RewindService,
} from '../../src/rewind/index.ts'

const temporaryDirectories: string[] = []

async function temporary(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), name))
  temporaryDirectories.push(path)
  return path
}

function service(storageRoot: string, participant?: MemoryRewindParticipant): RewindService {
  return new RewindService(
    { history: 20 },
    new LocalWorkspaceRewind(),
    participant === undefined ? [] : [participant],
    new FileRewindRepository(storageRoot),
  )
}

async function begin(rewind: RewindService, root: string, turn: number, sessionId = 'session'): Promise<void> {
  await rewind.beginTurn({ sessionId, turn, workspaceRoot: root, prompt: `turn ${String(turn)}` })
}

function record(rewind: RewindService, root: string, turn: number, before: string, after: string, sessionId = 'session'): void {
  rewind.recordWorkspaceMutation({
    kind: 'reversible',
    sessionId,
    turn,
    callId: `${sessionId}-call-${String(turn)}`,
    rootCallId: `${sessionId}-call-${String(turn)}`,
    order: turn,
    workspaceRoot: root,
    path: join(root, 'a.txt'),
    before,
    after,
  })
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('durable Rewind lifecycle', () => {
  it('restores AI editing history after the TUI service is recreated', async () => {
    const storageRoot = await temporary('dsh-rewind-storage-')
    const workspaceRoot = await temporary('dsh-rewind-workspace-')
    const path = join(workspaceRoot, 'a.txt')
    const before = 'before\n'
    const after = 'after\n'
    await writeFile(path, before)
    const first = service(storageRoot)
    await begin(first, workspaceRoot, 1)
    await writeFile(path, after)
    record(first, workspaceRoot, 1, before, after)
    await first.settle('session')
    await first.close()

    const resumed = service(storageRoot)
    await resumed.activate('session', workspaceRoot)
    const [point] = resumed.list('session')
    const plan = await resumed.plan('session', point?.pointId ?? '')

    expect(plan.state).toBe('safe')
    await resumed.restore(plan)
    expect(await readFile(path, 'utf8')).toBe(before)
    await resumed.close()
  })

  it('hydrates opaque Memory effects and restores them with the workspace after restart', async () => {
    const storageRoot = await temporary('dsh-rewind-memory-storage-')
    const workspaceRoot = await temporary('dsh-rewind-memory-workspace-')
    await writeFile(join(workspaceRoot, 'a.txt'), 'unchanged\n')
    const firstMemory = new MemoryRewindParticipant({ settle: vi.fn(async () => {}), restore: vi.fn(async () => {}) })
    const first = service(storageRoot, firstMemory)
    await begin(first, workspaceRoot, 1)
    const mutation: MemoryMutation = {
      id: 'memory-1',
      sourceSessionId: 'session',
      sourceTurn: 1,
      scope: 'project',
      summary: 'remember the durable rule',
      operation: 'write',
      files: [],
      createdAt: 1,
    }
    const effect = firstMemory.capture(mutation)
    if (effect === undefined) throw new Error('fixture did not create a Memory effect')
    first.recordEffect(effect)
    await first.settle('session')
    await first.close()

    const restore = vi.fn(async () => {})
    const resumedMemory = new MemoryRewindParticipant({ settle: vi.fn(async () => {}), restore })
    const resumed = service(storageRoot, resumedMemory)
    await resumed.activate('session', workspaceRoot)
    const [point] = resumed.list('session')
    const plan = await resumed.plan('session', point?.pointId ?? '')
    await resumed.restore(plan)

    expect(restore).toHaveBeenCalledWith(mutation, 'before')
    await resumed.close()
  })

  it('persists the fork owner and retains future nodes until the restored session starts a new turn', async () => {
    const storageRoot = await temporary('dsh-rewind-fork-storage-')
    const workspaceRoot = await temporary('dsh-rewind-fork-workspace-')
    const first = service(storageRoot)
    await begin(first, workspaceRoot, 1)
    await begin(first, workspaceRoot, 2)
    const points = first.list('session')
    const plan = await first.plan('session', points[1]?.pointId ?? '')
    await first.continueFrom(plan, 'forked')
    await first.close()

    const resumed = service(storageRoot)
    await resumed.activate('forked', workspaceRoot)
    expect(resumed.list('forked').map(point => point.turn)).toEqual([1])
    expect(() => resumed.list('session')).toThrow('no rewind point')
    await begin(resumed, workspaceRoot, 3, 'forked')
    expect(resumed.list('forked').map(point => point.turn)).toEqual([1, 3])
    await resumed.close()

    const reopened = service(storageRoot)
    await reopened.activate('forked', workspaceRoot)
    expect(reopened.list('forked').map(point => point.turn)).toEqual([1, 3])
    await reopened.close()
  })

  it('keeps the prior owner until another session produces its first attributed edit', async () => {
    const storageRoot = await temporary('dsh-rewind-owner-storage-')
    const workspaceRoot = await temporary('dsh-rewind-owner-workspace-')
    const first = service(storageRoot)
    await begin(first, workspaceRoot, 1)
    await begin(first, workspaceRoot, 1, 'other')

    expect(first.list('session')).toHaveLength(1)
    expect(() => first.list('other')).toThrow('no rewind point')

    record(first, workspaceRoot, 1, 'before\n', 'after\n', 'other')
    expect(() => first.list('session')).toThrow('no rewind point')
    expect(first.list('other')).toHaveLength(1)
    await first.close()
  })

  it('removes stale durable history when a newer timeline cannot be persisted', async () => {
    const storageRoot = await temporary('dsh-rewind-failed-storage-')
    const workspaceRoot = await temporary('dsh-rewind-failed-workspace-')
    const warning = vi.fn()
    const first = new RewindService(
      { history: 20, onPersistenceError: warning },
      new LocalWorkspaceRewind(),
      [],
      new FileRewindRepository(storageRoot, {
        maxObjectBytes: 8,
        maxTimelineBytes: 128,
        maxGlobalBytes: 128,
      }),
    )
    await begin(first, workspaceRoot, 1)
    record(first, workspaceRoot, 1, 'old', 'new')
    await first.settle('session')
    await begin(first, workspaceRoot, 2)
    record(first, workspaceRoot, 2, 'new', 'content-too-large')
    await first.settle('session')
    await first.close()

    const reopened = new FileRewindRepository(storageRoot)
    await expect(reopened.load(workspaceRoot)).resolves.toBeUndefined()
    expect(warning).toHaveBeenCalled()
    await reopened.close()
  })

  it('does not let a stale TUI process overwrite or remove a newer timeline revision', async () => {
    const storageRoot = await temporary('dsh-rewind-concurrent-storage-')
    const workspaceRoot = await temporary('dsh-rewind-concurrent-workspace-')
    const first = service(storageRoot)
    await begin(first, workspaceRoot, 1)
    await first.settle('session')

    const warning = vi.fn()
    const stale = new RewindService(
      { history: 20, onPersistenceError: warning },
      new LocalWorkspaceRewind(),
      [],
      new FileRewindRepository(storageRoot),
    )
    await stale.activate('session', workspaceRoot)
    await begin(first, workspaceRoot, 2)
    await first.settle('session')
    await begin(stale, workspaceRoot, 3)
    await stale.settle('session')
    await stale.close()
    await first.close()

    const reopened = service(storageRoot)
    await reopened.activate('session', workspaceRoot)
    expect(reopened.list('session').map(point => point.turn)).toEqual([1, 2])
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ name: 'RewindRepositoryConflictError' }))
    await reopened.close()
  })
})

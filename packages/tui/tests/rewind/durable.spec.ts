import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MemoryMutation } from '@vascent/deepseek-harness-memory'
import {
  FileRewindRepository,
  LocalWorkspaceRewind,
  MemoryRewindParticipant,
  type RewindPointInput,
  RewindService,
} from '../../src/rewind/index.ts'
import { TestRewindConversationHistory } from './history-fixture.ts'

const temporaryDirectories: string[] = []
const histories = new WeakMap<RewindService, TestRewindConversationHistory>()

async function temporary(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), name))
  temporaryDirectories.push(path)
  return path
}

function service(
  storageRoot: string,
  conversation: TestRewindConversationHistory,
  participant?: MemoryRewindParticipant,
): RewindService {
  const rewind = new RewindService(
    { history: 20 },
    conversation,
    new LocalWorkspaceRewind(),
    participant === undefined ? [] : [participant],
    new FileRewindRepository(storageRoot),
  )
  histories.set(rewind, conversation)
  return rewind
}

async function begin(
  rewind: RewindService,
  root: string,
  turn: number,
  sessionId = 'session',
  attachments: readonly ImageAttachmentRef[] = [],
): Promise<void> {
  const point: RewindPointInput = {
    pointId: `${sessionId}-prompt-${String(turn)}`,
    sessionId,
    turn,
    workspaceRoot: root,
    input: { text: `turn ${String(turn)}`, attachments },
    promptSeq: turn,
    createdAt: turn,
  }
  const history = histories.get(rewind)
  if (history === undefined) throw new Error('test Rewind history is unavailable')
  history.record(point)
  await rewind.recordPoint(point)
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
    const conversation = new TestRewindConversationHistory()
    await writeFile(path, before)
    const first = service(storageRoot, conversation)
    const attachment: ImageAttachmentRef = {
      attachmentId: 'attachment-1' as ImageAttachmentRef['attachmentId'],
      mediaType: 'image/png',
      bytes: 4,
      width: 1,
      height: 1,
      name: 'image.png',
    }
    await begin(first, workspaceRoot, 1, 'session', [attachment])
    await writeFile(path, after)
    record(first, workspaceRoot, 1, before, after)
    await first.settle('session')
    await first.close()

    const resumed = service(storageRoot, conversation)
    await resumed.activate('session', workspaceRoot)
    const [point] = resumed.list('session')
    const plan = await resumed.plan('session', point?.pointId ?? '')

    expect(plan.state).toBe('safe')
    expect(plan.input.attachments).toEqual([attachment])
    await resumed.restore(plan)
    expect(await readFile(path, 'utf8')).toBe(before)
    await resumed.close()
  })

  it('hydrates opaque Memory effects and restores them with the workspace after restart', async () => {
    const storageRoot = await temporary('dsh-rewind-memory-storage-')
    const workspaceRoot = await temporary('dsh-rewind-memory-workspace-')
    const conversation = new TestRewindConversationHistory()
    await writeFile(join(workspaceRoot, 'a.txt'), 'unchanged\n')
    const firstMemory = new MemoryRewindParticipant({ settle: vi.fn(async () => {}), restore: vi.fn(async () => {}) })
    const first = service(storageRoot, conversation, firstMemory)
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
    const resumed = service(storageRoot, conversation, resumedMemory)
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
    const conversation = new TestRewindConversationHistory()
    const first = service(storageRoot, conversation)
    await begin(first, workspaceRoot, 1)
    await begin(first, workspaceRoot, 2)
    await writeFile(join(workspaceRoot, 'a.txt'), 'after\n')
    record(first, workspaceRoot, 2, 'before\n', 'after\n')
    await first.settle('session')
    const points = first.list('session')
    const plan = await first.plan('session', points[1]?.pointId ?? '')
    expect(plan.codeScope).toBe('backward')
    conversation.fork('session', 'forked', plan.turn)
    await first.commit(plan, 'code-and-conversation', 'forked')
    await first.close()

    const resumed = service(storageRoot, conversation)
    await resumed.activate('forked', workspaceRoot)
    expect(resumed.list('forked').map(point => point.turn)).toEqual([1])
    expect(resumed.list('session').map(point => point.turn)).toEqual([1, 2])
    await begin(resumed, workspaceRoot, 3, 'forked')
    expect(resumed.list('forked').map(point => point.turn)).toEqual([1, 3])
    await resumed.close()

    const reopened = service(storageRoot, conversation)
    await reopened.activate('forked', workspaceRoot)
    expect(reopened.list('forked').map(point => point.turn)).toEqual([1, 3])
    await reopened.close()
  })

  it('shows a new session immediately and changes only effect ownership on its first edit', async () => {
    const storageRoot = await temporary('dsh-rewind-owner-storage-')
    const workspaceRoot = await temporary('dsh-rewind-owner-workspace-')
    const conversation = new TestRewindConversationHistory()
    const first = service(storageRoot, conversation)
    await begin(first, workspaceRoot, 1)
    await begin(first, workspaceRoot, 1, 'other')

    expect(first.list('session')).toHaveLength(1)
    expect(first.list('other')).toHaveLength(1)

    record(first, workspaceRoot, 1, 'before\n', 'after\n', 'other')
    await first.settle('other')
    expect(first.list('session')).toHaveLength(1)
    expect(first.list('other')).toHaveLength(1)
    await first.close()
  })

  it('removes stale durable history when a newer timeline cannot be persisted', async () => {
    const storageRoot = await temporary('dsh-rewind-failed-storage-')
    const workspaceRoot = await temporary('dsh-rewind-failed-workspace-')
    const warning = vi.fn()
    const conversation = new TestRewindConversationHistory()
    const first = new RewindService(
      { history: 20, onPersistenceError: warning },
      conversation,
      new LocalWorkspaceRewind(),
      [],
      new FileRewindRepository(storageRoot, {
        maxObjectBytes: 8,
        maxTimelineBytes: 128,
        maxGlobalBytes: 128,
      }),
    )
    histories.set(first, conversation)
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
    const canonicalRoot = new LocalWorkspaceRewind().canonicalizeRoot(workspaceRoot)
    const conversation = new TestRewindConversationHistory()
    const durableTurns = async (): Promise<readonly number[] | undefined> => {
      const repository = new FileRewindRepository(storageRoot)
      const entry = await repository.load(canonicalRoot)
      await repository.close()
      return entry?.value.timeline.nodes.map(point => point.turn)
    }
    const first = service(storageRoot, conversation)
    await begin(first, workspaceRoot, 1)
    await writeFile(join(workspaceRoot, 'a.txt'), 'after-1')
    record(first, workspaceRoot, 1, 'before-1', 'after-1')
    await first.settle('session')
    expect(await durableTurns()).toEqual([1])

    const warning = vi.fn()
    const stale = new RewindService(
      { history: 20, onPersistenceError: warning },
      conversation,
      new LocalWorkspaceRewind(),
      [],
      new FileRewindRepository(storageRoot),
    )
    histories.set(stale, conversation)
    await stale.activate('session', workspaceRoot)
    await begin(first, workspaceRoot, 2)
    await first.settle('session')
    expect(await durableTurns()).toEqual([1, 2])
    await begin(stale, workspaceRoot, 3)
    await stale.settle('session')
    expect(await durableTurns()).toEqual([1, 2])
    await stale.close()
    await first.close()

    expect(warning.mock.calls.map(([error]) => String(error))).toEqual([
      'RewindRepositoryConflictError: durable Rewind history changed in another process',
    ])

    const loadWarning = vi.fn()
    const repository = new FileRewindRepository(storageRoot, { onWarning: loadWarning })
    const durable = await repository.load(canonicalRoot)
    expect(loadWarning).not.toHaveBeenCalled()
    expect(durable?.value.timeline.nodes.map(point => point.turn)).toEqual([1, 2])
    await repository.close()

    const reopened = service(storageRoot, conversation)
    await reopened.activate('session', workspaceRoot)
    expect(reopened.list('session').map(point => point.turn)).toEqual([1, 2, 3])
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ name: 'RewindRepositoryConflictError' }))
    await reopened.close()
  })
})

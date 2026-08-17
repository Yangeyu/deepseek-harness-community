import { realpathSync } from 'node:fs'
import { link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LocalWorkspaceRewind,
  RewindService,
  type PreparedRewindParticipant,
  type RewindParticipant,
  type RewindPointInput,
} from '../../src/rewind/index.ts'
import { TestRewindConversationHistory } from './history-fixture.ts'

const temporaryDirectories: string[] = []
const histories = new WeakMap<RewindService, TestRewindConversationHistory>()

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rewind-test-'))
  temporaryDirectories.push(root)
  await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree\n')
  await writeFile(join(root, 'b.txt'), 'original b\n')
  return root
}

function service(history = 10, participants: readonly RewindParticipant[] = []): RewindService {
  const conversation = new TestRewindConversationHistory()
  const rewind = new RewindService({ history }, conversation, new LocalWorkspaceRewind(), participants)
  histories.set(rewind, conversation)
  return rewind
}

function admit(rewind: RewindService, point: RewindPointInput): Promise<void> {
  const history = histories.get(rewind)
  if (history === undefined) throw new Error('test Rewind history is unavailable')
  history.record(point)
  return rewind.recordPoint(point)
}

async function begin(rewind: RewindService, root: string, turn = 1, sessionId = 'session'): Promise<void> {
  await admit(rewind, {
    pointId: `${sessionId}-prompt-${String(turn)}`,
    sessionId,
    turn,
    workspaceRoot: root,
    input: { text: `turn ${String(turn)}`, attachments: [] },
    promptSeq: turn,
    createdAt: turn,
  })
}

async function list(rewind: RewindService, sessionId = 'session') {
  await rewind.settle(sessionId)
  return rewind.list(sessionId)
}

function record(rewind: RewindService, input: {
  root: string
  turn?: number
  sessionId?: string
  callId?: string
  path?: string
  before?: string | null
  after?: string
  unsupportedReason?: string
  order?: number
}): void {
  const path = input.path ?? join(input.root, 'a.txt')
  const source = {
    sessionId: input.sessionId ?? 'session',
    turn: input.turn ?? 1,
    callId: input.callId ?? 'call-1',
    rootCallId: input.callId ?? 'call-1',
    order: input.order ?? 1,
    sourceRoot: input.root,
    targetKey: realpathSync(path),
    path,
  }
  if (input.unsupportedReason !== undefined) {
    rewind.recordWorkspaceMutation({ ...source, kind: 'unsupported', reason: input.unsupportedReason })
    return
  }
  rewind.recordWorkspaceMutation({
    ...source,
    kind: 'reversible',
    before: input.before ?? null,
    after: input.after ?? '',
  })
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('RewindService', () => {
  it('serializes prompt admission before same-turn effects', async () => {
    const root = await workspace()
    const rewind = service()
    const point = admit(rewind, {
      pointId: 'prompt-1',
      sessionId: 'session',
      turn: 1,
      workspaceRoot: root,
      input: { text: 'edit the file', attachments: [] },
      promptSeq: 1,
      createdAt: 1,
    })
    record(rewind, {
      root,
      before: 'one\ntwo\nthree\n',
      after: 'one\nAI\nthree\n',
    })

    await point
    const [summary] = await list(rewind)
    expect(summary).toMatchObject({ pointId: 'prompt-1', workspaceFiles: 1 })
  })

  it('updates one Prompt point when durable image evidence arrives', async () => {
    const root = await workspace()
    const rewind = service()
    const base = {
      pointId: 'prompt-1',
      sessionId: 'session',
      turn: 1,
      workspaceRoot: root,
      promptSeq: 1,
      createdAt: 1,
    }
    await admit(rewind, { ...base, input: { text: 'inspect image', attachments: [] } })
    const attachment: ImageAttachmentRef = {
      attachmentId: 'attachment-1' as ImageAttachmentRef['attachmentId'],
      mediaType: 'image/png',
      bytes: 4,
      width: 1,
      height: 1,
    }
    await admit(rewind, { ...base, input: { text: 'inspect image', attachments: [attachment] } })

    const [summary] = await list(rewind)
    expect(summary).toMatchObject({ pointId: 'prompt-1', imageCount: 1 })
    const plan = await rewind.plan('session', summary?.pointId ?? '')
    expect(plan.input).toEqual({ text: 'inspect image', attachments: [attachment] })
  })

  it('restores only source-attributed AI files and supports compensation', async () => {
    const root = await workspace()
    const rewind = service()
    await begin(rewind, root)
    const before = 'one\ntwo\nthree\n'
    const after = 'one\nAI\nthree\n'
    await writeFile(join(root, 'a.txt'), after)
    record(rewind, { root, before, after })
    await writeFile(join(root, 'b.txt'), 'external window edit\n')

    const [summary] = await list(rewind)
    expect(summary).toMatchObject({ workspaceFiles: 1, unsupportedFiles: 0 })
    const plan = await rewind.plan('session', summary?.pointId ?? '')
    expect(plan.state).toBe('safe')
    expect(plan.files.map(file => file.path)).toEqual(['a.txt'])

    const compensate = await rewind.restore(plan)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(before)
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('external window edit\n')

    await compensate()
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(after)
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('external window edit\n')
  })

  it('restores source-attributed files outside the session workspace in the same transaction', async () => {
    const root = await workspace()
    const externalRoot = await mkdtemp(join(tmpdir(), 'dsh-rewind-external-target-'))
    temporaryDirectories.push(externalRoot)
    const externalPath = join(externalRoot, 'README.md')
    const internalBefore = 'one\ntwo\nthree\n'
    const internalAfter = 'one\nAI\nthree\n'
    const externalBefore = 'external before\n'
    const externalAfter = 'external after\n'
    await writeFile(join(root, 'a.txt'), internalAfter)
    await writeFile(externalPath, externalAfter)
    const rewind = service()
    await begin(rewind, root)
    record(rewind, { root, callId: 'internal', before: internalBefore, after: internalAfter, order: 1 })
    record(rewind, {
      root,
      callId: 'external',
      path: externalPath,
      before: externalBefore,
      after: externalAfter,
      order: 2,
    })

    const [summary] = await list(rewind)
    expect(summary).toMatchObject({ workspaceFiles: 2, unsupportedFiles: 0 })
    const plan = await rewind.plan('session', summary?.pointId ?? '')
    expect(plan.state).toBe('safe')
    expect(plan.files.map(file => file.path)).toEqual([
      realpathSync(externalPath),
      'a.txt',
    ].sort())

    const compensate = await rewind.restore(plan)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(internalBefore)
    expect(await readFile(externalPath, 'utf8')).toBe(externalBefore)

    await compensate()
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(internalAfter)
    expect(await readFile(externalPath, 'utf8')).toBe(externalAfter)
  })

  it('preflights every local target before restoring across workspace roots', async () => {
    const root = await workspace()
    const externalRoot = await mkdtemp(join(tmpdir(), 'dsh-rewind-external-stale-'))
    temporaryDirectories.push(externalRoot)
    const externalPath = join(externalRoot, 'README.md')
    const internalBefore = 'one\ntwo\nthree\n'
    const internalAfter = 'one\nAI\nthree\n'
    await writeFile(join(root, 'a.txt'), internalAfter)
    await writeFile(externalPath, 'external after\n')
    const rewind = service()
    await begin(rewind, root)
    record(rewind, { root, callId: 'internal', before: internalBefore, after: internalAfter, order: 1 })
    record(rewind, {
      root,
      callId: 'external',
      path: externalPath,
      before: 'external before\n',
      after: 'external after\n',
      order: 2,
    })
    const [summary] = await list(rewind)
    const plan = await rewind.plan('session', summary?.pointId ?? '')
    await writeFile(externalPath, 'changed after confirmation\n')

    await expect(rewind.restore(plan)).rejects.toThrow('workspace changed after the rewind plan')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(internalAfter)
    expect(await readFile(externalPath, 'utf8')).toBe('changed after confirmation\n')
  })

  it('preserves non-overlapping later edits with a mergeable reverse patch', async () => {
    const root = await workspace()
    const rewind = service()
    await begin(rewind, root)
    const before = 'one\ntwo\nthree\n'
    const after = 'one\nAI\nthree\n'
    await writeFile(join(root, 'a.txt'), 'one\nAI\nthree\nexternal\n')
    record(rewind, { root, before, after })

    const [summary] = await list(rewind)
    const plan = await rewind.plan('session', summary?.pointId ?? '')
    expect(plan.state).toBe('mergeable')
    await rewind.restore(plan)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\nexternal\n')
  })

  it('uses observation order when result callbacks settle out of order', async () => {
    const root = await workspace()
    const rewind = service()
    await begin(rewind, root)
    const original = 'one\ntwo\nthree\n'
    const firstAfter = 'one\nAI one\nthree\n'
    const secondBefore = 'one\nAI one\nthree\nexternal\n'
    const secondAfter = 'one\nAI two\nthree\nexternal\n'
    await writeFile(join(root, 'a.txt'), secondAfter)
    record(rewind, { root, callId: 'call-2', before: secondBefore, after: secondAfter, order: 2 })
    record(rewind, { root, callId: 'call-1', before: original, after: firstAfter, order: 1 })

    const [summary] = await list(rewind)
    const plan = await rewind.plan('session', summary?.pointId ?? '')
    expect(plan.state).toBe('mergeable')
    await rewind.restore(plan)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\nexternal\n')
  })

  it('blocks overlapping edits and plans that become stale after confirmation', async () => {
    const root = await workspace()
    const rewind = service()
    await begin(rewind, root)
    const before = 'one\ntwo\nthree\n'
    const after = 'one\nAI\nthree\n'
    await writeFile(join(root, 'a.txt'), 'one\nexternal replacement\nthree\n')
    record(rewind, { root, before, after })
    const [summary] = await list(rewind)
    const conflict = await rewind.plan('session', summary?.pointId ?? '')
    expect(conflict.state).toBe('conflict')
    await expect(rewind.restore(conflict)).rejects.toThrow('conflict rewind plan cannot be restored')

    await writeFile(join(root, 'a.txt'), after)
    const safe = await rewind.plan('session', summary?.pointId ?? '')
    await writeFile(join(root, 'a.txt'), 'changed after preview\n')
    await expect(rewind.restore(safe)).rejects.toThrow('workspace changed after the rewind plan')
  })

  it('removes AI-created files without removing unrelated files', async () => {
    const root = await workspace()
    const rewind = service()
    await begin(rewind, root)
    const path = join(root, 'created.txt')
    await writeFile(path, 'created by AI\n')
    record(rewind, { root, path, before: null, after: 'created by AI\n' })
    await writeFile(join(root, 'external.txt'), 'created elsewhere\n')

    const [summary] = await list(rewind)
    const plan = await rewind.plan('session', summary?.pointId ?? '')
    await rewind.restore(plan)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(root, 'external.txt'), 'utf8')).toBe('created elsewhere\n')
  })

  it('collapses unsupported and reversible outcomes for one path into one blocked plan', async () => {
    const root = await workspace()
    const rewind = service()
    await begin(rewind, root)
    record(rewind, { root, callId: 'call-1', before: 'one\ntwo\nthree\n', after: 'one\nAI\nthree\n', order: 1 })
    record(rewind, { root, callId: 'call-2', unsupportedReason: 'missing before-state', order: 2 })

    const [summary] = await list(rewind)
    expect(summary).toMatchObject({ workspaceFiles: 1, unsupportedFiles: 1 })
    const plan = await rewind.plan('session', summary?.pointId ?? '')
    expect(plan.state).toBe('unsupported')
    expect(plan.files).toEqual([{ path: 'a.txt', state: 'unsupported', reason: 'missing before-state' }])
  })

  it('blocks a path whose filesystem identity resolves through a symbolic link', async () => {
    const root = await workspace()
    const external = await mkdtemp(join(tmpdir(), 'dsh-rewind-external-'))
    temporaryDirectories.push(external)
    await writeFile(join(external, 'outside.txt'), 'AI result\n')
    await symlink(external, join(root, 'linked'))
    const rewind = service()
    await begin(rewind, root)
    record(rewind, {
      root,
      path: join(root, 'linked', 'outside.txt'),
      before: 'before\n',
      after: 'AI result\n',
    })

    const [summary] = await list(rewind)
    const plan = await rewind.plan('session', summary?.pointId ?? '')
    expect(plan.state).toBe('unsupported')
    expect(plan.files[0]?.state).toBe('unsupported')
    expect(plan.files[0]?.state === 'unsupported' ? plan.files[0].reason : '').toContain('symbolic links')
  })

  it('does not restore hard-linked targets', async () => {
    const root = await workspace()
    const hardLink = join(root, 'hard-linked.txt')
    await link(join(root, 'a.txt'), hardLink)
    const rewind = service()
    await begin(rewind, root)
    record(rewind, {
      root,
      path: hardLink,
      before: 'one\ntwo\nthree\n',
      after: 'one\nAI\nthree\n',
    })

    const [summary] = await list(rewind)
    const plan = await rewind.plan('session', summary?.pointId ?? '')
    expect(plan.state).toBe('unsupported')
    expect(plan.files[0]?.state === 'unsupported' ? plan.files[0].reason : '').toContain('hard-linked')
  })

  it('keeps bounded history while both source and fork read checkpoints from their Session logs', async () => {
    const root = await workspace()
    const rewind = service(3)
    await begin(rewind, root, 1)
    await begin(rewind, root, 2)
    await begin(rewind, root, 3)
    await begin(rewind, root, 4)
    const summaries = await list(rewind)
    expect(summaries.map(summary => summary.turn)).toEqual([2, 3, 4])

    const plan = await rewind.plan('session', summaries[1]?.pointId ?? '')
    histories.get(rewind)?.fork('session', 'forked', plan.turn)
    await rewind.commit(plan, 'code-and-conversation', 'forked')
    expect(rewind.list('forked').map(summary => summary.turn)).toEqual([1, 2])
    expect(rewind.list('session').map(summary => summary.turn)).toEqual([2, 3, 4])
  })

  it('tracks opaque participant effects without importing their payload type', async () => {
    const participant: RewindParticipant = {
      id: 'memory',
      label: 'Memory',
      settle: vi.fn(async () => {}),
      prepare: vi.fn(async (ids): Promise<PreparedRewindParticipant> => ({
        impact: { id: 'memory', label: 'Memory', changes: ids.length, state: 'safe' },
        apply: async () => async () => {},
      })),
      snapshot: vi.fn((ids: readonly string[]) => ids.map(effectId => ({ effectId, payload: { effectId } }))),
      hydrate: vi.fn(),
      release: vi.fn(),
    }
    const root = await workspace()
    const rewind = service(10, [participant])
    await begin(rewind, root, 1)
    await begin(rewind, root, 2)
    rewind.recordEffect({ participantId: 'memory', effectId: 'memory-1', sourceSessionId: 'session', sourceTurn: 1 })
    rewind.recordEffect({ participantId: 'memory', effectId: 'memory-1', sourceSessionId: 'session', sourceTurn: 1 })
    rewind.recordEffect({ participantId: 'memory', effectId: 'memory-2', sourceSessionId: 'session', sourceTurn: 2 })

    const summaries = await list(rewind)
    expect(summaries.map(summary => summary.participants[0]?.changes)).toEqual([1, 1])
    const plan = await rewind.plan('session', summaries[0]?.pointId ?? '')
    expect(plan.participants).toEqual([{ id: 'memory', label: 'Memory', changes: 2, state: 'safe' }])
    expect(participant.prepare).toHaveBeenCalledWith(['memory-1', 'memory-2'], 'backward')
    expect(participant.release).not.toHaveBeenCalled()
  })

  it('compensates workspace state when a later participant fails', async () => {
    const participant: RewindParticipant = {
      id: 'memory',
      label: 'Memory',
      settle: vi.fn(async () => {}),
      prepare: vi.fn(async (): Promise<PreparedRewindParticipant> => ({
        impact: { id: 'memory', label: 'Memory', changes: 1, state: 'safe' },
        apply: async () => { throw new Error('memory restore failed') },
      })),
      snapshot: vi.fn((ids: readonly string[]) => ids.map(effectId => ({ effectId, payload: { effectId } }))),
      hydrate: vi.fn(),
      release: vi.fn(),
    }
    const root = await workspace()
    const rewind = service(10, [participant])
    await begin(rewind, root)
    const before = 'one\ntwo\nthree\n'
    const after = 'one\nAI\nthree\n'
    await writeFile(join(root, 'a.txt'), after)
    record(rewind, { root, before, after })
    rewind.recordEffect({ participantId: 'memory', effectId: 'memory-1', sourceSessionId: 'session', sourceTurn: 1 })
    const [summary] = await list(rewind)
    const plan = await rewind.plan('session', summary?.pointId ?? '')

    await expect(rewind.restore(plan)).rejects.toThrow('memory restore failed')

    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(after)
  })

  it('marks reversible content outside configured byte budgets as unsupported', async () => {
    const root = await workspace()
    const conversation = new TestRewindConversationHistory()
    const rewind = new RewindService(
      { history: 10, maxMutationBytes: 8, maxSessionBytes: 16 },
      conversation,
      new LocalWorkspaceRewind(),
    )
    histories.set(rewind, conversation)
    await begin(rewind, root)
    record(rewind, { root, before: '12345', after: '67890' })

    const [summary] = await list(rewind)
    expect(summary).toMatchObject({ workspaceFiles: 1, unsupportedFiles: 1 })
    const plan = await rewind.plan('session', summary?.pointId ?? '')
    expect(plan.state).toBe('unsupported')
  })
})

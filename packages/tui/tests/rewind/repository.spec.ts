import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FileRewindRepository,
  RewindRepositoryConflictError,
  type StoredRewindTimeline,
} from '../../src/rewind/index.ts'

const temporaryDirectories: string[] = []

async function temporary(name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), name))
  temporaryDirectories.push(path)
  return path
}

function stored(workspaceRoot: string, options: {
  readonly sessionId?: string
  readonly before?: string
  readonly after?: string
  readonly updatedAt?: number
  readonly attachments?: readonly ImageAttachmentRef[]
} = {}): StoredRewindTimeline {
  const sessionId = options.sessionId ?? 'session'
  const before = options.before ?? 'before secret\n'
  const after = options.after ?? 'after secret\n'
  return {
    timeline: {
      lineageId: `lineage-${sessionId}`,
      workspaceRoot,
      ownerSessionId: sessionId,
      cursor: 1,
      updatedAt: options.updatedAt ?? 1,
      nodes: [{
        id: `point-${sessionId}`,
        sessionId,
        turn: 1,
        workspaceRoot,
        input: { text: 'edit the file', attachments: options.attachments ?? [] },
        promptSeq: 1,
        createdAt: 1,
        workspaceMutations: [{
          id: `mutation-${sessionId}`,
          sourceSessionId: sessionId,
          sourceTurn: 1,
          callId: `call-${sessionId}`,
          rootCallId: `call-${sessionId}`,
          order: 1,
          path: 'a.txt',
          createdAt: 1,
          kind: 'reversible',
          before,
          after,
          bytes: Buffer.byteLength(before) + Buffer.byteLength(after),
        }],
        effects: [{
          participantId: 'memory',
          effectId: `effect-${sessionId}`,
          sourceSessionId: sessionId,
          sourceTurn: 1,
        }],
      }],
    },
    participants: [{
      participantId: 'memory',
      effects: [{ effectId: `effect-${sessionId}`, payload: { id: `effect-${sessionId}`, summary: 'remember secret' } }],
    }],
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('FileRewindRepository', () => {
  it('rejects inconsistent byte budgets at construction time', async () => {
    const root = await temporary('dsh-rewind-limits-')

    expect(() => new FileRewindRepository(root, { maxObjectBytes: 0 })).toThrow('positive integer')
    expect(() => new FileRewindRepository(root, { maxObjectBytes: 2, maxTimelineBytes: 1 })).toThrow('cannot exceed')
    expect(() => new FileRewindRepository(root, { maxTimelineBytes: 2, maxGlobalBytes: 1 })).toThrow('cannot exceed')
  })

  it('round-trips a timeline while keeping content and participant payloads out of the manifest', async () => {
    const root = await temporary('dsh-rewind-repository-')
    const workspaceRoot = await temporary('dsh-rewind-workspace-')
    const repository = new FileRewindRepository(root)
    const value = stored(workspaceRoot, {
      attachments: [{
        attachmentId: 'attachment-1' as ImageAttachmentRef['attachmentId'],
        mediaType: 'image/png',
        bytes: 4,
        width: 1,
        height: 1,
        name: 'image.png',
      }],
    })

    await repository.save(value, null)

    const manifestName = (await readdir(join(root, 'timelines')))[0]
    expect(manifestName).toBeDefined()
    const manifest = await readFile(join(root, 'timelines', manifestName ?? ''), 'utf8')
    expect(manifest).not.toContain('before secret')
    expect(manifest).not.toContain('remember secret')
    await expect(repository.load(workspaceRoot)).resolves.toMatchObject({ value })
    await repository.close()
  })

  it('quarantines a malformed manifest instead of guessing or overwriting it', async () => {
    const root = await temporary('dsh-rewind-corrupt-')
    const workspaceRoot = await temporary('dsh-rewind-workspace-')
    const warning = vi.fn()
    const repository = new FileRewindRepository(root, { onWarning: warning })
    await repository.save(stored(workspaceRoot), null)
    const manifestName = (await readdir(join(root, 'timelines')))[0]
    await writeFile(join(root, 'timelines', manifestName ?? ''), '{broken', 'utf8')

    await expect(repository.load(workspaceRoot)).resolves.toBeUndefined()

    expect(warning).toHaveBeenCalledOnce()
    expect(await readdir(join(root, 'corrupt'))).toHaveLength(1)
    await repository.close()
  })

  it('quarantines a structurally valid manifest with mismatched participant ownership', async () => {
    const root = await temporary('dsh-rewind-invalid-ownership-')
    const workspaceRoot = await temporary('dsh-rewind-workspace-')
    const warning = vi.fn()
    const repository = new FileRewindRepository(root, { onWarning: warning })
    await repository.save(stored(workspaceRoot), null)
    const manifestName = (await readdir(join(root, 'timelines')))[0]
    const manifestPath = join(root, 'timelines', manifestName ?? '')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      nodes: Array<{ effects: Array<{ sourceSessionId: string }> }>
    }
    const effect = manifest.nodes[0]?.effects[0]
    if (effect === undefined) throw new Error('fixture did not contain an effect')
    effect.sourceSessionId = 'foreign-session'
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')

    await expect(repository.load(workspaceRoot)).resolves.toBeUndefined()

    expect(warning).toHaveBeenCalledOnce()
    expect(await readdir(join(root, 'corrupt'))).toHaveLength(1)
    await repository.close()
  })

  it('evicts the least-recently-used workspace when the global content budget is exceeded', async () => {
    const root = await temporary('dsh-rewind-budget-')
    const firstRoot = await temporary('dsh-rewind-first-')
    const secondRoot = await temporary('dsh-rewind-second-')
    const repository = new FileRewindRepository(root, {
      maxObjectBytes: 100,
      maxTimelineBytes: 100,
      maxGlobalBytes: 100,
    })
    await repository.save(stored(firstRoot, { before: 'before-1', after: 'after--1', updatedAt: 1 }), null)
    await repository.save(stored(secondRoot, { sessionId: 'second', before: 'before-2', after: 'after--2', updatedAt: 2 }), null)

    await expect(repository.load(firstRoot)).resolves.toBeUndefined()
    await expect(repository.load(secondRoot)).resolves.toBeDefined()
    await repository.close()
  })

  it('rejects stale saves and removals without overwriting a newer process', async () => {
    const root = await temporary('dsh-rewind-concurrency-')
    const workspaceRoot = await temporary('dsh-rewind-workspace-')
    const first = new FileRewindRepository(root)
    const second = new FileRewindRepository(root)
    const initialRevision = await first.save(stored(workspaceRoot), null)
    const loaded = await second.load(workspaceRoot)
    expect(loaded?.revision).toBe(initialRevision)
    const latest = stored(workspaceRoot, { sessionId: 'latest', updatedAt: 2 })
    await first.save(latest, initialRevision)

    await expect(second.save(stored(workspaceRoot, { sessionId: 'stale', updatedAt: 3 }), initialRevision))
      .rejects.toBeInstanceOf(RewindRepositoryConflictError)
    await expect(second.remove(workspaceRoot, initialRevision)).resolves.toBe(false)
    await expect(second.load(workspaceRoot)).resolves.toMatchObject({ value: latest })
    await first.close()
    await second.close()
  })
})

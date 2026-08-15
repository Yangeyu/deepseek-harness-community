import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MemoryMutation } from '@yangeyu/deepseek-harness-memory'
import { WorkspaceCheckpointStore } from '../src/checkpoint.ts'

const temporaryDirectories: string[] = []

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rewind-test-'))
  temporaryDirectories.push(root)
  git(root, 'init', '--quiet')
  git(root, 'config', 'user.email', 'rewind@example.invalid')
  git(root, 'config', 'user.name', 'Rewind Test')
  await writeFile(join(root, 'a.txt'), 'original\n')
  await writeFile(join(root, 'b.txt'), 'original b\n')
  git(root, 'add', '.')
  git(root, 'commit', '--quiet', '-m', 'initial')
  return root
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('WorkspaceCheckpointStore', () => {
  it('restores the pre-turn worktree without changing the Git index and supports rollback', async () => {
    const root = await repository()
    await writeFile(join(root, 'a.txt'), 'user baseline\n')
    await writeFile(join(root, 'b.txt'), 'staged baseline\n')
    git(root, 'add', 'b.txt')
    const indexTree = git(root, 'write-tree')
    const store = new WorkspaceCheckpointStore(10)
    await store.capture({ sessionId: 'session-1', turn: 2, cwd: root, prompt: 'make changes', previousTurnEndSeq: 17 })

    await writeFile(join(root, 'a.txt'), 'ai change\n')
    await writeFile(join(root, 'b.txt'), 'ai staged-file change\n')
    await writeFile(join(root, 'new.txt'), 'created\n')
    const [summary] = store.list('session-1')
    const preview = await store.preview('session-1', summary?.checkpointId ?? '')
    expect(preview.previousTurnEndSeq).toBe(17)
    expect(preview.prompt).toBe('make changes')
    expect(preview.files.map(change => change.path)).toEqual(['a.txt', 'b.txt', 'new.txt'])

    const rollback = await store.restore(preview)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('user baseline\n')
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('staged baseline\n')
    await expect(stat(join(root, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(git(root, 'write-tree')).toBe(indexTree)

    await rollback()
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('ai change\n')
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('ai staged-file change\n')
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('created\n')
    expect(git(root, 'write-tree')).toBe(indexTree)
  })

  it('rejects a stale confirmation when the workspace changed after preview', async () => {
    const root = await repository()
    const store = new WorkspaceCheckpointStore(10)
    await store.capture({ sessionId: 'session-2', turn: 1, cwd: root, prompt: 'edit a' })
    await writeFile(join(root, 'a.txt'), 'first change\n')
    const [summary] = store.list('session-2')
    const preview = await store.preview('session-2', summary?.checkpointId ?? '')
    await writeFile(join(root, 'a.txt'), 'later change\n')

    await expect(store.restore(preview)).rejects.toThrow('workspace changed after the rewind preview')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('later change\n')
  })

  it('lists bounded turn history newest-last and restores an older selected node', async () => {
    const root = await repository()
    const store = new WorkspaceCheckpointStore(3)
    await store.capture({ sessionId: 'session-history', turn: 1, cwd: root, prompt: 'first prompt' })
    await store.capture({ sessionId: 'session-history', turn: 2, cwd: root, prompt: 'second prompt', previousTurnEndSeq: 4 })
    await writeFile(join(root, 'a.txt'), 'after second\n')
    await store.capture({ sessionId: 'session-history', turn: 3, cwd: root, prompt: 'third prompt', previousTurnEndSeq: 9 })
    await writeFile(join(root, 'b.txt'), 'after third\n')

    const summaries = store.list('session-history')
    expect(summaries.map(summary => summary.prompt)).toEqual(['first prompt', 'second prompt', 'third prompt'])
    const described = await store.describe('session-history')
    expect(described.map(summary => summary.turnChangedFiles)).toEqual([0, 1, 1])

    const selected = summaries[1]
    const preview = await store.preview('session-history', selected?.checkpointId ?? '')
    expect(preview.previousTurnEndSeq).toBe(4)
    await store.restore(preview)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('original\n')

    store.continueFrom(preview, 'session-child')
    expect(store.list('session-child').map(summary => summary.prompt)).toEqual(['first prompt'])
    expect(() => store.list('session-history')).toThrow('no rewind checkpoint')

    await store.capture({
      sessionId: 'session-child',
      turn: 2,
      cwd: root,
      prompt: 'replacement second prompt',
      previousTurnEndSeq: 4,
    })
    await writeFile(join(root, 'a.txt'), 'replacement second change\n')
    const replacement = store.list('session-child').at(-1)
    const secondPreview = await store.preview('session-child', replacement?.checkpointId ?? '')
    await store.restore(secondPreview)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('original\n')
    store.continueFrom(secondPreview, 'session-grandchild')
    expect(store.list('session-grandchild').map(summary => summary.prompt)).toEqual(['first prompt'])
    expect(() => store.list('session-child')).toThrow('no rewind checkpoint')
  })

  it('keeps earlier checkpoints when a later capture fails', async () => {
    const root = await repository()
    const store = new WorkspaceCheckpointStore(10)
    await store.capture({ sessionId: 'session-failure', turn: 1, cwd: root, prompt: 'usable prompt' })
    store.fail('session-failure', new Error('later capture failed'))

    expect(store.list('session-failure')).toHaveLength(1)
  })

  it('attributes memory mutations to their source turn and includes later updates in an older rewind', async () => {
    const root = await repository()
    const store = new WorkspaceCheckpointStore(10)
    await store.capture({ sessionId: 'session-memory', turn: 1, cwd: root, prompt: 'remember the rule' })
    await store.capture({ sessionId: 'session-memory', turn: 2, cwd: root, prompt: 'continue working' })
    const mutation = (id: string, turn: number): MemoryMutation => ({
      id,
      sourceSessionId: 'session-memory',
      sourceTurn: turn,
      scope: 'project',
      summary: `Rule from turn ${String(turn)}`,
      operation: 'write',
      files: [],
      createdAt: turn,
    })
    store.recordMemoryMutation(mutation('memory-1', 1))
    store.recordMemoryMutation(mutation('memory-1', 1))
    store.recordMemoryMutation(mutation('memory-2', 2))

    const summaries = store.list('session-memory')
    expect(summaries.map(summary => summary.memoryUpdates)).toEqual([1, 1])
    const first = await store.preview('session-memory', summaries[0]?.checkpointId ?? '')
    const second = await store.preview('session-memory', summaries[1]?.checkpointId ?? '')
    expect(first.memoryMutations?.map(candidate => candidate.id)).toEqual(['memory-1', 'memory-2'])
    expect(second.memoryMutations?.map(candidate => candidate.id)).toEqual(['memory-2'])
  })
})

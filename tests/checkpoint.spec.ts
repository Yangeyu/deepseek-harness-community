import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
    const store = new WorkspaceCheckpointStore()
    await store.capture({ sessionId: 'session-1', turn: 2, cwd: root, prompt: 'make changes', previousTurnEndSeq: 17 })

    await writeFile(join(root, 'a.txt'), 'ai change\n')
    await writeFile(join(root, 'b.txt'), 'ai staged-file change\n')
    await writeFile(join(root, 'new.txt'), 'created\n')
    const preview = await store.preview('session-1')
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
    const store = new WorkspaceCheckpointStore()
    await store.capture({ sessionId: 'session-2', turn: 1, cwd: root, prompt: 'edit a' })
    await writeFile(join(root, 'a.txt'), 'first change\n')
    const preview = await store.preview('session-2')
    await writeFile(join(root, 'a.txt'), 'later change\n')

    await expect(store.restore(preview)).rejects.toThrow('workspace changed after the rewind preview')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('later change\n')
  })
})

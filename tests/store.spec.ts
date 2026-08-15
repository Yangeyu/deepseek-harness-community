import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryFileStore } from '../src/store.ts'

const temporaryDirectories: string[] = []

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

async function fixture(): Promise<{ cwd: string; memoryRoot: string; store: MemoryFileStore }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-test-'))
  temporaryDirectories.push(root)
  const cwd = join(root, 'project')
  const memoryRoot = join(root, 'memories')
  await mkdir(cwd)
  git(cwd, 'init', '--quiet')
  git(cwd, 'remote', 'add', 'origin', 'git@github.com:Yangeyu/example.git')
  await writeFile(join(cwd, 'README.md'), '# Fixture\n')
  return {
    cwd,
    memoryRoot,
    store: new MemoryFileStore({
      root: memoryRoot,
      maxDocumentBytes: 32 * 1024,
      maxSummaryChars: 200,
      maxDetailsChars: 1_000,
    }),
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('MemoryFileStore', () => {
  it('writes deduplicated Markdown indexes and topic detail files', async () => {
    const { cwd, store } = await fixture()
    const first = await store.write({
      cwd,
      scope: 'project',
      summary: 'Preserve unrelated user edits.',
      topic: 'conventions',
      details: 'Stage only files owned by the requested change.',
    })
    const duplicate = await store.write({
      cwd,
      scope: 'project',
      summary: '  Preserve   unrelated user edits. ',
      topic: 'conventions',
      details: 'Stage only files owned by the requested change.',
    })

    expect(first.changed).toBe(true)
    expect(first.files).toHaveLength(2)
    expect(duplicate.changed).toBe(false)
    const index = await store.read(cwd, 'project')
    const topic = await store.read(cwd, 'project', 'conventions')
    expect(index.content).toContain('- Preserve unrelated user edits. ([conventions](conventions.md))')
    expect(topic.content).toContain('- Preserve unrelated user edits. — Stage only files owned by the requested change.')
  })

  it('isolates global and project memory and resolves a stable remote-backed project id', async () => {
    const { cwd, store } = await fixture()
    const before = await store.project(cwd)
    await store.write({ cwd, scope: 'global', summary: 'Prefer concise Chinese responses.' })
    await store.write({ cwd, scope: 'project', summary: 'Use pnpm for this repository.' })
    const after = await store.project(cwd)

    expect(after.id).toBe(before.id)
    expect((await store.read(cwd, 'global')).content).toContain('Prefer concise Chinese responses.')
    expect((await store.read(cwd, 'project')).content).toContain('Use pnpm for this repository.')
    expect((await store.list(cwd)).map(document => document.scope).sort()).toEqual(['global', 'project'])
  })

  it('forgets an exact summary and can reverse and reapply the mutation', async () => {
    const { cwd, store } = await fixture()
    await store.write({ cwd, scope: 'project', summary: 'Run visual acceptance for every review.' })
    const mutation = await store.forget({
      cwd,
      scope: 'project',
      summary: 'Run visual acceptance for every review.',
    })

    expect(mutation.changed).toBe(true)
    expect((await store.read(cwd, 'project')).content).not.toContain('Run visual acceptance')
    await store.restore(mutation.files, 'before')
    expect((await store.read(cwd, 'project')).content).toContain('Run visual acceptance')
    await store.restore(mutation.files, 'after')
    expect((await store.read(cwd, 'project')).content).not.toContain('Run visual acceptance')
  })

  it('refuses secret-like values before creating memory files', async () => {
    const { cwd, memoryRoot, store } = await fixture()
    await expect(store.write({
      cwd,
      scope: 'project',
      summary: 'API key = sk-exampleexampleexampleexample',
    })).rejects.toThrow('credential or secret')
    await expect(readFile(join(memoryRoot, 'global', 'MEMORY.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects stale rewind restoration rather than overwriting a later write', async () => {
    const { cwd, store } = await fixture()
    const mutation = await store.write({ cwd, scope: 'project', summary: 'First rule.' })
    await store.write({ cwd, scope: 'project', summary: 'Later rule.' })

    await expect(store.restore(mutation.files, 'before')).rejects.toThrow('changed after the checkpoint preview')
    expect((await store.read(cwd, 'project')).content).toContain('Later rule.')
  })

  it('preflights every file before reverting a multi-file memory update', async () => {
    const { cwd, store } = await fixture()
    const mutation = await store.write({
      cwd,
      scope: 'project',
      summary: 'Use focused checks.',
      topic: 'conventions',
      details: 'Run only the checks that cover the changed surface.',
    })
    const index = mutation.files.find(file => file.path.endsWith('MEMORY.md'))
    const topic = mutation.files.find(file => file.path.endsWith('conventions.md'))
    if (index === undefined || topic === undefined) throw new Error('fixture did not create both memory files')
    await writeFile(index.path, `${index.after ?? ''}- Later independent rule.\n`)

    await expect(store.restore(mutation.files, 'before')).rejects.toThrow('changed after the checkpoint preview')
    expect(await readFile(topic.path, 'utf8')).toBe(topic.after)
  })
})

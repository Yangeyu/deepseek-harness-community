import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryFileStore, type MemoryWriteInput } from '../src/store.ts'

const temporaryDirectories: string[] = []

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

async function fixture(): Promise<{ cwd: string; store: MemoryFileStore }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-test-'))
  temporaryDirectories.push(root)
  const cwd = join(root, 'project')
  const memoryRoot = join(root, 'memories')
  await mkdir(cwd)
  git(cwd, 'init', '--quiet')
  git(cwd, 'remote', 'add', 'origin', 'git@github.com:Yangeyu/example.git')
  await writeFile(join(cwd, 'README.md'), '# Fixture\n')
  git(cwd, 'add', 'README.md')
  git(cwd, '-c', 'user.name=Memory Test', '-c', 'user.email=memory@example.test', 'commit', '--quiet', '-m', 'fixture')
  return {
    cwd,
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
  it('cancels pending writes and forgets before they enter the file mutation queue', async () => {
    const { cwd, store } = await fixture()
    await store.write({ cwd, scope: 'project', summary: 'Preserve existing memory.' })
    const before = await store.read(cwd, 'project')
    const controller = new AbortController()
    const written = store.write({ cwd, scope: 'project', summary: 'Canceled update.' }, controller.signal)
    const forgotten = store.forget({ cwd, scope: 'project', summary: 'Preserve existing memory.' }, controller.signal)
    const canceled = Promise.all([
      expect(written).rejects.toThrow('learning canceled'),
      expect(forgotten).rejects.toThrow('learning canceled'),
    ])
    controller.abort(new Error('learning canceled'))

    await canceled
    expect((await store.read(cwd, 'project')).content).toBe(before.content)
  })

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
      details: 'An ordinary duplicate must not replace the original detail.',
    })

    expect(first).toBe(true)
    expect(duplicate).toBe(false)
    const index = await store.read(cwd, 'project')
    const topic = await store.read(cwd, 'project', 'conventions')
    expect(index.content).toContain('- Preserve unrelated user edits. ([conventions](conventions.md))')
    expect(topic.content).toContain('- Preserve unrelated user edits. — Stage only files owned by the requested change.')
  })

  it('replaces an old memory and refreshes an existing target and its details', async () => {
    const { cwd, store } = await fixture()
    await store.write({ cwd, scope: 'project', summary: 'Old rule.', topic: 'preferences', details: 'Old detail.' })
    await store.write({ cwd, scope: 'project', summary: 'New rule.', topic: 'conventions', details: 'Stale detail.' })
    await store.write({ cwd, scope: 'project', summary: 'Keep this rule.', topic: 'preferences' })

    expect(await store.write({
      cwd, scope: 'project', summary: 'New rule.', topic: 'conventions', details: 'Corrected detail.',
      replaces: { summary: 'Old rule.', topic: 'preferences' },
    })).toBe(true)

    expect((await store.read(cwd, 'project')).content.split('\n').filter(line => line.startsWith('- '))).toEqual([
      '- Keep this rule. ([preferences](preferences.md))',
      '- New rule. ([conventions](conventions.md))',
    ])
    expect((await store.read(cwd, 'project', 'conventions')).content).toBe('# Conventions memory\n\n- New rule. — Corrected detail.\n')
    expect((await store.read(cwd, 'project', 'preferences')).content.split('\n').filter(line => line.startsWith('- '))).toEqual(['- Keep this rule.'])
  })

  it.each([
    { name: 'updates same-key details', summary: '  KEEP   This Rule. ', topic: 'conventions' as const },
    { name: 'moves a same-key memory', summary: 'Keep this rule.', topic: 'preferences' as const },
    { name: 'removes a same-key topic link', summary: 'Keep this rule.', topic: undefined },
    { name: 'extends a summary with a detail-like suffix', summary: 'Keep this rule. — suffix', topic: 'conventions' as const },
  ])('$name', async ({ summary, topic }) => {
    const { cwd, store } = await fixture()
    await store.write({ cwd, scope: 'project', summary: 'Keep this rule.', topic: 'conventions', details: 'Old detail.' })
    expect(await store.write({
      cwd, scope: 'project', summary, ...topic === undefined ? {} : { topic }, details: 'New detail.',
      replaces: { summary: 'Keep this rule.', topic: 'conventions' },
    })).toBe(true)

    const normalized = summary.trim().replaceAll(/\s+/gu, ' ')
    const link = topic === undefined ? '' : ` ([${topic}](${topic}.md))`
    expect((await store.read(cwd, 'project')).content).toBe(`# Project memory\n\n- ${normalized}${link}\n`)
    if (topic !== undefined) {
      expect((await store.read(cwd, 'project', topic)).content).toContain(`- ${normalized} — New detail.\n`)
      expect((await store.read(cwd, 'project', topic)).content).not.toContain('Old detail.')
    }
    if (topic !== 'conventions') {
      expect((await store.read(cwd, 'project', 'conventions')).content).toBe('# Conventions memory\n')
    }
  })

  it('writes a replacement even when the old entry is missing', async () => {
    const { cwd, store } = await fixture()
    expect(await store.write({
      cwd, scope: 'project', summary: 'Current rule.', replaces: { summary: 'Missing rule.', topic: 'preferences' },
    })).toBe(true)
    expect((await store.read(cwd, 'project')).content).toBe('# Project memory\n\n- Current rule.\n')
  })

  it('preserves existing documents when replacement validation fails', async () => {
    const { cwd, store } = await fixture()
    const input: MemoryWriteInput = {
      cwd, scope: 'project', summary: 'New rule.', topic: 'decisions',
      replaces: { summary: 'Old rule.', topic: 'conventions' },
    }
    await store.write({ cwd, scope: 'project', summary: 'Old rule.', topic: 'conventions', details: 'Keep this detail.' })
    const before = await store.list(cwd)
    const bounded = new MemoryFileStore({ root: store.root, maxDocumentBytes: 180, maxSummaryChars: 200, maxDetailsChars: 1_000 })
    for (const invalid of [
      { ...input, replaces: { summary: ' ' } },
      { ...input, replaces: { summary: 'Old rule.', topic: 'invalid' as 'conventions' } },
      { ...input, details: 'password = example-secret-value' },
      { ...input, details: 'Large detail. '.repeat(30) },
    ]) {
      await expect(bounded.write(invalid)).rejects.toThrow()
      expect(await store.list(cwd)).toEqual(before)
    }
  })

  it('keeps completed new content on cancellation and allows subsequent queued writes', async () => {
    const { cwd, store } = await fixture()
    await store.write({ cwd, scope: 'project', summary: 'Old rule.', topic: 'conventions', details: 'Old detail.' })
    await store.write({ cwd, scope: 'project', summary: 'Keep this rule.', topic: 'decisions' })
    const beforeIndex = await store.read(cwd, 'project')
    const beforeOld = await store.read(cwd, 'project', 'conventions')
    const target = await store.read(cwd, 'project', 'decisions')
    const controller = new AbortController()
    const throwIfAborted = controller.signal.throwIfAborted.bind(controller.signal)
    vi.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      if (readFileSync(target.path, 'utf8').includes('- New rule. — New detail.')) {
        controller.abort(new Error('learning canceled after new content'))
      }
      throwIfAborted()
    })

    await expect(store.write({
      cwd, scope: 'project', summary: 'New rule.', topic: 'decisions', details: 'New detail.',
      replaces: { summary: 'Old rule.', topic: 'conventions' },
    }, controller.signal)).rejects.toThrow('learning canceled after new content')

    expect((await store.read(cwd, 'project', 'decisions')).content).toContain('- New rule. — New detail.')
    expect((await store.read(cwd, 'project')).content).toBe(beforeIndex.content)
    expect((await store.read(cwd, 'project', 'conventions')).content).toBe(beforeOld.content)
    expect(await store.write({ cwd, scope: 'project', summary: 'Later rule.' })).toBe(true)
    expect((await store.read(cwd, 'project')).content).toContain('- Later rule.')
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

  it('shares remote-backed project memory across linked worktrees and differently named clones', async () => {
    const { cwd, store } = await fixture()
    const parent = join(cwd, '..')
    const worktree = join(parent, 'feature-worktree')
    const clone = join(parent, 'renamed-clone')
    git(cwd, 'worktree', 'add', '--quiet', '--detach', worktree)
    await mkdir(clone)
    git(clone, 'init', '--quiet')
    git(clone, 'remote', 'add', 'origin', 'git@github.com:Yangeyu/example.git')

    const projects = await Promise.all([store.project(cwd), store.project(worktree), store.project(clone)])
    expect(new Set(projects.map(project => project.id)).size).toBe(1)
    expect(new Set(projects.map(project => project.directory)).size).toBe(1)

    await store.write({ cwd: worktree, scope: 'project', summary: 'Share this rule across worktrees.' })
    expect((await store.read(clone, 'project')).content).toContain('Share this rule across worktrees.')
  })

  it('uses the Git common directory for originless linked worktrees', async () => {
    const { cwd, store } = await fixture()
    git(cwd, 'remote', 'remove', 'origin')
    const worktree = join(cwd, '..', 'local-feature')
    git(cwd, 'worktree', 'add', '--quiet', '--detach', worktree)

    const primary = await store.project(cwd)
    const linked = await store.project(worktree)
    expect(linked.id).toBe(primary.id)
    expect(linked.directory).toBe(primary.directory)

    await store.write({ cwd: worktree, scope: 'project', summary: 'Share local repository memory.' })
    expect((await store.read(cwd, 'project')).content).toContain('Share local repository memory.')
  })

  it('forgets an exact summary and its linked details', async () => {
    const { cwd, store } = await fixture()
    const input = { cwd, scope: 'project' as const, summary: 'Run visual acceptance for every review.', topic: 'conventions' as const }
    const longer = `${input.summary} — keep this separate summary`
    await store.write({ cwd, scope: 'project', summary: longer })
    await store.write({ ...input, details: 'Check the terminal rendering.' })
    expect((await store.read(cwd, 'project')).content).toContain(`- ${input.summary} ([conventions](conventions.md))`)

    expect(await store.forget(input)).toBe(true)
    expect((await store.read(cwd, 'project')).content.trim()).toBe(`# Project memory\n\n- ${longer}`)
    expect((await store.read(cwd, 'project', 'conventions')).content).not.toContain('Check the terminal rendering.')
  })

  it('refuses secret-like memory content', async () => {
    const { cwd, store } = await fixture()
    await expect(store.write({
      cwd,
      scope: 'project',
      summary: 'API key = sk-exampleexampleexampleexample',
    })).rejects.toThrow('credential or secret')
  })

})

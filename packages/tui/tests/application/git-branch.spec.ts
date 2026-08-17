import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readGitBranch,
  watchGitBranch,
} from '../../src/application/git-branch.ts'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-tui-git-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => (
    rm(path, { recursive: true, force: true })
  )))
})

describe('Git branch status', () => {
  it('finds the nearest repository from a nested working directory', async () => {
    const root = await temporaryDirectory()
    const nested = join(root, 'packages', 'tui')
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(nested, { recursive: true })
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/feature/footer-context\n')

    await expect(readGitBranch(nested)).resolves.toBe('feature/footer-context')
  })

  it('resolves linked-worktree git directories and detached heads', async () => {
    const root = await temporaryDirectory()
    const workspace = join(root, 'workspace')
    const metadata = join(root, 'metadata', 'worktrees', 'workspace')
    await mkdir(workspace, { recursive: true })
    await mkdir(metadata, { recursive: true })
    await writeFile(join(workspace, '.git'), 'gitdir: ../metadata/worktrees/workspace\n')
    await writeFile(join(metadata, 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n')

    await expect(readGitBranch(workspace)).resolves.toBe('detached@01234567')
  })

  it('omits branch context outside a Git repository', async () => {
    const root = await temporaryDirectory()

    await expect(readGitBranch(root)).resolves.toBeUndefined()
  })

  it('publishes branch changes from HEAD without polling', async () => {
    const root = await temporaryDirectory()
    const gitDirectory = join(root, '.git')
    const head = join(gitDirectory, 'HEAD')
    await mkdir(gitDirectory)
    await writeFile(head, 'ref: refs/heads/main\n')
    const branches: Array<string | undefined> = []

    const stop = watchGitBranch(root, branch => { branches.push(branch) })
    await vi.waitFor(() => { expect(branches.at(-1)).toBe('main') })
    await writeFile(head, 'ref: refs/heads/feature/live-status\n')
    await vi.waitFor(() => { expect(branches.at(-1)).toBe('feature/live-status') })
    stop()
  })
})

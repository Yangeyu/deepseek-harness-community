import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'vitest'
import { parse } from 'yaml'

interface PackageManifest {
  name?: string
  private?: boolean
  bin?: string | Record<string, string>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  files?: string[]
  publishConfig?: { access?: string }
  exports?: Record<string, string | { types?: string; default?: string }>
}

test('pins the public DeepSeek Harness dependency family to one release candidate', async () => {
  const root = JSON.parse(await readFile('package.json', 'utf8')) as PackageManifest
  const dshDependencies = Object.entries(root.dependencies ?? {})
    .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))

  assert.ok(dshDependencies.length > 0, 'the distribution must declare its DeepSeek runtime')
  const versions = new Set(dshDependencies.map(([, version]) => version))
  assert.equal(versions.size, 1, 'all direct DeepSeek packages must use one exact RC version')
  assert.match([...versions][0] ?? '', /^\d+\.\d+\.\d+-rc\.\d+$/u)
})

test('resolves the complete DeepSeek Harness lockfile graph to the public runtime version', async () => {
  const root = JSON.parse(await readFile('package.json', 'utf8')) as PackageManifest
  const runtimeVersion = root.dependencies?.['@deepseek-ai/dsh']
  assert.match(runtimeVersion ?? '', /^\d+\.\d+\.\d+-rc\.\d+$/u)

  const lockfile = parse(await readFile('pnpm-lock.yaml', 'utf8')) as {
    packages?: Record<string, unknown>
  }
  const lockedVersions = new Set(
    Object.keys(lockfile.packages ?? {})
      .filter(name => /^@deepseek-ai\/dsh(?:-|@)/u.test(name))
      .map(name => name.slice(name.lastIndexOf('@') + 1)),
  )

  assert.deepEqual(lockedVersions, new Set([runtimeVersion]))
})

test('keeps every plugin compatibility boundary aligned with the public DeepSeek runtime', async () => {
  const root = JSON.parse(await readFile('package.json', 'utf8')) as PackageManifest
  const runtimeVersion = root.dependencies?.['@deepseek-ai/dsh']
  assert.match(runtimeVersion ?? '', /^\d+\.\d+\.\d+-rc\.\d+$/u)
  const expectedRange = `>=${runtimeVersion} <0.2.0`

  for (const file of workspacePackageFiles) {
    const workspace = JSON.parse(await readFile(file, 'utf8')) as PackageManifest
    for (const [name, version] of Object.entries(workspace.peerDependencies ?? {})) {
      if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) {
        assert.equal(version, expectedRange, `${file} peerDependencies.${name} must follow the public runtime`)
      }
    }
    for (const field of ['dependencies', 'devDependencies'] as const) {
      for (const [name, version] of Object.entries(workspace[field] ?? {})) {
        if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) {
          assert.equal(version, runtimeVersion, `${file} ${field}.${name} must use the tested runtime`)
        }
      }
    }
  }
})

const workspacePackageFiles = [
  'packages/llm-bailian/package.json',
  'packages/memory/package.json',
  'packages/tui/package.json',
  'packages/vision/package.json',
  'packages/web/package.json',
] as const

test('publishes one package with public TUI, Bailian, Memory, Vision, and Web entry points', async () => {
  const root = JSON.parse(await readFile('package.json', 'utf8')) as PackageManifest
  assert.equal(root.name, '@vascent/dsh-tui')
  assert.notEqual(root.private, true)
  assert.equal(root.publishConfig?.access, 'public')
  assert.deepEqual(root.bin, { dscode: 'bin/dscode.js' })

  const expectedExports = {
    '.': './packages/tui/dist/index.js',
    './tui': './packages/tui/dist/index.js',
    './bailian': './packages/tui/dist/bailian.js',
    './memory': './packages/tui/dist/memory.js',
    './vision': './packages/tui/dist/vision.js',
    './web': './packages/tui/dist/web.js',
  } as const
  for (const [specifier, expected] of Object.entries(expectedExports)) {
    const target = root.exports?.[specifier]
    assert.equal(typeof target === 'object' ? target.default : target, expected)
    assert.ok(root.files?.some(path => expected.startsWith(`./${path}`)), `${specifier} must be packed`)
  }

  for (const file of workspacePackageFiles) {
    const workspace = JSON.parse(await readFile(file, 'utf8')) as PackageManifest
    assert.ok(workspace.name, `${file} must declare a package name`)
    assert.equal(workspace.private, true, `${file} must block standalone publication`)
    assert.equal(workspace.publishConfig, undefined, `${file} must not declare registry access`)
  }
})

test('uses the official pi-tui package without dependency patches', async () => {
  const root = JSON.parse(await readFile('package.json', 'utf8')) as PackageManifest
  const tui = JSON.parse(await readFile('packages/tui/package.json', 'utf8')) as PackageManifest
  const workspace = parse(await readFile('pnpm-workspace.yaml', 'utf8')) as {
    patchedDependencies?: Record<string, string>
  }
  assert.equal(root.dependencies?.['@earendil-works/pi-tui'], '^0.84.2')
  assert.equal(tui.dependencies?.['@earendil-works/pi-tui'], '^0.84.2')
  assert.equal(workspace.patchedDependencies, undefined)
})

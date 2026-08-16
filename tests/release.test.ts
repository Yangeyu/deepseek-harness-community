import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'vitest'

interface PackageManifest {
  name?: string
  private?: boolean
  files?: string[]
  publishConfig?: { access?: string }
  exports?: Record<string, string | { types?: string; default?: string }>
}

const workspacePackageFiles = [
  'packages/memory/package.json',
  'packages/tui/package.json',
  'packages/vision/package.json',
] as const

test('publishes one package with public TUI, Memory, and Vision entry points', async () => {
  const root = JSON.parse(await readFile('package.json', 'utf8')) as PackageManifest
  assert.equal(root.name, '@vascent/dsh-tui')
  assert.notEqual(root.private, true)
  assert.equal(root.publishConfig?.access, 'public')

  const expectedExports = {
    '.': './packages/tui/dist/index.js',
    './tui': './packages/tui/dist/index.js',
    './memory': './packages/tui/dist/memory.js',
    './vision': './packages/tui/dist/vision.js',
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

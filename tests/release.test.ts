import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'vitest'
import { parse } from 'yaml'

interface PackageManifest {
  name?: string
  private?: boolean
  bin?: string | Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  packageManager?: string
  scripts?: Record<string, string>
  files?: string[]
  publishConfig?: { access?: string }
  exports?: Record<string, string | { types?: string; default?: string }>
}

test('uses one pinned toolchain and one release gate everywhere', async () => {
  const root = JSON.parse(await readFile('package.json', 'utf8')) as PackageManifest
  const releaseIt = JSON.parse(await readFile('.release-it.json', 'utf8')) as {
    hooks?: { 'before:init'?: string }
  }
  const [nodeVersion, ciWorkflow, releaseWorkflow] = await Promise.all([
    readFile('.node-version', 'utf8'),
    readFile('.github/workflows/ci.yml', 'utf8'),
    readFile('.github/workflows/release.yml', 'utf8'),
  ])

  assert.match(nodeVersion.trim(), /^\d+\.\d+\.\d+$/u)
  assert.match(root.packageManager ?? '', /^pnpm@\d+\.\d+\.\d+$/u)
  assert.match(root.devDependencies?.npm ?? '', /^\d+\.\d+\.\d+$/u)
  assert.equal(root.scripts?.['release:check'], 'node scripts/release-gate.mjs')
  assert.equal(root.scripts?.['install:check'], undefined)
  assert.equal(root.scripts?.['pack:check'], undefined)
  assert.equal(releaseIt.hooks?.['before:init'], 'pnpm run release:check')
  for (const workflow of [ciWorkflow, releaseWorkflow]) {
    assert.match(workflow, /node-version-file: \.node-version/u)
    assert.match(workflow, /pnpm run release:check/u)
    assert.doesNotMatch(workflow, /pnpm run (?:install|pack):check|npm pack/u)
  }
  assert.match(releaseWorkflow, /pnpm exec npm publish/u)
  assert.doesNotMatch(releaseWorkflow, /^\s*npm (?:publish|view)\b/mu)
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
    minimumReleaseAgeExclude?: string[]
    overrides?: Record<string, string>
    patchedDependencies?: Record<string, string>
  }
  assert.equal(root.dependencies?.['@earendil-works/pi-tui'], '^0.84.2')
  assert.equal(tui.dependencies?.['@earendil-works/pi-tui'], '^0.84.2')
  assert.deepEqual(workspace.minimumReleaseAgeExclude, [
    '@earendil-works/pi-tui@0.84.2',
    '@deepseek-ai/*',
  ])
  assert.equal(root.dependencies?.react, undefined)
  assert.equal(root.dependencies?.['react-dom'], undefined)
  assert.equal(root.devDependencies?.react, undefined)
  assert.equal(root.devDependencies?.['react-dom'], undefined)
  assert.equal(workspace.overrides?.['react-dom'], '18.3.1')
  assert.equal(workspace.patchedDependencies, undefined)
})

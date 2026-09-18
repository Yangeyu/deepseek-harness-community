import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { test } from 'vitest'

const require = createRequire(import.meta.url)
const dshRequire = createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
const { Loader } = await import(dshRequire.resolve('@deepseek-ai/cordis-plugin-loader'))
const { composeEntries, loadOverlayPatches } = await import(dshRequire.resolve('@deepseek-ai/dsh-app-boot'))

async function fixture(pnpmSource: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dscode-dev-'))
  await mkdir(join(root, 'node_modules/pnpm/bin'), { recursive: true })
  await mkdir(join(root, 'packages/tui/dist'), { recursive: true })
  await mkdir(join(root, 'bin'))
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(join(root, 'node_modules/pnpm/package.json'), '{"exports":"./package.json"}')
  await writeFile(join(root, 'node_modules/pnpm/bin/pnpm.mjs'), pnpmSource)
  return root
}

const recordBuild = `
import { appendFileSync } from 'node:fs'
appendFileSync('builds.jsonl', JSON.stringify({ args: process.argv.slice(2), dev: process.env.DSH_TUI_DEV_BUILD }) + '\\n')
`

test('pnpm dev builds the core without Browser and isolates the development build flag', async () => {
  const root = await fixture(recordBuild)
  try {
    await copyFile('bin/dscode-dev.js', join(root, 'bin/dscode-dev.js'))
    await writeFile(join(root, 'dist/launcher.js'), `
import { writeFileSync } from 'node:fs'
export async function main(args) {
  writeFileSync('launch.json', JSON.stringify({ args, profile: process.env.DSH_TUI_PROFILE, dev: process.env.DSH_TUI_DEV_BUILD }))
  return 0
}
`)
    const env = { ...process.env }
    delete env.DSH_TUI_DEV_BUILD
    const result = spawnSync(process.execPath, [join(root, 'bin/dscode-dev.js'), '--patch', 'team.yml'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const builds = (await readFile(join(root, 'builds.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(builds, [
      { args: ['--filter', '@vascent/deepseek-harness-tui...', '--filter', '!@vascent/deepseek-harness-browser', 'run', 'build'], dev: '1' },
      { args: ['exec', 'tsdown'], dev: '1' },
    ])
    assert.deepEqual(JSON.parse(await readFile(join(root, 'launch.json'), 'utf8')), {
      args: ['--patch', 'team.yml'], profile: 'tui-dev',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Cordis effective enablement imports the development entry and builds Browser only then', async () => {
  const root = await fixture(`${recordBuild}
import { mkdirSync, writeFileSync } from 'node:fs'
mkdirSync('packages/browser/dist', { recursive: true })
writeFileSync('packages/browser/dist/index.js', ${JSON.stringify("export const Config = {}; export function BrowserService(ctx) { ctx.provide('devBrowserLoaded', true) }; export default BrowserService")})
`)
  const ctx = new Context()
  try {
    const entryPath = join(root, 'packages/tui/dist/browser.js')
    await copyFile('packages/tui/browser-dev.ts', entryPath)
    const browser = composeEntries([loadOverlayPatches('test', 'packages/tui/cordis.patch.yml')])
      .find((entry: { id?: string }) => entry.id === 'browser')
    assert.equal(browser?.disabled, true)
    await ctx.plugin(Loader)
    const loader = ctx.get('loader')
    const id = await loader.create({ ...browser, name: pathToFileURL(entryPath).href })
    await loader.await()
    assert.equal(existsSync(join(root, 'builds.jsonl')), false)

    // Let the actual Loader evaluate the expression; the launcher never approximates it.
    await loader.update(id, { disabled: { __jsExpr: 'false' } })
    await loader.await()
    assert.equal(ctx.get('devBrowserLoaded'), true)
    const builds = (await readFile(join(root, 'builds.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(builds.length, 1)
    assert.deepEqual(builds[0].args, ['--filter', '@vascent/deepseek-harness-browser', 'run', 'build'])
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('an enabled Browser reports a development build failure instead of importing stale output', async () => {
  const root = await fixture('process.exit(23)')
  try {
    const entryPath = join(root, 'packages/tui/dist/browser.js')
    await copyFile('packages/tui/browser-dev.ts', entryPath)
    await assert.rejects(import(pathToFileURL(entryPath).href), /Browser development build failed \(23\)/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

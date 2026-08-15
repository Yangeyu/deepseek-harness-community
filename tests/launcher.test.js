import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ensureProfilePlugin,
  profileLegacyPlugins,
  profileUsesPlugin,
  resolveDshHome,
  resolveTuiProfile,
} from '../src/launcher.js'

test('resolveDshHome uses a non-empty override', () => {
  assert.equal(resolveDshHome({ DSH_HOME: './custom-dsh-home' }), join(process.cwd(), 'custom-dsh-home'))
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }), join(process.env.HOME, '.dsh'))
})

test('resolveTuiProfile supports an isolated development profile', () => {
  assert.equal(resolveTuiProfile({}), 'tui')
  assert.equal(resolveTuiProfile({ DSH_TUI_PROFILE: 'tui-dev' }), 'tui-dev')
  assert.equal(resolveTuiProfile({ DSH_TUI_PROFILE: '   ' }), 'tui')
  assert.throws(
    () => resolveTuiProfile({ DSH_TUI_PROFILE: '../tui' }),
    /invalid DSH_TUI_PROFILE/,
  )
})

test('profileUsesPlugin requires the active bundle to resolve to this package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-launcher-'))
  const profile = join(root, 'profile')
  const plugin = join(root, 'plugin')
  await mkdir(join(profile, 'node_modules', '@vascent'), { recursive: true })
  await mkdir(plugin)
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: ['@vascent/deepseek-harness-tui'] } },
  }))
  await symlink(plugin, join(profile, 'node_modules', '@vascent', 'deepseek-harness-tui'), 'dir')

  assert.equal(profileUsesPlugin(profile, plugin), true)
  assert.equal(profileUsesPlugin(profile, join(root, 'other-plugin')), false)
})

test('ensureProfilePlugin removes the legacy package once and preserves the active local bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-migration-'))
  const profile = join(root, 'profile')
  const plugin = join(root, 'plugin')
  const manifestPath = join(profile, 'package.json')
  await mkdir(join(profile, 'node_modules', '@vascent'), { recursive: true })
  await mkdir(plugin)
  await writeFile(manifestPath, JSON.stringify({
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@vascent/deepseek-harness-tui',
          '@yangeyu/deepseek-harness-tui',
        ],
      },
    },
    dependencies: {
      '@vascent/deepseek-harness-tui': `link:${plugin}`,
      '@yangeyu/deepseek-harness-tui': 'link:/obsolete/tui',
    },
  }))
  await symlink(plugin, join(profile, 'node_modules', '@vascent', 'deepseek-harness-tui'), 'dir')

  const calls = []
  const runPlugin = async (args) => {
    calls.push(args)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    delete manifest.dependencies[args[1]]
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== args[1])
    await writeFile(manifestPath, JSON.stringify(manifest))
    return 0
  }

  assert.deepEqual(profileLegacyPlugins(profile), ['@yangeyu/deepseek-harness-tui'])
  assert.equal(await ensureProfilePlugin(profile, plugin, runPlugin), 0)
  assert.deepEqual(calls, [['remove', '@yangeyu/deepseek-harness-tui']])
  assert.deepEqual(profileLegacyPlugins(profile), [])
  assert.equal(await ensureProfilePlugin(profile, plugin, runPlugin), 0)
  assert.deepEqual(calls, [['remove', '@yangeyu/deepseek-harness-tui']])
})

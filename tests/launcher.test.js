import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { profileUsesPlugin, resolveDshHome } from '../src/launcher.js'

test('resolveDshHome uses a non-empty override', () => {
  assert.equal(resolveDshHome({ DSH_HOME: './custom-dsh-home' }), join(process.cwd(), 'custom-dsh-home'))
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }), join(process.env.HOME, '.dsh'))
})

test('profileUsesPlugin requires the active bundle to resolve to this package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-launcher-'))
  const profile = join(root, 'profile')
  const plugin = join(root, 'plugin')
  await mkdir(join(profile, 'node_modules', '@yangeyu'), { recursive: true })
  await mkdir(plugin)
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: ['@yangeyu/deepseek-harness-tui'] } },
  }))
  await symlink(plugin, join(profile, 'node_modules', '@yangeyu', 'deepseek-harness-tui'), 'dir')

  assert.equal(profileUsesPlugin(profile, plugin), true)
  assert.equal(profileUsesPlugin(profile, join(root, 'other-plugin')), false)
})

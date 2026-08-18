import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  ensureProfilePlugin,
  main,
  profileLegacyPlugins,
  profileUsesPlugin,
  resolveDshHome,
  resolveTuiProfile,
} from '../src/launcher.ts'

test('resolveDshHome uses a non-empty override', () => {
  assert.equal(resolveDshHome({ DSH_HOME: './custom-dsh-home' }), join(process.cwd(), 'custom-dsh-home'))
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }), join(homedir(), '.dsh'))
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

  const calls: Array<readonly string[]> = []
  const runPlugin = async (args: readonly string[]) => {
    const packageName = args[1]
    assert.ok(packageName)
    calls.push(args)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    delete manifest.dependencies[packageName]
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(
      (name: string) => name !== packageName,
    )
    await writeFile(manifestPath, JSON.stringify(manifest))
    return 0
  }

  assert.deepEqual(profileLegacyPlugins(profile), ['@yangeyu/deepseek-harness-tui'])
  assert.equal(await ensureProfilePlugin(profile, plugin, runPlugin, () => {}), 0)
  assert.deepEqual(calls, [['remove', '@yangeyu/deepseek-harness-tui']])
  assert.deepEqual(profileLegacyPlugins(profile), [])
  assert.equal(await ensureProfilePlugin(profile, plugin, runPlugin, () => {}), 0)
  assert.deepEqual(calls, [['remove', '@yangeyu/deepseek-harness-tui']])
})

function output() {
  let value = ''
  return {
    stream: {
      write(text: string) { value += text },
      isTTY: true,
    },
    read: () => value,
  }
}

test('help, version, and usage errors resolve before profile setup or child execution', async () => {
  const stdout = output()
  const stderr = output()
  let setupCalls = 0
  let runCalls = 0
  const options = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    ensureProfile: async () => { setupCalls += 1; return 0 },
    runNode: async () => { runCalls += 1; return 0 },
    resolveDshBin: () => '/unused/dsh',
    packageVersion: '0.1.9',
  }

  assert.equal(await main(['--help'], options), 0)
  assert.match(stdout.read(), /Usage:\n  dscode/)
  assert.match(stdout.read(), /-v, -V, --version/)
  const versionStdout = output()
  for (const flag of ['-v', '-V', '--version']) {
    assert.equal(await main([flag], { ...options, stdout: versionStdout.stream }), 0)
  }
  assert.equal(versionStdout.read(), 'dscode 0.1.9\n'.repeat(3))
  assert.equal(await main(['--version', 'extra'], options), 2)
  assert.match(stderr.read(), /--version cannot be combined with other arguments/)
  assert.equal(setupCalls, 0)
  assert.equal(runCalls, 0)
})

test('interactive commands configure the TUI profile and forward canonical app arguments', async () => {
  const calls: Array<{ args: readonly string[]; cwd: string }> = []
  let setupCalls = 0
  const code = await main([
    '--patch', 'team.yml',
    'resume', '--last',
    '--plan',
    '--image', 'context.png',
    'continue',
  ], {
    cwd: '/workspace',
    ensureProfile: async () => { setupCalls += 1; return 0 },
    resolveDshBin: () => '/runtime/dsh.js',
    runNode: async (_script, args, _env, cwd) => {
      calls.push({ args, cwd })
      return 7
    },
  })

  assert.equal(code, 7)
  assert.equal(setupCalls, 1)
  assert.deepEqual(calls, [{
    args: [
      '--profile', 'tui',
      '--patch', 'team.yml',
      'resume', '--last',
      '--image', 'context.png',
      '--plan',
      '--', 'continue',
    ],
    cwd: '/workspace',
  }])
})

test('exec uses the headless profile and never configures the TUI profile', async () => {
  const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv; cwd: string }> = []
  let setupCalls = 0
  const code = await main(['exec', '-C', './project', '--patch', 'ci.yml', 'run', 'tests'], {
    cwd: '/workspace',
    ensureProfile: async () => { setupCalls += 1; return 0 },
    resolveDshBin: () => '/runtime/dsh.js',
    runNode: async (_script, args, env, cwd) => {
      calls.push({ args, env, cwd })
      return 0
    },
  })

  assert.equal(code, 0)
  assert.equal(setupCalls, 0)
  assert.deepEqual(calls[0]?.args, ['--profile', 'headless', '--patch', 'ci.yml', 'run tests'])
  assert.equal(calls[0]?.cwd, '/workspace/project')
  assert.equal(calls[0]?.env.DSH_CWD, '/workspace/project')
})

test('exec reads a non-interactive prompt from stdin and rejects an empty TTY invocation', async () => {
  const calls: Array<readonly string[]> = []
  const shared = {
    resolveDshBin: () => '/runtime/dsh.js',
    runNode: async (_script: string, args: readonly string[]) => { calls.push(args); return 0 },
  }
  assert.equal(await main(['exec'], {
    ...shared,
    stdinIsTTY: false,
    readStdin: async () => '  inspect the repository\n',
  }), 0)
  assert.deepEqual(calls[0], ['--profile', 'headless', 'inspect the repository'])

  const stderr = output()
  assert.equal(await main(['exec'], { ...shared, stderr: stderr.stream, stdinIsTTY: true }), 2)
  assert.match(stderr.read(), /prompt argument or piped stdin/)
})

test('config and plugin actions delegate only after the TUI profile is ready', async () => {
  const calls: Array<readonly string[]> = []
  let setupCalls = 0
  const options = {
    ensureProfile: async () => { setupCalls += 1; return 0 },
    resolveDshBin: () => '/runtime/dsh.js',
    runNode: async (_script: string, args: readonly string[]) => { calls.push(args); return 0 },
  }

  assert.equal(await main(['config', 'show', '--patch', 'team.yml'], options), 0)
  assert.equal(await main(['plugin', 'list'], options), 0)
  assert.equal(setupCalls, 2)
  assert.deepEqual(calls, [
    ['--profile', 'tui', '--patch', 'team.yml', '--dump-config'],
    ['plugin', '--profile', 'tui', 'list'],
  ])
})

test('doctor reports profile state without initializing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-doctor-'))
  const stdout = output()
  let setupCalls = 0
  const code = await main(['doctor', '--json'], {
    cwd: process.cwd(),
    env: { ...process.env, DSH_HOME: root },
    stdout: stdout.stream,
    ensureProfile: async () => { setupCalls += 1; return 0 },
    resolveDshBin: () => join(process.cwd(), 'package.json'),
    resolveRgBin: async () => process.execPath,
    platform: 'linux',
  })

  const report = JSON.parse(stdout.read())
  assert.equal(code, 0)
  assert.equal(report.ok, true)
  assert.equal(report.checks.find((check: { id: string }) => check.id === 'profile')?.status, 'warn')
  assert.equal(setupCalls, 0)
})

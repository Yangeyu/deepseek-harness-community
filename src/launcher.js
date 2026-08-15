import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const DEFAULT_PROFILE = 'tui'
const TUI_PACKAGE = '@vascent/deepseek-harness-tui'
const LEGACY_TUI_PACKAGES = ['@yangeyu/deepseek-harness-tui']
const require = createRequire(import.meta.url)

function readProfileManifest(profileDirectory) {
  const manifestPath = join(profileDirectory, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return undefined
  }
}

/** Resolve the Harness home using the same environment precedence as dsh. */
export function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME?.trim()
  return resolve(configured ? configured : join(homedir(), '.dsh'))
}

/** Resolve the profile name, allowing the development launcher to stay isolated. */
export function resolveTuiProfile(env = process.env) {
  const profile = env.DSH_TUI_PROFILE?.trim() || DEFAULT_PROFILE
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile)) {
    throw new Error(`invalid DSH_TUI_PROFILE: ${profile}`)
  }
  return profile
}

/** Return whether the profile's installed TUI resolves to this launcher copy. */
export function profileUsesPlugin(profileDirectory, pluginDirectory) {
  const installedPath = join(profileDirectory, 'node_modules', '@vascent', 'deepseek-harness-tui')
  if (!existsSync(installedPath)) return false
  try {
    const manifest = readProfileManifest(profileDirectory)
    const bundles = manifest.dsh?.profile?.bundles
    return Array.isArray(bundles)
      && bundles.includes(TUI_PACKAGE)
      && realpathSync(installedPath) === realpathSync(pluginDirectory)
  } catch {
    return false
  }
}

/** Return obsolete TUI package names still referenced by one profile. */
export function profileLegacyPlugins(profileDirectory) {
  const manifest = readProfileManifest(profileDirectory)
  const dependencies = manifest?.dependencies ?? {}
  const bundles = manifest?.dsh?.profile?.bundles
  return LEGACY_TUI_PACKAGES.filter(packageName => (
    Object.hasOwn(dependencies, packageName)
    || (Array.isArray(bundles) && bundles.includes(packageName))
  ))
}

/** Migrate legacy package names and ensure the profile points at this launcher copy. */
export async function ensureProfilePlugin(profileDirectory, pluginDirectory, runPlugin) {
  const manifest = readProfileManifest(profileDirectory)
  const dependencies = manifest?.dependencies ?? {}
  for (const packageName of profileLegacyPlugins(profileDirectory)) {
    if (!Object.hasOwn(dependencies, packageName)) {
      throw new Error(`profile still references legacy bundle ${packageName} without an installed dependency`)
    }
    process.stderr.write(`dsh-tui: removing legacy profile plugin ${packageName}\n`)
    const removeCode = await runPlugin(['remove', packageName])
    if (removeCode !== 0) return removeCode
  }

  const legacy = profileLegacyPlugins(profileDirectory)
  if (legacy.length > 0) throw new Error(`legacy profile plugin remained after migration: ${legacy.join(', ')}`)
  if (profileUsesPlugin(profileDirectory, pluginDirectory)) return 0

  process.stderr.write('dsh-tui: configuring the profile for this installation\n')
  const addCode = await runPlugin(['add', pluginDirectory])
  if (addCode !== 0) return addCode
  if (!profileUsesPlugin(profileDirectory, pluginDirectory)) {
    throw new Error('profile configuration completed without activating this TUI bundle')
  }
  return 0
}

function packageBin(packageName, binName) {
  const manifestPath = require.resolve(`${packageName}/package.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const relativeBin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName]
  if (typeof relativeBin !== 'string') throw new Error(`${packageName} does not declare the ${binName} executable`)
  return join(dirname(manifestPath), relativeBin)
}

function runNode(script, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', code => resolvePromise(code ?? 1))
  })
}

/** Configure the profile when needed, then run the TUI with forwarded arguments. */
export async function main(args) {
  const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
  const pluginDirectory = join(repositoryRoot, 'packages', 'tui')
  const profile = resolveTuiProfile()
  const profileDirectory = join(resolveDshHome(), 'profiles', profile)
  const dshBin = packageBin('@deepseek-ai/dsh', 'dsh')
  const env = {
    ...process.env,
    PATH: `${join(repositoryRoot, 'node_modules', '.bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
  }

  try {
    const setupCode = await ensureProfilePlugin(
      profileDirectory,
      pluginDirectory,
      pluginArgs => runNode(dshBin, ['plugin', '--profile', profile, ...pluginArgs], env),
    )
    if (setupCode !== 0) return setupCode
    return await runNode(dshBin, ['--profile', profile, ...args], env)
  } catch (error) {
    process.stderr.write(`dsh-tui: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

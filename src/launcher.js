import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const PROFILE = 'tui'
const TUI_PACKAGE = '@yangeyu/deepseek-harness-tui'
const require = createRequire(import.meta.url)

/** Resolve the Harness home using the same environment precedence as dsh. */
export function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME?.trim()
  return resolve(configured ? configured : join(homedir(), '.dsh'))
}

/** Return whether the profile's installed TUI resolves to this launcher copy. */
export function profileUsesPlugin(profileDirectory, pluginDirectory) {
  const manifestPath = join(profileDirectory, 'package.json')
  const installedPath = join(profileDirectory, 'node_modules', '@yangeyu', 'deepseek-harness-tui')
  if (!existsSync(manifestPath) || !existsSync(installedPath)) return false
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles
    return Array.isArray(bundles)
      && bundles.includes(TUI_PACKAGE)
      && realpathSync(installedPath) === realpathSync(pluginDirectory)
  } catch {
    return false
  }
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
  const profileDirectory = join(resolveDshHome(), 'profiles', PROFILE)
  const dshBin = packageBin('@deepseek-ai/dsh', 'dsh')
  const env = {
    ...process.env,
    PATH: `${join(repositoryRoot, 'node_modules', '.bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
  }

  try {
    if (!profileUsesPlugin(profileDirectory, pluginDirectory)) {
      process.stderr.write('dsh-tui: configuring the tui profile for this installation\n')
      const setupCode = await runNode(dshBin, ['plugin', '--profile', PROFILE, 'add', pluginDirectory], env)
      if (setupCode !== 0) return setupCode
    }
    return await runNode(dshBin, ['--profile', PROFILE, ...args], env)
  } catch (error) {
    process.stderr.write(`dsh-tui: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

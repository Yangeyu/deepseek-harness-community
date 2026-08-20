import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import {
  CliUsageError,
  formatCliError,
  parseCliArgs,
  renderCliHelp,
  renderCliVersion,
  renderCompletion,
  tuiAppArgs,
} from '../packages/tui/src/application/cli.ts'
import { diagnose, formatDoctorReport } from './doctor.ts'

const DEFAULT_PROFILE = 'tui'
const HEADLESS_PROFILE = 'headless'
const TUI_PACKAGE = '@vascent/deepseek-harness-tui'
const LEGACY_TUI_PACKAGES = ['@yangeyu/deepseek-harness-tui']
const SETTINGS_EXAMPLE_FILENAME = 'settings.yaml.example'
const PATCH_EXAMPLE_FILENAME = 'cordis.patch.yml.example'
const EXAMPLE_FILENAMES = [SETTINGS_EXAMPLE_FILENAME, PATCH_EXAMPLE_FILENAME]
const require = createRequire(import.meta.url)

interface ProfileManifest {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly dsh?: {
    readonly profile?: {
      readonly bundles?: unknown
    }
  }
}

type RunPlugin = (args: readonly string[]) => Promise<number>
type WriteText = (text: string) => unknown

/**
 * Seed the commented example configuration guides into the Harness home the
 * first time they are missing there. These are guidance-only reference files
 * (`settings.yaml.example` teaches the settings document; `cordis.patch.yml.example`
 * teaches the patch layers) and are never loaded, so existing files are never
 * overwritten and users may edit or delete them freely.
 * @param home - the resolved Harness home (`DSH_HOME` or `~/.dsh`).
 * @param examplesDirectory - the installation directory shipping the example files.
 * @returns the number of guide files written (0 when everything already exists or no source).
 */
export function seedConfigExamples(home: string, examplesDirectory: string): number {
  let seeded = 0
  for (const filename of EXAMPLE_FILENAMES) {
    const source = join(examplesDirectory, filename)
    const target = join(home, filename)
    if (!existsSync(source) || existsSync(target)) continue
    try {
      mkdirSync(home, { recursive: true })
      copyFileSync(source, target)
      seeded += 1
    } catch {
      // Best-effort onboarding: a read-only home or missing examples must never block the TUI.
    }
  }
  return seeded
}

export type NodeRunner = (
  script: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  output: 'inherit' | 'stderr',
) => Promise<number>

export interface LauncherOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
  stdout?: { write: WriteText; isTTY?: boolean }
  stderr?: { write: WriteText }
  stdinIsTTY?: boolean
  readStdin?: () => Promise<string>
  runNode?: NodeRunner
  ensureProfile?: () => Promise<number>
  seedExamples?: (home: string) => number | Promise<number>
  resolveDshBin?: () => string
  resolveRgBin?: () => Promise<string>
  nodeVersion?: string
  packageVersion?: string
  platform?: NodeJS.Platform
}

function packageVersion(): string {
  const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    throw new Error(`package version is missing from ${manifestPath}`)
  }
  return manifest.version
}

function readProfileManifest(profileDirectory: string): ProfileManifest | undefined {
  const manifestPath = join(profileDirectory, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return undefined
  }
}

/** Resolve the Harness home using the same environment precedence as dsh. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  return resolve(configured ? configured : join(homedir(), '.dsh'))
}

/** Resolve the profile name, allowing the development launcher to stay isolated. */
export function resolveTuiProfile(env: NodeJS.ProcessEnv = process.env): string {
  const profile = env.DSH_TUI_PROFILE?.trim() || DEFAULT_PROFILE
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile)) {
    throw new Error(`invalid DSH_TUI_PROFILE: ${profile}`)
  }
  return profile
}

/** Return whether the profile's installed TUI resolves to this launcher copy. */
export function profileUsesPlugin(profileDirectory: string, pluginDirectory: string): boolean {
  const installedPath = join(profileDirectory, 'node_modules', '@vascent', 'deepseek-harness-tui')
  if (!existsSync(installedPath)) return false
  try {
    const manifest = readProfileManifest(profileDirectory)
    const bundles = manifest?.dsh?.profile?.bundles
    return Array.isArray(bundles)
      && bundles.includes(TUI_PACKAGE)
      && realpathSync(installedPath) === realpathSync(pluginDirectory)
  } catch {
    return false
  }
}

/** Return obsolete TUI package names still referenced by one profile. */
export function profileLegacyPlugins(profileDirectory: string): string[] {
  const manifest = readProfileManifest(profileDirectory)
  const dependencies = manifest?.dependencies ?? {}
  const bundles = manifest?.dsh?.profile?.bundles
  return LEGACY_TUI_PACKAGES.filter(packageName => (
    Object.hasOwn(dependencies, packageName)
    || (Array.isArray(bundles) && bundles.includes(packageName))
  ))
}

/** Migrate legacy package names and ensure the profile points at this launcher copy. */
export async function ensureProfilePlugin(
  profileDirectory: string,
  pluginDirectory: string,
  runPlugin: RunPlugin,
  report: WriteText = text => process.stderr.write(text),
): Promise<number> {
  const manifest = readProfileManifest(profileDirectory)
  const dependencies = manifest?.dependencies ?? {}
  for (const packageName of profileLegacyPlugins(profileDirectory)) {
    if (!Object.hasOwn(dependencies, packageName)) {
      throw new Error(`profile still references legacy bundle ${packageName} without an installed dependency`)
    }
    report(`dscode: removing legacy profile plugin ${packageName}\n`)
    const removeCode = await runPlugin(['remove', packageName])
    if (removeCode !== 0) return removeCode
  }

  const legacy = profileLegacyPlugins(profileDirectory)
  if (legacy.length > 0) throw new Error(`legacy profile plugin remained after migration: ${legacy.join(', ')}`)
  if (profileUsesPlugin(profileDirectory, pluginDirectory)) return 0

  report('dscode: configuring the profile for this installation\n')
  const addCode = await runPlugin(['add', pluginDirectory])
  if (addCode !== 0) return addCode
  if (!profileUsesPlugin(profileDirectory, pluginDirectory)) {
    throw new Error('profile configuration completed without activating this TUI bundle')
  }
  return 0
}

function packageBin(packageName: string, binName: string): string {
  const manifestPath = require.resolve(`${packageName}/package.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const relativeBin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName]
  if (typeof relativeBin !== 'string') throw new Error(`${packageName} does not declare the ${binName} executable`)
  return join(dirname(manifestPath), relativeBin)
}

function runNode(
  script: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  output: 'inherit' | 'stderr',
): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env,
      stdio: ['inherit', output === 'stderr' ? 'pipe' : 'inherit', 'inherit'],
    })
    child.stdout?.pipe(process.stderr)
    child.once('error', reject)
    child.once('exit', code => resolvePromise(code ?? 1))
  })
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function patchArgs(patches: readonly string[]): string[] {
  return patches.flatMap(path => ['--patch', path])
}

function unreachable(invocation: never): never {
  throw new Error(`unhandled CLI invocation: ${JSON.stringify(invocation)}`)
}

/** Parse first, then run exactly one action; informational actions never touch a profile. */
export async function main(args: readonly string[], options: LauncherOptions = {}): Promise<number> {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr

  try {
    const invocation = parseCliArgs(args)
    if (invocation.kind === 'help') {
      stdout.write(renderCliHelp(invocation.topic))
      return 0
    }
    if (invocation.kind === 'version') {
      stdout.write(renderCliVersion(options.packageVersion ?? packageVersion()))
      return 0
    }
    if (invocation.kind === 'completion') {
      stdout.write(renderCompletion(invocation.shell))
      return 0
    }

    const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
    const pluginDirectory = join(repositoryRoot, 'packages', 'tui')
    const profile = resolveTuiProfile(env)
    const home = resolveDshHome(env)
    const profileDirectory = join(home, 'profiles', profile)
    const childEnv = {
      ...env,
      PATH: `${join(repositoryRoot, 'node_modules', '.bin')}${delimiter}${env.PATH ?? ''}`,
    }
    const nodeRunner = options.runNode ?? runNode
    const resolveDshBin = options.resolveDshBin ?? (() => packageBin('@deepseek-ai/dsh', 'dsh'))
    const launchDsh = (
      dshArgs: readonly string[],
      launchOptions: {
        cwd?: string
        env?: NodeJS.ProcessEnv
        output?: 'inherit' | 'stderr'
      } = {},
    ): Promise<number> => nodeRunner(
      resolveDshBin(),
      dshArgs,
      launchOptions.env ?? childEnv,
      launchOptions.cwd ?? cwd,
      launchOptions.output ?? 'inherit',
    )
    const ensureProfile = options.ensureProfile ?? (() => ensureProfilePlugin(
      profileDirectory,
      pluginDirectory,
      pluginArgs => launchDsh(
        ['plugin', '--profile', profile, ...pluginArgs],
        { output: 'stderr' },
      ),
      text => stderr.write(text),
    ))

    if (invocation.kind === 'doctor') {
      const report = await diagnose({
        cwd,
        env,
        nodeVersion: options.nodeVersion ?? process.versions.node,
        platform: options.platform ?? process.platform,
        stdoutIsTTY: options.stdout?.isTTY ?? process.stdout.isTTY,
        pluginDirectory,
        profileDirectory,
        profileConfigured: profileUsesPlugin(profileDirectory, pluginDirectory),
        resolveDshBin,
        resolveRgBin: options.resolveRgBin ?? (async () => (await import('@vscode/ripgrep')).rgPath),
      })
      stdout.write(formatDoctorReport(report, invocation.json))
      return report.ok ? 0 : 1
    }

    if (invocation.kind === 'exec') {
      let prompt = invocation.prompt
      if (prompt === undefined) {
        if (options.stdinIsTTY ?? process.stdin.isTTY) {
          throw new CliUsageError('exec requires a prompt argument or piped stdin')
        }
        prompt = (await (options.readStdin ?? readStandardInput)()).trim()
        if (prompt === '') throw new CliUsageError('exec received an empty prompt from stdin')
      }
      const executionCwd = resolve(cwd, invocation.cwd ?? '.')
      return await launchDsh(
        ['--profile', HEADLESS_PROFILE, ...patchArgs(invocation.patches), prompt],
        { cwd: executionCwd, env: { ...childEnv, DSH_CWD: executionCwd } },
      )
    }

    const setupCode = await ensureProfile()
    if (setupCode !== 0) return setupCode

    const seedExampleGuides = options.seedExamples ?? ((h: string) => seedConfigExamples(h, join(repositoryRoot, 'examples')))
    const seededGuides = await seedExampleGuides(home)
    if (seededGuides > 0) {
      stderr.write(
        'dscode: first run — wrote reference config guides into your home:\n'
        + `dscode:   ${join(home, SETTINGS_EXAMPLE_FILENAME)} (how to edit settings.yaml; hot-reloaded)\n`
        + `dscode:   ${join(home, PATCH_EXAMPLE_FILENAME)} (profile/patch-layer overrides)\n`
        + 'dscode: These guides are inert examples; edit settings.yaml to apply changes.\n',
      )
    }

    if (invocation.kind === 'config') {
      return await launchDsh([
        '--profile',
        profile,
        ...patchArgs(invocation.patches),
        invocation.defaults ? '--dump-default-config' : '--dump-config',
      ])
    }
    if (invocation.kind === 'plugin') {
      return await launchDsh(['plugin', '--profile', profile, ...invocation.args])
    }
    if (invocation.kind === 'interactive' || invocation.kind === 'sessions') {
      return await launchDsh([
        '--profile',
        profile,
        ...patchArgs(invocation.patches),
        ...tuiAppArgs(invocation),
      ])
    }
    return unreachable(invocation)
  } catch (error) {
    if (error instanceof CliUsageError) {
      stderr.write(formatCliError(error))
      return 2
    }
    stderr.write(`dscode: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

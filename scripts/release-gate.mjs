import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const timeoutMs = 600_000

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: process.env,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    let stdout = ''
    let stderr = ''

    if (options.capture) {
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
    }

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolveRun({ stdout, stderr })
        return
      }
      reject(new Error(
        `${command} ${args.join(' ')} failed with ${signal ?? `exit code ${code}`}\n${stderr}`,
      ))
    })
  })
}

function collectDshVersions(node, versions = new Map()) {
  for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) {
      const packageVersions = versions.get(name) ?? new Set()
      if (dependency.version) packageVersions.add(dependency.version)
      versions.set(name, packageVersions)
    }
    collectDshVersions(dependency, versions)
  }
  return versions
}

function parseArguments(args) {
  const values = args[0] === '--' ? args.slice(1) : args
  if (values.length === 0) return {}
  if (values.length === 2 && values[0] === '--artifacts-dir') {
    return { artifactsDirectory: resolve(repositoryRoot, values[1]) }
  }
  throw new Error('usage: pnpm run release:check -- [--artifacts-dir <path>]')
}

function verifyPackedFiles(files) {
  const paths = new Set(files.map(file => file.path))
  const required = [
    'bin/dscode.js',
    'dist/launcher.js',
    'packages/tui/cordis.patch.yml',
    'packages/tui/dist/index.js',
    'package.json',
  ]
  for (const path of required) {
    if (!paths.has(path)) throw new Error(`release archive is missing ${path}`)
  }
  const maintainedSource = files.find(file => (
    file.path.startsWith('src/')
    || file.path.startsWith('packages/tui/src/')
    || file.path.startsWith('packages/tui/lib/')
  ))
  if (maintainedSource) throw new Error(`release archive contains generated-boundary leak ${maintainedSource.path}`)
}

async function verifyInstalledArchive(archivePath, manifest, temporaryRoot) {
  const installDirectory = join(temporaryRoot, 'install')
  await mkdir(installDirectory)
  await run(npmCommand, [
    'install',
    '--global',
    '--prefix',
    installDirectory,
    '--no-audit',
    '--no-fund',
    '--loglevel=warn',
    archivePath,
  ])

  const { stdout: dependencyTreeJson } = await run(npmCommand, [
    'ls',
    '--global',
    '--prefix',
    installDirectory,
    '--all',
    '--json',
  ], { capture: true })
  const dependencyVersions = collectDshVersions(JSON.parse(dependencyTreeJson))
  const unexpectedVersions = [...dependencyVersions.entries()]
    .flatMap(([name, versions]) => [...versions]
      .filter(version => version !== manifest.dshRuntime.version)
      .map(version => `${name}@${version}`))
  if (unexpectedVersions.length > 0) {
    throw new Error(`fresh install mixed DeepSeek runtime versions: ${unexpectedVersions.join(', ')}`)
  }

  const executable = process.platform === 'win32'
    ? join(installDirectory, 'dscode.cmd')
    : join(installDirectory, 'bin', 'dscode')
  const { stdout } = await run(executable, ['--version'], {
    cwd: installDirectory,
    capture: true,
  })
  const expectedVersion = `dscode ${manifest.version}`
  if (stdout.trim() !== expectedVersion) {
    throw new Error(`expected ${JSON.stringify(expectedVersion)}, received ${JSON.stringify(stdout.trim())}`)
  }
  console.log(`Fresh global npm install passed: ${expectedVersion}`)
}

async function main(args) {
  const { artifactsDirectory } = parseArguments(args)
  const manifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'))
  await run(pnpmCommand, ['run', 'check'])

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-tui-release-gate-'))
  try {
    const packDirectory = artifactsDirectory ?? join(temporaryRoot, 'pack')
    await mkdir(packDirectory, { recursive: true })
    const { stdout } = await run(npmCommand, [
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      packDirectory,
    ], { capture: true })
    const packResults = JSON.parse(stdout)
    if (!Array.isArray(packResults) || packResults.length !== 1) {
      throw new Error(`expected one packed artifact, received ${packResults.length ?? 'invalid output'}`)
    }
    verifyPackedFiles(packResults[0].files ?? [])
    const archivePath = join(packDirectory, basename(packResults[0].filename))
    await verifyInstalledArchive(archivePath, manifest, temporaryRoot)
    console.log(`Release artifact passed: ${archivePath}`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

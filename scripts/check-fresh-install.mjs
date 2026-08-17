import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const timeoutMs = 180_000

function collectDeepSeekVersions(node, versions = new Map()) {
  for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
    if (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')) {
      const packageVersions = versions.get(name) ?? new Set()
      if (dependency.version) packageVersions.add(dependency.version)
      versions.set(name, packageVersions)
    }
    collectDeepSeekVersions(dependency, versions)
  }
  return versions
}

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

const manifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'))
const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-tui-fresh-install-'))

try {
  const packDirectory = join(temporaryRoot, 'pack')
  const installDirectory = join(temporaryRoot, 'install')
  await mkdir(packDirectory)
  await mkdir(installDirectory)
  await writeFile(join(installDirectory, 'package.json'), '{"private":true}\n')

  await run(npmCommand, [
    'pack',
    '--ignore-scripts',
    '--pack-destination',
    packDirectory,
  ])
  const archives = (await readdir(packDirectory)).filter(name => name.endsWith('.tgz'))
  if (archives.length !== 1) {
    throw new Error(`expected one package archive, found ${archives.length}`)
  }

  const archivePath = join(packDirectory, archives[0])
  await run(npmCommand, [
    'install',
    '--strict-peer-deps',
    '--no-audit',
    '--no-fund',
    '--loglevel=warn',
    archivePath,
  ], { cwd: installDirectory })

  const { stdout: dependencyTreeJson } = await run(npmCommand, ['ls', '--all', '--json'], {
    cwd: installDirectory,
    capture: true,
  })
  const dependencyVersions = collectDeepSeekVersions(JSON.parse(dependencyTreeJson))
  const runtimeVersion = manifest.dependencies['@deepseek-ai/dsh']
  const unexpectedVersions = [...dependencyVersions.entries()]
    .flatMap(([name, versions]) => [...versions]
      .filter(version => version !== runtimeVersion)
      .map(version => `${name}@${version}`))
  if (unexpectedVersions.length > 0) {
    throw new Error(`fresh install mixed DeepSeek runtime versions: ${unexpectedVersions.join(', ')}`)
  }

  const binPath = join(
    installDirectory,
    'node_modules',
    ...manifest.name.split('/'),
    manifest.bin['dsh-tui'],
  )
  const { stdout } = await run(process.execPath, [binPath, '--version'], {
    cwd: installDirectory,
    capture: true,
  })
  const expectedVersion = `dsh-tui ${manifest.version}`
  if (stdout.trim() !== expectedVersion) {
    throw new Error(`expected ${JSON.stringify(expectedVersion)}, received ${JSON.stringify(stdout.trim())}`)
  }

  console.log(`Fresh npm install passed with strict peers: ${expectedVersion}`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

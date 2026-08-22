import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmCommand = 'npm'
const pnpmCommand = 'pnpm'
const commandTimeoutMs = 600_000
const startupTimeoutMs = 60_000
const exitTimeoutMs = 10_000

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
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
      reject(new Error(`${command} ${args.join(' ')} timed out after ${commandTimeoutMs}ms`))
    }, commandTimeoutMs)

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

function parseArguments(args) {
  const values = args[0] === '--' ? args.slice(1) : args
  if (
    values.length !== 4
    || values[0] !== '--artifacts-dir'
    || values[2] !== '--source-sha'
    || !/^[0-9a-f]{40}$/u.test(values[3] ?? '')
  ) {
    throw new Error(
      'usage: pnpm run release:candidate -- --artifacts-dir <path> --source-sha <git-sha>',
    )
  }
  return {
    artifactsDirectory: resolve(repositoryRoot, values[1]),
    sourceSha: values[3],
  }
}

function exportedPaths(value, paths = new Set()) {
  if (typeof value === 'string') {
    if (value.startsWith('./')) paths.add(value.slice(2))
    return paths
  }
  if (value === null || typeof value !== 'object') return paths
  for (const child of Object.values(value)) exportedPaths(child, paths)
  return paths
}

function verifyPackedFiles(files, manifest) {
  const paths = new Set(files.map(file => file.path))
  const required = exportedPaths(manifest.exports)
  required.add('package.json')
  required.add('dist/launcher.js')
  const executables = typeof manifest.bin === 'string'
    ? [manifest.bin]
    : Object.values(manifest.bin ?? {})
  for (const executable of executables) {
    if (typeof executable !== 'string') throw new Error('root package bin entries must be paths')
    required.add(executable.replace(/^\.\//u, ''))
  }
  for (const path of required) {
    if (!paths.has(path)) throw new Error(`release archive is missing ${path}`)
  }

  const leak = files.find(file => (
    file.path.startsWith('src/')
    || /^packages\/[^/]+\/(?:src|lib)\//u.test(file.path)
    || file.path.endsWith('.map')
  ))
  if (leak) throw new Error(`release archive contains generated-boundary leak ${leak.path}`)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function waitFor(promise, timeoutMs, message) {
  let timeout
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
    }),
  ]).finally(() => { clearTimeout(timeout) })
}

async function verifyTuiStartup(executable, installDirectory, manifest, temporaryRoot) {
  const packageDirectory = join(installDirectory, 'lib', 'node_modules', ...manifest.name.split('/'))
  const requireInstalled = createRequire(join(packageDirectory, 'package.json'))
  const pty = requireInstalled('node-pty')
  if (typeof pty.spawn !== 'function') throw new Error('installed node-pty does not expose spawn()')

  const smokeHome = join(temporaryRoot, 'smoke-home')
  const smokeWorkspace = join(temporaryRoot, 'smoke-workspace')
  await mkdir(smokeHome)
  await mkdir(smokeWorkspace)

  const terminal = pty.spawn(executable, [], {
    cols: 80,
    rows: 24,
    cwd: smokeWorkspace,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: smokeHome,
      USER: process.env.USER ?? 'dscode-release',
      SHELL: process.env.SHELL ?? '/bin/sh',
      LANG: process.env.LANG ?? 'C.UTF-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      NO_COLOR: '1',
      DSH_HOME: join(smokeHome, '.dsh'),
      DSH_TUI_PROFILE: 'release-smoke',
    },
  })

  let output = ''
  let exited = false
  let resolveReady
  let rejectReady
  const ready = new Promise((resolveReadyPromise, rejectReadyPromise) => {
    resolveReady = resolveReadyPromise
    rejectReady = rejectReadyPromise
  })
  const exitedResult = new Promise(resolveExit => {
    terminal.onExit(result => {
      exited = true
      rejectReady(new Error(
        `installed TUI exited before Ready with code ${result.exitCode}: ${output.slice(-2000)}`,
      ))
      resolveExit(result)
    })
  })
  terminal.onData(data => {
    output += data
    if (output.includes('Ready')) resolveReady()
  })

  try {
    await waitFor(ready, startupTimeoutMs, `installed TUI did not reach Ready within ${startupTimeoutMs}ms`)
    terminal.write('\u0003')
    const result = await waitFor(
      exitedResult,
      exitTimeoutMs,
      `installed TUI did not exit after Ctrl+C within ${exitTimeoutMs}ms`,
    )
    if (result.exitCode !== 0) {
      throw new Error(`installed TUI exited with code ${result.exitCode}: ${output.slice(-2000)}`)
    }
    console.log('Fresh installed TUI PTY smoke passed: Ready -> Ctrl+C -> exit 0')
  } finally {
    if (!exited) terminal.kill()
  }
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

  const executable = join(installDirectory, 'bin', 'dscode')
  const { stdout } = await run(executable, ['--version'], {
    cwd: installDirectory,
    capture: true,
  })
  const expectedVersion = `dscode ${manifest.version}`
  if (stdout.trim() !== expectedVersion) {
    throw new Error(`expected ${JSON.stringify(expectedVersion)}, received ${JSON.stringify(stdout.trim())}`)
  }
  console.log(`Fresh global npm install passed: ${expectedVersion}`)
  await verifyTuiStartup(executable, installDirectory, manifest, temporaryRoot)
}

async function main(args) {
  const { artifactsDirectory, sourceSha } = parseArguments(args)
  const [manifestText, workspaceText] = await Promise.all([
    readFile(join(repositoryRoot, 'package.json'), 'utf8'),
    readFile(join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8'),
  ])
  const manifest = JSON.parse(manifestText)
  const workspace = parse(workspaceText)
  const runtimeVersion = workspace?.catalogs?.dsh?.['@deepseek-ai/dsh']
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error('root package must declare a name and version')
  }
  if (typeof runtimeVersion !== 'string') throw new Error('dsh runtime catalog is missing')

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-tui-release-candidate-'))
  try {
    await mkdir(artifactsDirectory, { recursive: true })
    const { stdout } = await run(pnpmCommand, [
      'pack',
      '--json',
      '--pack-destination',
      artifactsDirectory,
    ], { capture: true })
    const packResult = JSON.parse(stdout)
    if (packResult === null || typeof packResult !== 'object' || Array.isArray(packResult)) {
      throw new Error('pnpm pack did not return one artifact description')
    }
    if (!Array.isArray(packResult.files)) throw new Error('pnpm pack did not return a file manifest')
    if (packResult.name !== manifest.name || packResult.version !== manifest.version) {
      throw new Error('packed package identity does not match the root manifest')
    }
    verifyPackedFiles(packResult.files, manifest)

    const archiveName = basename(packResult.filename)
    const archivePath = join(artifactsDirectory, archiveName)
    const [archive, archiveStat, pnpmVersion, npmVersion] = await Promise.all([
      readFile(archivePath),
      stat(archivePath),
      run(pnpmCommand, ['--version'], { capture: true }),
      run(npmCommand, ['--version'], { capture: true }),
    ])
    await verifyInstalledArchive(archivePath, manifest, temporaryRoot)

    const receipt = {
      schema: 1,
      source: { gitSha: sourceSha },
      package: { name: manifest.name, version: manifest.version },
      runtime: { dsh: runtimeVersion },
      toolchain: {
        node: process.versions.node,
        pnpm: pnpmVersion.stdout.trim(),
        npm: npmVersion.stdout.trim(),
      },
      artifact: {
        file: archiveName,
        size: archiveStat.size,
        sha256: sha256(archive),
      },
    }
    const receiptPath = join(artifactsDirectory, 'release-receipt.json')
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
    console.log(`Release candidate passed: ${archivePath}`)
    console.log(`Release receipt written: ${receiptPath}`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

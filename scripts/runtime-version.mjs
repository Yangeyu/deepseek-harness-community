import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPaths = [
  'package.json',
  'packages/llm-bailian/package.json',
  'packages/memory/package.json',
  'packages/tui/package.json',
  'packages/vision/package.json',
  'packages/web/package.json',
]
const exactFields = ['dependencies', 'devDependencies', 'optionalDependencies']
const runtimeVersionPattern = /^\d+\.\d+\.\d+-rc\.\d+$/u

export function isDshRuntimePackage(name) {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

export function runtimePeerRange(version) {
  return `>=${version} <0.2.0`
}

export function synchronizeManifestRuntime(manifest, version, root = false) {
  if (root) manifest.dshRuntime = { ...manifest.dshRuntime, version }
  for (const field of exactFields) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (isDshRuntimePackage(name)) manifest[field][name] = version
    }
  }
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    if (isDshRuntimePackage(name)) manifest.peerDependencies[name] = runtimePeerRange(version)
  }
  return manifest
}

export function runtimeVersionIssues(manifest, version, path, root = false) {
  const issues = []
  if (root && manifest.dshRuntime?.version !== version) {
    issues.push(`${path} dshRuntime.version must be ${version}`)
  }
  for (const field of exactFields) {
    for (const [name, declared] of Object.entries(manifest[field] ?? {})) {
      if (isDshRuntimePackage(name) && declared !== version) {
        issues.push(`${path} ${field}.${name} must be ${version}`)
      }
    }
  }
  const peerRange = runtimePeerRange(version)
  for (const [name, declared] of Object.entries(manifest.peerDependencies ?? {})) {
    if (isDshRuntimePackage(name) && declared !== peerRange) {
      issues.push(`${path} peerDependencies.${name} must be ${peerRange}`)
    }
  }
  return issues
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0
      ? resolveRun()
      : reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code ?? 1}`)))
  })
}

async function readManifests() {
  return await Promise.all(manifestPaths.map(async path => ({
    path,
    manifest: JSON.parse(await readFile(resolve(repositoryRoot, path), 'utf8')),
  })))
}

async function main(args) {
  const values = args[0] === '--' ? args.slice(1) : args
  const entries = await readManifests()
  const currentVersion = entries[0].manifest.dshRuntime?.version
  if (values[0] === '--check') {
    if (typeof currentVersion !== 'string' || !runtimeVersionPattern.test(currentVersion)) {
      throw new Error('package.json dshRuntime.version must be an exact release candidate')
    }
    const issues = entries.flatMap(({ manifest, path }, index) => (
      runtimeVersionIssues(manifest, currentVersion, path, index === 0)
    ))
    if (issues.length > 0) throw new Error(`DeepSeek runtime version drift:\n${issues.join('\n')}`)
    console.log(`DeepSeek runtime manifests are aligned on ${currentVersion}`)
    return
  }

  const version = values[0]
  if (typeof version !== 'string' || !runtimeVersionPattern.test(version)) {
    throw new Error('usage: pnpm run runtime:update -- <x.y.z-rc.n>')
  }
  for (const [index, entry] of entries.entries()) {
    synchronizeManifestRuntime(entry.manifest, version, index === 0)
    await writeFile(resolve(repositoryRoot, entry.path), `${JSON.stringify(entry.manifest, null, 2)}\n`)
  }
  await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['install'])
  console.log(`DeepSeek runtime updated to ${version}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

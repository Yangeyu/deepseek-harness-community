import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export type DoctorStatus = 'fail' | 'pass' | 'warn'

export interface DoctorCheck {
  id: string
  status: DoctorStatus
  detail: string
}

export interface DoctorReport {
  ok: boolean
  checks: readonly DoctorCheck[]
}

export interface DoctorContext {
  cwd: string
  env: NodeJS.ProcessEnv
  nodeVersion: string
  platform: NodeJS.Platform
  stdoutIsTTY: boolean
  pluginDirectory: string
  profileDirectory: string
  profileConfigured: boolean
  resolveDshBin(): string
  resolveRgBin(): Promise<string>
}

function nodeSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  return major >= 24 || (major === 22 && minor >= 19)
}

function readableFile(path: string): boolean {
  try {
    accessSync(path, constants.R_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function executableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function workspaceAccess(path: string): DoctorCheck {
  try {
    accessSync(path, constants.R_OK)
    if (!statSync(path).isDirectory()) return { id: 'workspace', status: 'fail', detail: `${path} is not a directory` }
  } catch {
    return { id: 'workspace', status: 'fail', detail: `${path} is not readable` }
  }
  try {
    accessSync(path, constants.W_OK)
    return { id: 'workspace', status: 'pass', detail: `${path} is readable and writable` }
  } catch {
    return { id: 'workspace', status: 'warn', detail: `${path} is read-only` }
  }
}

function executableOnPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const path = join(directory, platform === 'win32' ? `${name}${extension}` : name)
      if (!existsSync(path)) continue
      try {
        accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
        return path
      } catch {
        // Continue through PATH until an executable adapter is found.
      }
    }
  }
  return undefined
}

function clipboardCheck(context: DoctorContext): DoctorCheck {
  const candidates = context.platform === 'darwin'
    ? ['pbcopy']
    : context.platform === 'win32'
      ? ['clip']
      : ['wl-copy', 'xclip', 'xsel']
  const executable = candidates
    .map(name => executableOnPath(name, context.env, context.platform))
    .find(path => path !== undefined)
  return executable === undefined
    ? { id: 'clipboard', status: 'warn', detail: 'no native clipboard command found; selection copy will use OSC 52' }
    : { id: 'clipboard', status: 'pass', detail: executable }
}

/** Inspect the installation without creating or repairing a Harness profile. */
export async function diagnose(context: DoctorContext): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [{
    id: 'node',
    status: nodeSupported(context.nodeVersion) ? 'pass' : 'fail',
    detail: `Node.js ${context.nodeVersion} (requires ^22.19.0 or >=24.0.0)`,
  }]

  try {
    const dshBin = context.resolveDshBin()
    const available = readableFile(dshBin)
    checks.push({
      id: 'dsh',
      status: available ? 'pass' : 'fail',
      detail: available ? dshBin : `unreadable executable: ${dshBin}`,
    })
  } catch (error) {
    checks.push({ id: 'dsh', status: 'fail', detail: error instanceof Error ? error.message : String(error) })
  }

  const pluginManifest = join(context.pluginDirectory, 'package.json')
  const pluginAvailable = readableFile(pluginManifest)
  checks.push({
    id: 'tui-bundle',
    status: pluginAvailable ? 'pass' : 'fail',
    detail: pluginAvailable ? context.pluginDirectory : `missing bundle manifest: ${pluginManifest}`,
  })

  try {
    const rgBin = await context.resolveRgBin()
    const available = executableFile(rgBin, context.platform)
    checks.push({
      id: 'ripgrep',
      status: available ? 'pass' : 'fail',
      detail: available ? rgBin : `unreadable executable: ${rgBin}`,
    })
  } catch (error) {
    checks.push({ id: 'ripgrep', status: 'fail', detail: error instanceof Error ? error.message : String(error) })
  }

  checks.push(workspaceAccess(context.cwd))
  checks.push({
    id: 'profile',
    status: context.profileConfigured ? 'pass' : 'warn',
    detail: context.profileConfigured
      ? context.profileDirectory
      : `${context.profileDirectory} is not configured; the next profile-backed command will initialize it`,
  })
  checks.push({
    id: 'terminal',
    status: context.stdoutIsTTY ? 'pass' : 'warn',
    detail: context.stdoutIsTTY ? `interactive terminal (${context.env.TERM ?? 'TERM unset'})` : 'stdout is not an interactive terminal',
  })
  checks.push(clipboardCheck(context))

  return { ok: checks.every(check => check.status !== 'fail'), checks }
}

export function formatDoctorReport(report: DoctorReport, json: boolean): string {
  if (json) return `${JSON.stringify(report, null, 2)}\n`
  const labels: Record<DoctorStatus, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' }
  const lines = report.checks.map(check => `${labels[check.status].padEnd(4)}  ${check.id.padEnd(12)} ${check.detail}`)
  const passed = report.checks.filter(check => check.status === 'pass').length
  const warned = report.checks.filter(check => check.status === 'warn').length
  const failed = report.checks.filter(check => check.status === 'fail').length
  return [...lines, '', `Summary: ${String(passed)} passed, ${String(warned)} warnings, ${String(failed)} failed`, ''].join('\n')
}

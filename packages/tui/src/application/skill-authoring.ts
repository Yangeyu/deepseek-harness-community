import {
  access,
  mkdir,
  readFile,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import {
  dirname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parse } from 'yaml'

export type SkillAuthoringScope = 'project' | 'user'

export interface SkillAuthoringTarget {
  scope: SkillAuthoringScope
  label: string
  root: string
}

export interface CreateLocalSkillRequest {
  target: SkillAuthoringTarget
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
}

export interface LocalSkillDocument {
  scope: SkillAuthoringScope
  root: string
  name: string
  path: string
}

export interface SkillValidationResult {
  ok: boolean
  errors: readonly string[]
}

function isSkillName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Match the filesystem provider's nearest-.git behavior, falling back to cwd. */
async function projectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd)
  while (true) {
    if (await exists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

function assertInside(root: string, destination: string): void {
  const child = relative(resolve(root), resolve(destination))
  if (child === '' || child === '..' || child.startsWith(`..${sep}`)) {
    throw new Error('Skill destination escapes the selected root')
  }
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function renderSkill(request: CreateLocalSkillRequest): string {
  return [
    '---',
    `name: ${yamlString(request.name)}`,
    `description: ${yamlString(request.description.trim())}`,
    ...request.whenToUse?.trim() ? [`whenToUse: ${yamlString(request.whenToUse.trim())}`] : [],
    `disable-model-invocation: ${request.modelInvocable ? 'false' : 'true'}`,
    `user-invocable: ${request.userInvocable ? 'true' : 'false'}`,
    '---',
    '',
    `# ${request.name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')}`,
    '',
    'Describe the workflow here.',
    '',
  ].join('\n')
}

function frontmatter(raw: string): Record<string, unknown> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  if (match?.[1] === undefined) return undefined
  const value = parse(match[1])
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Local filesystem adapter for the public project/user SKILL.md format. */
export class LocalSkillAuthoring {
  constructor(
    private readonly environment: Record<string, string | undefined> = process.env,
  ) {}

  async targets(cwd: string): Promise<readonly SkillAuthoringTarget[]> {
    const project = await projectRoot(cwd)
    return [{
      scope: 'project',
      label: 'Project',
      root: join(project, '.dsh', 'skills'),
    }, {
      scope: 'user',
      label: 'User',
      root: join(resolveDshHome(undefined, this.environment), 'skills'),
    }]
  }

  async create(request: CreateLocalSkillRequest): Promise<LocalSkillDocument> {
    const name = request.name.trim().toLowerCase()
    if (!isSkillName(name)) throw new Error('Skill name must use lowercase kebab-case')
    if (request.description.trim() === '') throw new Error('Skill description cannot be empty')
    const directory = join(request.target.root, name)
    const path = join(directory, 'SKILL.md')
    assertInside(request.target.root, path)
    await mkdir(request.target.root, { recursive: true })
    try {
      await mkdir(directory)
    } catch (error: unknown) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'EEXIST') throw new Error(`Skill "${name}" already exists in ${request.target.label}`)
      throw error
    }
    try {
      await writeFile(path, renderSkill({ ...request, name }), { encoding: 'utf8', flag: 'wx' })
    } catch (error: unknown) {
      await rmdir(directory).catch(() => undefined)
      throw error
    }
    return { scope: request.target.scope, root: request.target.root, name, path }
  }

  async resolveEditable(cwd: string, name: string): Promise<LocalSkillDocument | undefined> {
    if (!isSkillName(name)) return undefined
    for (const target of await this.targets(cwd)) {
      for (const path of [join(target.root, name, 'SKILL.md'), join(target.root, `${name}.md`)]) {
        assertInside(target.root, path)
        try {
          if ((await stat(path)).isFile()) {
            return { scope: target.scope, root: target.root, name, path }
          }
        } catch {
          // Absence means this provider does not own an editable local row.
        }
      }
    }
    return undefined
  }

  async validate(document: LocalSkillDocument): Promise<SkillValidationResult> {
    const errors: string[] = []
    let raw: string
    try {
      raw = await readFile(document.path, 'utf8')
    } catch (error: unknown) {
      return { ok: false, errors: [`Cannot read Skill: ${String(error)}`] }
    }
    let data: Record<string, unknown> | undefined
    try {
      data = frontmatter(raw)
    } catch (error: unknown) {
      return { ok: false, errors: [`Invalid YAML frontmatter: ${String(error)}`] }
    }
    if (data === undefined) return { ok: false, errors: ['SKILL.md must begin with YAML frontmatter'] }
    if (typeof data.name !== 'string' || !isSkillName(data.name)) errors.push('name must use lowercase kebab-case')
    else if (data.name !== document.name) errors.push(`name must match the local entry "${document.name}"`)
    if (typeof data.description !== 'string' || data.description.trim() === '') errors.push('description must be a non-empty string')
    if (data.whenToUse !== undefined && (typeof data.whenToUse !== 'string' || data.whenToUse.trim() === '')) {
      errors.push('whenToUse must be a non-empty string when present')
    }
    for (const key of ['disable-model-invocation', 'user-invocable']) {
      if (data[key] !== undefined && typeof data[key] !== 'boolean') errors.push(`${key} must be a boolean`)
    }
    for (const legacy of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
      if (Object.hasOwn(data, legacy)) errors.push(`${legacy} is unsupported; use canonical kebab-case invocation fields`)
    }
    return { ok: errors.length === 0, errors }
  }
}

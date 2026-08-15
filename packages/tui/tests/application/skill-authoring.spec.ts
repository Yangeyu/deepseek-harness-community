import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalSkillAuthoring } from '../../src/application/skill-authoring.ts'

describe('LocalSkillAuthoring', () => {
  it('creates the public project SKILL.md format without overwriting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tui-skill-'))
    await mkdir(join(root, '.git'))
    const authoring = new LocalSkillAuthoring({ DSH_HOME: join(root, 'home') })
    const project = (await authoring.targets(root))[0]
    expect(project?.scope).toBe('project')

    const document = await authoring.create({
      target: project!,
      name: 'release-check',
      description: 'Verify the release',
      whenToUse: 'After implementation',
      modelInvocable: false,
      userInvocable: true,
    })

    expect(await readFile(document.path, 'utf8')).toContain('disable-model-invocation: true')
    await expect(authoring.create({
      target: project!,
      name: 'release-check',
      description: 'Overwrite',
      modelInvocable: true,
      userInvocable: true,
    })).rejects.toThrow('already exists')
  })

  it('validates canonical fields after external editing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tui-skill-'))
    const authoring = new LocalSkillAuthoring({ DSH_HOME: join(root, 'home') })
    const user = (await authoring.targets(root))[1]
    const document = await authoring.create({
      target: user!,
      name: 'review',
      description: 'Review changes',
      modelInvocable: true,
      userInvocable: true,
    })
    await writeFile(document.path, [
      '---',
      'name: Review',
      'description: ""',
      'modelInvocable: true',
      '---',
    ].join('\n'))

    const validation = await authoring.validate(document)
    expect(validation.ok).toBe(false)
    expect(validation.errors).toEqual(expect.arrayContaining([
      'name must use lowercase kebab-case',
      'description must be a non-empty string',
      'modelInvocable is unsupported; use canonical kebab-case invocation fields',
    ]))
  })

  it('resolves project files before user files for local editing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tui-skill-'))
    await mkdir(join(root, '.git'))
    const authoring = new LocalSkillAuthoring({ DSH_HOME: join(root, 'home') })
    const [project, user] = await authoring.targets(root)
    for (const target of [user!, project!]) {
      await authoring.create({
        target,
        name: 'review',
        description: `${target.label} review`,
        modelInvocable: true,
        userInvocable: true,
      })
    }

    expect((await authoring.resolveEditable(root, 'review'))?.scope).toBe('project')
  })
})

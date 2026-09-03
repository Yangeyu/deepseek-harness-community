import type { SkillCatalog } from '../../../src/modules/skills/catalog.ts'
import { describe, expect, it, vi } from 'vitest'
import {
  SkillAuthoringCoordinator,
} from '../../../src/modules/skills/authoring.ts'
import type {
  LocalSkillDocument,
  LocalSkillEditorPort,
  SkillAuthoringPort,
  SkillAuthoringTarget,
} from '../../../src/modules/skills/contracts.ts'

const target: SkillAuthoringTarget = { scope: 'project', label: 'Project', root: '/project/.dsh/skills' }
const document: LocalSkillDocument = {
  scope: 'project',
  root: target.root,
  name: 'review',
  path: '/project/.dsh/skills/review/SKILL.md',
}

describe('SkillAuthoringCoordinator', () => {
  it('settles creation only after validation and effective catalog refresh', async () => {
    const authoring = {
      create: vi.fn(async () => document),
      validate: vi.fn(async () => ({ ok: true, errors: [] })),
    } as unknown as SkillAuthoringPort
    const catalog = {
      current: { entries: [{ name: 'review' }] },
      refresh: vi.fn(async () => []),
    } as unknown as SkillCatalog
    const editor: LocalSkillEditorPort = { open: vi.fn(async () => {}) }
    const notice = vi.fn()
    const coordinator = new SkillAuthoringCoordinator(authoring, catalog, editor, notice, async () => {})

    await coordinator.create({
      target,
      name: 'review',
      description: 'Review changes',
      modelInvocable: true,
      userInvocable: true,
    })

    expect(editor.open).toHaveBeenCalledWith(document, true)
    expect(catalog.refresh).toHaveBeenCalledWith(true)
    expect(notice).toHaveBeenCalledWith('Created /review')
  })

  it('reports provider-managed entries as read-only without opening an editor', async () => {
    const authoring = {
      resolveEditable: vi.fn(async () => undefined),
    } as unknown as SkillAuthoringPort
    const editor: LocalSkillEditorPort = { open: vi.fn(async () => {}) }
    const notice = vi.fn()
    const coordinator = new SkillAuthoringCoordinator(
      authoring,
      { current: { entries: [] } } as unknown as SkillCatalog,
      editor,
      notice,
      async () => {},
    )

    await coordinator.edit('/project', 'bundled-review')

    expect(editor.open).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledWith('/bundled-review is invocable but is not an editable project or user Skill.')
  })
})

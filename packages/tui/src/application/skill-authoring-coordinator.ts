import type { SkillCatalog } from '../runtime/skill-catalog.ts'
import {
  LocalSkillAuthoring,
  type CreateLocalSkillRequest,
  type LocalSkillDocument,
  type SkillAuthoringTarget,
} from './skill-authoring.ts'

export interface LocalSkillEditorPort {
  open(document: LocalSkillDocument, created: boolean): Promise<void>
}
/** Coordinates local file, editor, validation, and effective-catalog settlement. */
export class SkillAuthoringCoordinator {
  constructor(
    private readonly authoring: LocalSkillAuthoring,
    private readonly catalog: SkillCatalog,
    private readonly editor: LocalSkillEditorPort,
    private readonly notice: (message: string) => void,
    private readonly delay: (milliseconds: number) => Promise<void> = milliseconds => new Promise(
      resolve => setTimeout(resolve, milliseconds),
    ),
  ) {}

  targets(cwd: string): Promise<readonly SkillAuthoringTarget[]> {
    return this.authoring.targets(cwd)
  }

  async create(request: CreateLocalSkillRequest): Promise<void> {
    const document = await this.authoring.create(request)
    await this.editAndSettle(document, true)
  }

  async edit(cwd: string, name: string): Promise<void> {
    const document = await this.authoring.resolveEditable(cwd, name)
    if (document === undefined) {
      this.notice(`/${name} is invocable but is not an editable project or user Skill.`)
      return
    }
    await this.editAndSettle(document, false)
  }

  private async editAndSettle(document: LocalSkillDocument, created: boolean): Promise<void> {
    let editorError: unknown
    try {
      await this.editor.open(document, created)
    } catch (error: unknown) {
      editorError = error
    }

    const validation = await this.authoring.validate(document)
    const effective = await this.refreshUntilEffective(document.name)
    if (!validation.ok) {
      throw new Error(`Skill validation failed:\n${validation.errors.map(error => `- ${error}`).join('\n')}`)
    }
    if (editorError !== undefined) throw editorError
    this.notice(effective
      ? `${created ? 'Created' : 'Updated'} /${document.name}`
      : `Skill file is valid, but /${document.name} is not effective in this session (it may be shadowed by another provider).`)
  }

  private async refreshUntilEffective(name: string): Promise<boolean> {
    for (const milliseconds of [0, 250, 500]) {
      if (milliseconds > 0) await this.delay(milliseconds)
      await this.catalog.refresh(true)
      if (this.catalog.current.entries.some(entry => entry.name === name)) return true
    }
    return false
  }
}

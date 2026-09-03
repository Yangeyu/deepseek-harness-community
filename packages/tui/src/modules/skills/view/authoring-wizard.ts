import {
  type Component,
  type TUI,
} from '@earendil-works/pi-tui'
import type {
  CreateLocalSkillRequest,
  SkillAuthoringTarget,
} from '../contracts.ts'
import { ChoiceDialog, TextInputDialog } from '../../../presentation/primitives/widgets/dialogs.ts'
import type { TuiTheme } from '../../../presentation/primitives/theme.ts'

export interface SkillAuthoringSurfacePort {
  open(component: Component): { close(): boolean }
}

/** Presentation-only multi-step wizard that produces one validated request shape. */
export class SkillAuthoringWizard {
  constructor(
    private readonly tui: TUI,
    private readonly surfaces: SkillAuthoringSurfacePort,
    private readonly theme: TuiTheme,
    private readonly targets: readonly SkillAuthoringTarget[],
    private readonly nameConflict: (name: string) => string | undefined,
    private readonly onCreate: (request: CreateLocalSkillRequest) => void,
    private readonly onNotice: (message: string) => void,
  ) {}

  start(): void {
    let surface!: { close(): boolean }
    const close = (): void => { surface.close() }
    const dialog = new ChoiceDialog(
      'Create Skill',
      this.targets.map(target => ({
        value: target.scope,
        label: target.label,
        description: target.root,
      })),
      this.theme,
      (item) => {
        close()
        const target = this.targets.find(candidate => candidate.scope === item.value)
        if (target !== undefined) this.requestName(target)
      },
      close,
      'Choose whether this workflow belongs to the project or your user profile.',
    )
    surface = this.surfaces.open(dialog)
  }

  private requestName(target: SkillAuthoringTarget): void {
    this.openInput('Skill name (lowercase kebab-case)', '', (name) => {
      const normalized = name.trim().toLowerCase()
      const conflict = this.nameConflict(normalized)
      if (conflict !== undefined) {
        this.onNotice(conflict)
        return
      }
      this.requestDescription(target, normalized)
    })
  }

  private requestDescription(target: SkillAuthoringTarget, name: string): void {
    this.openInput('Skill description', '', (description) => {
      if (description.trim() === '') {
        this.onNotice('Skill description cannot be empty.')
        return
      }
      this.requestWhenToUse(target, name, description.trim())
    })
  }

  private requestWhenToUse(
    target: SkillAuthoringTarget,
    name: string,
    description: string,
  ): void {
    this.openInput('When to use (optional)', '', (whenToUse) => {
      this.requestInvocation(target, name, description, whenToUse.trim())
    })
  }

  private requestInvocation(
    target: SkillAuthoringTarget,
    name: string,
    description: string,
    whenToUse: string,
  ): void {
    let surface!: { close(): boolean }
    const close = (): void => { surface.close() }
    const create = (modelInvocable: boolean): void => {
      close()
      this.onCreate({
        target,
        name,
        description,
        ...whenToUse === '' ? {} : { whenToUse },
        modelInvocable,
        userInvocable: true,
      })
    }
    const dialog = new ChoiceDialog(
      'Skill invocation',
      [{
        value: 'model',
        label: 'User and model',
        description: 'The model may also discover and invoke this Skill.',
      }, {
        value: 'user',
        label: 'User only',
        description: 'Only an explicit /name gesture invokes this Skill.',
      }],
      this.theme,
      item => create(item.value === 'model'),
      close,
    )
    surface = this.surfaces.open(dialog)
  }

  private openInput(title: string, initial: string, onSubmit: (value: string) => void): void {
    let surface!: { close(): boolean }
    const close = (): void => { surface.close() }
    const dialog = new TextInputDialog(
      this.tui,
      title,
      this.theme,
      (value) => {
        close()
        onSubmit(value)
      },
      close,
      initial,
    )
    surface = this.surfaces.open(dialog)
  }
}

import type { ActionHandler } from './contracts.ts'

interface OwnedHandler<Action> {
  readonly owner: string
  readonly handle: ActionHandler<Action>
}

/** Statically registered semantic action ownership with duplicate-owner rejection. */
export class ActionDispatcher<Action extends string> {
  private readonly handlers = new Map<Action, OwnedHandler<Action>>()

  register(owner: string, action: Action, handle: ActionHandler<Action>): void {
    const existing = this.handlers.get(action)
    if (existing !== undefined) {
      throw new Error(`Action ${action} is already owned by ${existing.owner}; ${owner} cannot also register it.`)
    }
    this.handlers.set(action, { owner, handle })
  }

  dispatch(action: Action): boolean {
    const route = this.handlers.get(action)
    if (route === undefined) return false
    return route.handle(action) !== false
  }

  ownerOf(action: Action): string | undefined {
    return this.handlers.get(action)?.owner
  }
}

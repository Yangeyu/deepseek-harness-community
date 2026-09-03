import type { Component } from '@earendil-works/pi-tui'

/** Stable shell component whose concrete Session-owned implementation may be replaced. */
export class ComponentSlot implements Component {
  private component: Component | undefined

  get current(): Component | undefined {
    return this.component
  }

  replace(component: Component | undefined): void {
    this.component = component
  }

  handleInput(data: string): void {
    this.component?.handleInput?.(data)
  }

  invalidate(): void {
    this.component?.invalidate()
  }

  render(width: number): string[] {
    return this.component?.render(width) ?? []
  }
}

import { Text, type Focusable } from '@earendil-works/pi-tui'
import type { AuthorizationNotice } from '@deepseek-ai/dsh-authorization/types'
import type { SurfaceInputAction, SurfaceInputTarget } from '../../presentation/primitives/surface-input.ts'
import { sanitizeTerminalText } from '../../presentation/primitives/text.ts'
import type { TuiTheme } from '../../presentation/primitives/theme.ts'

/** One authorization surface preserves browser instructions alongside a withdrawing prompt. */
export class AuthorizationView implements SurfaceInputTarget, Focusable {
  prompt: SurfaceInputTarget | undefined
  private notices: AuthorizationNotice[] = []
  private hasFocus = false

  constructor(private readonly label: string, private readonly theme: TuiTheme, private readonly cancel: () => void) {}

  get inputContext() { return this.prompt?.inputContext ?? 'choice' }
  get focused() { return this.hasFocus }
  set focused(value: boolean) {
    this.hasFocus = value
    if (this.prompt !== undefined && 'focused' in this.prompt) (this.prompt as SurfaceInputTarget & Focusable).focused = value
  }

  notify(notice: AuthorizationNotice): void { this.notices.push(notice) }
  handleInput(data: string): void { this.prompt?.handleInput?.(data) }
  handleAction(action: SurfaceInputAction): void {
    if (action === 'surface.cancel' || action === 'surface.back' || action === 'surface.interrupt-or-cancel') this.cancel()
    else this.prompt?.handleAction(action)
  }
  invalidate(): void { this.prompt?.invalidate() }
  render(width: number): string[] {
    return [
      ...new Text(this.theme.bold(sanitizeTerminalText(`Sign in · ${this.label}`)), 1, 0).render(width), '',
      ...this.notices.flatMap(notice => new Text(sanitizeTerminalText([notice.message, notice.url, notice.code].filter(Boolean).join('\n')), 1, 0).render(width)),
      '', ...this.prompt?.render(width) ?? [], '', this.theme.dim('Esc cancels sign-in.'),
    ]
  }
}

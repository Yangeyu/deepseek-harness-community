import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui'
import {
  KEYMAP_PRESETS,
  keymapBindingSummaries,
  type KeymapPreset,
} from '../../input/keymap.ts'
import type { TuiTheme } from '../theme.ts'

/** Persistent keymap selector with a preview of the semantic action bindings. */
export class KeymapView implements Component {
  private index: number

  constructor(
    private current: KeymapPreset,
    private readonly theme: TuiTheme,
    private readonly onPreset: (preset: KeymapPreset) => void,
    private readonly onClose: () => void,
  ) {
    this.index = Math.max(0, KEYMAP_PRESETS.findIndex(option => option.id === current))
  }

  setPreset(preset: KeymapPreset): void {
    this.current = preset
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) return this.onClose()
    if (matchesKey(data, Key.up) || data === 'k') return this.move(-1)
    if (matchesKey(data, Key.down) || data === 'j') return this.move(1)
    if (data === 'g') this.index = 0
    else if (data === 'G') this.index = KEYMAP_PRESETS.length - 1
    else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) this.select()
  }

  invalidate(): void {}

  render(width: number): string[] {
    const selectedPreset = KEYMAP_PRESETS[this.index] ?? KEYMAP_PRESETS[0]
    const lines = [
      this.theme.bold('Keybindings'),
      this.theme.dim('TUI · Saved in the active Harness settings profile'),
      '',
    ]
    for (const [index, option] of KEYMAP_PRESETS.entries()) {
      const selected = index === this.index
      const cursor = selected ? this.theme.accent('›') : ' '
      const label = selected ? this.theme.bold(option.label) : option.label
      lines.push(`${cursor} ${label}${option.id === this.current ? this.theme.dim(' (current)') : ''}`)
      if (selected) {
        lines.push(...wrapTextWithAnsi(this.theme.dim(option.description), Math.max(1, width - 4))
          .map(line => `    ${line}`))
      }
    }
    if (selectedPreset !== undefined) {
      lines.push('', this.theme.bold(`${selectedPreset.label} bindings`))
      for (const binding of keymapBindingSummaries(selectedPreset.id)) {
        lines.push(`  ${binding.keys.join(' / ').padEnd(20)} ${binding.label}`)
      }
    }
    lines.push('', this.theme.dim('j/k move · enter apply · g/G first/last · esc close'))
    return lines.map(line => truncateToWidth(line, Math.max(1, width)))
  }

  private move(offset: number): void {
    this.index = Math.max(0, Math.min(KEYMAP_PRESETS.length - 1, this.index + offset))
  }

  private select(): void {
    const preset = KEYMAP_PRESETS[this.index]?.id
    if (preset !== undefined && preset !== this.current) this.onPreset(preset)
  }
}

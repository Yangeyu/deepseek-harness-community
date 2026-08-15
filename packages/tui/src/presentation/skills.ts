import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../text.ts'
import type { SkillCatalogSnapshot } from '../runtime/skill-catalog.ts'
import type { TuiTheme } from './theme.ts'

/** Searchable keyboard surface for effective user-invocable Skills. */
export class SkillsView implements Component {
  private index = 0
  private detail = false
  private query = ''

  constructor(
    private snapshot: Readonly<SkillCatalogSnapshot>,
    private readonly theme: TuiTheme,
    private readonly visibleRows: () => number,
    private readonly onInvoke: (name: string) => void,
    private readonly onSearch: (current: string) => void,
    private readonly onCreate: () => void,
    private readonly onEdit: (name: string) => void,
    private readonly onRefresh: () => void,
    private readonly onCancel: () => void,
  ) {}

  setSnapshot(snapshot: Readonly<SkillCatalogSnapshot>): void {
    this.snapshot = snapshot
    this.boundIndex()
  }

  setQuery(query: string): void {
    this.query = query.trim().toLowerCase()
    this.index = 0
    this.detail = false
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c')) || data === 'h') {
      if (this.detail) this.detail = false
      else this.onCancel()
      return
    }
    if (matchesKey(data, Key.up) || data === 'k') {
      this.move(-1)
      return
    }
    if (matchesKey(data, Key.down) || data === 'j') {
      this.move(1)
      return
    }
    if (data === 'g') {
      this.index = 0
      return
    }
    if (data === 'G') {
      this.index = Math.max(0, this.entries().length - 1)
      return
    }
    if (data === '/' || data === 's') {
      this.onSearch(this.query)
      return
    }
    if (data === 'n') {
      this.onCreate()
      return
    }
    if (data === 'e') {
      const selected = this.entries()[this.index]
      if (selected !== undefined) this.onEdit(selected.name)
      return
    }
    if (data === 'r') {
      this.onRefresh()
      return
    }
    if (data === 'l' || matchesKey(data, Key.right)) {
      if (this.entries()[this.index] !== undefined) this.detail = true
      return
    }
    if (matchesKey(data, Key.enter)) {
      const selected = this.entries()[this.index]
      if (selected !== undefined) this.onInvoke(selected.name)
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const selected = this.entries()[this.index]
    if (this.detail && selected !== undefined) return this.fit(this.renderDetail(width, selected), width)
    const status = this.statusLine()
    const lines = [
      this.theme.bold('Skills'),
      this.theme.dim(`Effective user-invocable workflows${this.query === '' ? '' : ` · filter: ${sanitizeTerminalText(this.query)}`}`),
      ...status === undefined ? [] : [status],
      '',
    ]
    const entries = this.entries()
    if (entries.length === 0 && this.snapshot.status === 'loading') lines.push(this.theme.accent('✦ Loading Skills…'))
    else if (entries.length === 0) lines.push(this.theme.dim(this.query === '' ? 'No Skills are available.' : 'No Skills match this filter.'))
    const maxVisible = Math.max(1, Math.floor((this.visibleRows() - 8) / 2))
    const start = Math.max(0, Math.min(entries.length - maxVisible, this.index - Math.floor(maxVisible / 2)))
    const end = Math.min(entries.length, start + maxVisible)
    if (start > 0) lines.push(this.theme.dim(`  ↑ ${start} more above`))
    for (let index = start; index < end; index += 1) {
      const entry = entries[index]
      if (entry === undefined) continue
      const cursor = index === this.index ? this.theme.accent('›') : ' '
      const label = `/${sanitizeTerminalText(entry.name)}`
      const name = index === this.index ? this.theme.bold(label) : label
      const userOnly = entry.modelInvocable ? '' : this.theme.dim(' · user only')
      lines.push(truncateToWidth(`${cursor} ${name}${userOnly}`, width))
      lines.push(truncateToWidth(`    ${this.theme.dim(sanitizeTerminalText(entry.description))}`, width))
    }
    if (end < entries.length) lines.push(this.theme.dim(`  ↓ ${entries.length - end} more below`))
    lines.push('', this.theme.dim('j/k move · enter insert · l details · / search · n new · e edit · r refresh · esc close'))
    return this.fit(lines, width)
  }

  private renderDetail(width: number, entry: SkillCatalogSnapshot['entries'][number]): string[] {
    const lines = [
      this.theme.bold(`/${sanitizeTerminalText(entry.name)}`),
      this.theme.dim(entry.modelInvocable ? 'User and model invocable' : 'User invocable only'),
      '',
      ...wrapTextWithAnsi(sanitizeTerminalText(entry.description), Math.max(1, width)),
    ]
    if (entry.whenToUse !== undefined) {
      lines.push('', this.theme.bold('When to use'), ...wrapTextWithAnsi(
        sanitizeTerminalText(entry.whenToUse),
        Math.max(1, width),
      ))
    }
    lines.push('', this.theme.dim('enter insert · h/esc back · e edit'))
    return lines
  }

  private entries(): SkillCatalogSnapshot['entries'] {
    if (this.query === '') return this.snapshot.entries
    return this.snapshot.entries.filter(entry => [entry.name, entry.description, entry.whenToUse ?? '']
      .some(value => value.toLowerCase().includes(this.query)))
  }

  private statusLine(): string | undefined {
    if (this.snapshot.status === 'stale') return this.theme.warning(`Showing cached Skills · ${this.snapshot.error ?? 'refresh failed'}`)
    if (this.snapshot.status === 'error' || this.snapshot.status === 'unavailable') {
      return this.theme.warning(`Skill catalog unavailable · ${this.snapshot.error ?? 'unsupported by this profile'}`)
    }
    if (this.snapshot.status === 'loading' && this.snapshot.entries.length > 0) return this.theme.dim('Refreshing…')
    return undefined
  }

  private move(offset: number): void {
    this.index = Math.max(0, Math.min(Math.max(0, this.entries().length - 1), this.index + offset))
  }

  private boundIndex(): void {
    this.index = Math.max(0, Math.min(Math.max(0, this.entries().length - 1), this.index))
  }

  /** pi-tui requires every custom-component row to fit the current viewport. */
  private fit(lines: readonly string[], width: number): string[] {
    const safeWidth = Math.max(1, width)
    return lines.map(line => truncateToWidth(line, safeWidth))
  }
}

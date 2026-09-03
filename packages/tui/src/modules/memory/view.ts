import { truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type {
  MemoryDocument,
  MemoryOverview,
  MemorySessionPolicy,
} from '@vascent/deepseek-harness-memory'
import { sanitizeTerminalText } from '../../presentation/primitives/text.ts'
import type { TuiTheme } from '../../presentation/primitives/theme.ts'
import type {
  SurfaceInputAction,
  SurfaceInputTarget,
} from '../../presentation/primitives/surface-input.ts'

/** Composer-anchored memory policy and Markdown document browser. */
export class MemoryDialog implements SurfaceInputTarget {
  readonly inputContext = 'memory' as const
  private index = 0
  private document: MemoryDocument | undefined
  private documentOffset = 0
  private policy: MemorySessionPolicy
  private readonly documents: MemoryDocument[]

  constructor(
    private readonly overview: MemoryOverview,
    private readonly visibleRows: () => number,
    private readonly theme: TuiTheme,
    private readonly onPolicy: (policy: MemorySessionPolicy) => void,
    private readonly onCancel: () => void,
  ) {
    this.policy = overview.policy
    const byPath = new Map<string, MemoryDocument>()
    for (const document of [overview.projectMemory, overview.global, ...overview.documents]) {
      byPath.set(document.path, document)
    }
    this.documents = [...byPath.values()]
  }

  handleAction(action: SurfaceInputAction): void {
    if (this.document !== undefined) {
      if (action === 'surface.back' || action === 'surface.cancel') {
        this.document = undefined
        this.documentOffset = 0
        return
      }
      const page = this.documentPageRows()
      if (action === 'surface.previous') this.moveDocument(-1)
      if (action === 'surface.next') this.moveDocument(1)
      if (action === 'surface.page-previous') this.moveDocument(-page)
      if (action === 'surface.page-next') this.moveDocument(page)
      return
    }
    if (action === 'surface.previous') return void (this.index = Math.max(0, this.index - 1))
    if (action === 'surface.next') return void (this.index = Math.min(this.documents.length + 1, this.index + 1))
    if (action === 'surface.confirm' || action === 'surface.toggle') {
      if (this.index === 0) {
        this.policy = { ...this.policy, useMemories: !this.policy.useMemories }
        this.onPolicy(this.policy)
        return
      }
      if (this.index === 1) {
        this.policy = { ...this.policy, generateMemories: !this.policy.generateMemories }
        this.onPolicy(this.policy)
        return
      }
      this.document = this.documents[this.index - 2]
      this.documentOffset = 0
      return
    }
    if (action === 'surface.back' || action === 'surface.cancel') this.onCancel()
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.document === undefined ? this.renderList(width) : this.renderDocument(width, this.document)
  }

  private renderList(width: number): string[] {
    const lines = [
      this.theme.bold('Memories'),
      this.theme.dim(`Project · ${this.overview.project.id}`),
      '',
      this.toggleLine(0, 'Use memories in this session', this.policy.useMemories),
      this.toggleLine(1, 'Learn from this session', this.policy.generateMemories),
      '',
    ]
    for (const [offset, document] of this.documents.entries()) {
      const index = offset + 2
      const cursor = index === this.index ? this.theme.accent('›') : ' '
      const label = document.scope === 'project'
        ? document.topic === undefined ? 'Project memory' : `Project · ${document.topic}`
        : document.topic === undefined ? 'Global memory' : `Global · ${document.topic}`
      const status = document.exists ? `${document.bytes} bytes` : 'not created'
      lines.push(truncateToWidth(
        `${cursor} ${index === this.index ? this.theme.bold(label) : label}  ${this.theme.dim(status)}`,
        width,
      ))
    }
    lines.push('', this.theme.dim('↑/↓ select · Enter toggle/open · Esc close'))
    return lines
  }

  private renderDocument(width: number, document: MemoryDocument): string[] {
    const body = document.exists && document.content.trim() !== ''
      ? sanitizeTerminalText(document.content).split('\n')
      : ['(empty memory document)']
    const page = this.documentPageRows()
    const maximum = Math.max(0, body.length - page)
    this.documentOffset = Math.max(0, Math.min(maximum, this.documentOffset))
    const visible = body.slice(this.documentOffset, this.documentOffset + page)
    const range = body.length <= page
      ? ''
      : ` · ${this.documentOffset + 1}-${Math.min(body.length, this.documentOffset + page)}/${body.length}`
    return [
      this.theme.bold(document.scope === 'project' ? 'Project memory' : 'Global memory'),
      truncateToWidth(this.theme.dim(document.path), width),
      '',
      ...visible.flatMap(line => wrapTextWithAnsi(line, width)),
      '',
      this.theme.dim(`↑/↓ scroll · PageUp/PageDown page · Esc back${range}`),
    ]
  }

  private toggleLine(index: number, label: string, enabled: boolean): string {
    const cursor = this.index === index ? this.theme.accent('›') : ' '
    const name = this.index === index ? this.theme.bold(label) : label
    return `${cursor} ${name}  ${enabled ? this.theme.success('on') : this.theme.dim('off')}`
  }

  private moveDocument(offset: number): void {
    const lines = this.document?.content.split('\n').length ?? 1
    this.documentOffset = Math.max(0, Math.min(Math.max(0, lines - this.documentPageRows()), this.documentOffset + offset))
  }

  private documentPageRows(): number {
    return Math.max(3, this.visibleRows() - 8)
  }
}

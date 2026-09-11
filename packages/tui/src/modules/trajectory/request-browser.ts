import { Input, truncateToWidth, type Component } from '@earendil-works/pi-tui'
import type { ModelRequestAvailability } from '../../runtime/execution/projection/model-call.ts'
import { LifecycleScope } from '../../runtime/lifecycle/scope.ts'
import type { SurfaceInputAction, SurfaceInputContext, SurfacePointerAction } from '../../presentation/primitives/surface-input.ts'
import { displayUnknown, sanitizeTerminalLine } from '../../presentation/primitives/text.ts'
import { TextDocument } from '../../presentation/primitives/text-document.ts'
import type { TuiTheme } from '../../presentation/primitives/theme.ts'
import type { RequestDocument, RequestField, RequestSection } from './request-document.ts'
import { RequestInspection, type RequestPreparation } from './request-inspection.ts'
import type { SearchMatch } from './request-search.ts'

type DirectoryNode = { section: RequestSection } & (
  | { kind: 'heading' }
  | { kind: 'disclosure'; key: string; text: string; indent: number; summary?: string; field?: RequestField; document?: TextDocument }
  | { kind: 'body'; field: RequestField; document?: TextDocument; indent?: number }
  | { kind: 'label'; text: string; indent?: number }
)
type DirectoryCursor = { node: number; line: number }
type EditorKind = 'search' | 'jump'

const label = (text: string): string => sanitizeTerminalLine(text.slice(0, 160))

/** Request detail interior only. Canonical reads and every query belong to RequestInspection. */
export class RequestBrowser implements Component {
  private readonly scope: LifecycleScope
  private readonly inspection: RequestInspection
  private document: RequestDocument | undefined
  private expanded = new Set<string>()
  private nodes: DirectoryNode[] = []
  private focus: number | undefined
  private top: DirectoryCursor = { node: 0, line: 0 }
  private bodyHeight = 1
  private width = 1
  private height = 1
  private jsonView: { document: TextDocument; top: number } | undefined
  private json: RequestField | undefined
  private format: 'structured' | 'json' = 'structured'
  private editor: { kind: EditorKind; input: Input } | undefined
  private editorError = ''
  private caseSensitive = false
  private selectedMatch: SearchMatch<RequestField> | undefined
  private historyScope: LifecycleScope | undefined
  private historyPages = 0
  private historyNote = ''
  private hitRows = new Map<number, number>()

  constructor(
    private readonly theme: TuiTheme,
    parent: LifecycleScope,
    private readonly onChange: () => void,
    private readonly onLoadEarlier: () => Promise<boolean>,
  ) {
    this.scope = parent.fork('request-browser')
    this.inspection = new RequestInspection(this.scope, () => this.inspectionChanged())
    this.scope.onDispose(() => {
      this.document = undefined
      this.nodes = []
      this.jsonView = undefined
      this.json = undefined
      this.editor = undefined
      this.selectedMatch = undefined
    })
  }

  get phase(): RequestPreparation['phase'] { return this.inspection.current.phase }
  get inputContext(): SurfaceInputContext { return this.editor === undefined ? 'request' : 'text-input' }

  open(availability: ModelRequestAvailability): Promise<void> {
    return this.inspection.open(availability)
  }

  private changed(): void { if (this.scope.active) this.onChange() }

  private inspectionChanged(): void {
    if (!this.scope.active) return
    const current = this.inspection.current
    if (current.phase !== 'unavailable' || current.availability.status !== 'missing-history') {
      void this.historyScope?.dispose()
      this.historyScope = undefined
    }
    if (current.phase !== 'ready') {
      this.document = undefined
      this.nodes = []
      this.jsonView = undefined
      this.json = undefined
      this.editor = undefined
      this.selectedMatch = undefined
    } else if (this.document !== current.document) {
      this.document = current.document
      this.expanded = new Set(current.document.latestInputKey === undefined ? [] : [current.document.latestInputKey])
      this.format = 'structured'
      this.jsonView = undefined
      this.json = undefined
      this.top = { node: 0, line: 0 }
      this.rebuildNodes()
      this.goSection(current.document.latestInputKey ?? current.document.sections[0]?.key)
    }
    const match = this.inspection.search.selected?.match
    if (match !== this.selectedMatch) {
      this.selectedMatch = match
      if (match !== undefined) this.revealMatch(match)
    }
    this.changed()
  }

  handleInput(raw: string): void {
    if (!this.scope.active || this.editor === undefined) return
    this.editor.input.handleInput(raw)
    this.changed()
  }

  handleAction(action: SurfaceInputAction): boolean {
    if (!this.scope.active) return false
    if (action === 'surface.back' || action === 'surface.cancel') {
      if (this.editor !== undefined) {
        this.editor = undefined
        this.clearSearch()
      } else if (this.historyScope !== undefined) {
        void this.historyScope.dispose()
        this.historyScope = undefined
        this.historyNote = 'Cancelled. The in-flight Session page remains owned by Session.'
      } else if (this.inspection.search.phase !== 'idle') {
        this.clearSearch()
      } else if (this.format === 'json') {
        this.jsonView = undefined
        this.format = 'structured'
      } else return false
      this.changed()
      return true
    }
    if (this.editor !== undefined) {
      if (action !== 'surface.confirm') return false
      this.submitEditor()
      return true
    }
    if (action === 'surface.confirm' && this.phase === 'unavailable') {
      const current = this.inspection.current
      if (current.phase !== 'unavailable' || current.availability.status !== 'missing-history') return false
      if (this.historyScope === undefined) void this.loadEarlier()
      return true
    }
    if (this.phase !== 'ready') return false
    switch (action) {
      case 'surface.search': this.edit('search'); break
      case 'surface.request-jump': this.edit('jump'); break
      case 'surface.search-case':
        this.caseSensitive = !this.caseSensitive
        this.find()
        break
      case 'surface.search-next': this.moveMatch(1); break
      case 'surface.search-previous': this.moveMatch(-1); break
      case 'surface.request-format': this.toggleFormat(); break
      case 'surface.section-next': this.moveSection(1); break
      case 'surface.section-previous': this.moveSection(-1); break
      case 'surface.previous': this.move(-1); break
      case 'surface.next': this.move(1); break
      case 'surface.detail-previous': this.scroll(-1); break
      case 'surface.detail-next': this.scroll(1); break
      case 'surface.page-previous': this.scroll(-this.bodyHeight); break
      case 'surface.page-next': this.scroll(this.bodyHeight); break
      case 'surface.half-page-previous': this.scroll(-Math.max(1, Math.floor(this.bodyHeight / 2))); break
      case 'surface.half-page-next': this.scroll(Math.max(1, Math.floor(this.bodyHeight / 2))); break
      case 'surface.confirm':
      case 'surface.toggle': this.activate(); break
      case 'surface.expand': this.disclose(true); break
      case 'surface.collapse': this.disclose(false); break
      default: return false // Outer Tabs, Session ID and Ctrl-C remain the parent's responsibility.
    }
    this.changed()
    return true
  }

  private edit(kind: EditorKind): void {
    this.editorError = ''
    const input = new Input()
    input.focused = true
    input.onSubmit = () => this.submitEditor()
    input.onEscape = () => { this.handleAction('surface.back') }
    this.editor = { kind, input }
  }

  private submitEditor(): void {
    const editor = this.editor
    if (editor === undefined) return
    const value = editor.input.getValue()
    this.editor = undefined
    if (editor.kind === 'search') this.find(value)
    else {
      const target = value.trim().toLocaleLowerCase()
      const section = target === '' || target === 'latest' ? this.document?.latestInputKey
        : target === 'checkpoint' ? this.document?.sections.findLast(item => item.category === 'checkpoint')?.key
        : this.document?.sections.find(item => item.messageIndex === Number(target.replace(/^#/u, '')) - 1)?.key
      if (section !== undefined) {
        this.jsonView = undefined
        this.format = 'structured'
        this.expanded.add(section)
        this.rebuildNodes()
        this.goSection(section)
        this.clearSearch()
      } else {
        this.editor = editor
        this.editorError = 'Jump target not found: use latest, checkpoint, or a message number.'
      }
    }
    this.changed()
  }

  private find(query = this.inspection.search.query): void {
    this.selectedMatch = undefined
    if (query === '') { this.inspection.cancelSearch(); return }
    void this.inspection.find(query, {
      caseSensitive: this.caseSensitive,
      ...(this.format === 'json' ? { fields: [this.jsonField()] } : {}),
    })
  }

  private moveMatch(direction: number): void {
    const search = this.inspection.search
    if (search.totalMatches === 0 || search.phase !== 'ready') return
    const ordinal = ((this.inspection.navigationOrdinal ?? -1) + direction + search.totalMatches) % search.totalMatches
    void this.inspection.selectMatch(ordinal)
  }

  private jsonField(): RequestField {
    if (this.json === undefined) {
      const current = this.inspection.current
      // Accepted P1 debt: explicit JSON mode synchronously serializes the COMPLETE
      // canonical Request. Never serialize on open, or substitute a truncated JSON.
      const text = current.phase === 'ready' ? displayUnknown(current.canonical.request) : ''
      this.json = { key: '$json', sectionKey: '$json', path: 'Request JSON', text }
    }
    return this.json
  }

  private toggleFormat(): void {
    this.format = this.format === 'structured' ? 'json' : 'structured'
    this.jsonView = this.format === 'json' ? { document: new TextDocument(this.jsonField().text), top: 0 } : undefined
    this.find()
  }

  private clearSearch(): void {
    this.selectedMatch = undefined
    this.inspection.cancelSearch()
  }

  private highlight(field: RequestField) {
    const match = this.selectedMatch
    return match?.field.key === field.key
      ? { start: match.start, end: match.end, paint: (text: string) => this.theme.bold(this.theme.focusRow(text)) }
      : undefined
  }

  private revealMatch(match: SearchMatch<RequestField>): void {
    if (this.jsonView !== undefined) {
      this.jsonView.top = Math.max(0, this.jsonView.document.locate(this.width, match.start) - 2)
      return
    }
    const key = match.field.sectionKey
    this.expanded.add(key)
    const location = this.document?.toolForField(match.field)
    if (location !== undefined) {
      this.expanded.add(location.tool.key)
      if (location.group !== undefined) this.expanded.add(location.group.key)
    } else if (this.document?.section(key)?.kind === 'message'
      && !this.document.body(key).some(block => block.field.key === match.field.key)) this.expanded.add(`${key}:metadata`)
    this.rebuildNodes()
    const index = this.nodes.findIndex(node => (node.kind === 'body' || node.kind === 'disclosure') && node.field?.key === match.field.key)
    const node = this.nodes[index]
    this.focus = undefined
    if (node?.kind === 'body') {
      const line = this.bodyDocument(node).locate(this.bodyWidth(node), match.start)
      this.top = this.preceding({ node: index, line }, Math.min(2, this.bodyHeight - 1))
    } else if (node?.kind === 'disclosure') {
      this.top = this.preceding({ node: index, line: 0 }, Math.min(2, this.bodyHeight - 1))
    }
  }

  private rebuildNodes(): void {
    const bodies = new Map(this.nodes.filter(node => node.kind === 'body').map(node => [node.field.key, node]))
    const nodes: DirectoryNode[] = []
    const addFields = (section: RequestSection, fields: Iterable<RequestField>, root: string, indent = 4): void => {
      for (const field of fields) {
        const path = field.path.slice(root.length).replace(/^\./u, '')
        if (path !== '') nodes.push({ kind: 'label', section, text: path, indent })
        nodes.push(bodies.get(field.key) ?? { kind: 'body', section, field, indent })
      }
    }
    for (const section of this.document?.sections ?? []) {
      nodes.push({ kind: 'heading', section })
      if (!this.expanded.has(section.key)) continue
      if (section.kind === 'tools') {
        if (this.document!.tools.length === 0) addFields(section, this.document!.sectionFields(section.key), 'tools')
        for (const tool of this.document!.tools) {
          nodes.push({ kind: 'disclosure', section, key: tool.key, text: tool.name, field: tool.nameField, summary: tool.summary, indent: 2 })
          if (!this.expanded.has(tool.key)) continue
          for (const group of tool.groups) {
            nodes.push({ kind: 'disclosure', section, key: group.key, text: group.label, indent: 4 })
            if (this.expanded.has(group.key)) addFields(section, group.fields(), group.path, 8)
          }
        }
        continue
      }
      for (const block of this.document!.body(section.key)) {
        if (block.label !== undefined) nodes.push({ kind: 'label', section, text: block.label })
        nodes.push(bodies.get(block.field.key) ?? { kind: 'body', section, field: block.field })
      }
      const metadataKey = `${section.key}:metadata`
      if (section.kind === 'message') nodes.push({ kind: 'disclosure', section, key: metadataKey, text: 'Metadata', indent: 2 })
      if (section.kind !== 'message' || this.expanded.has(metadataKey)) {
        addFields(section, this.document!.metadata(section.key), section.kind === 'message' ? `messages[${section.messageIndex}]` : '')
      }
    }
    this.nodes = nodes
  }

  private goSection(key: string | undefined): void {
    const index = this.nodes.findIndex(node => node.section.key === key && node.kind === 'heading')
    this.focus = index < 0 ? undefined : index
    if (index >= 0) this.top = { node: index, line: 0 }
  }

  private moveSection(direction: number): void {
    const section = this.nodes[this.focus ?? this.top.node]?.section.key
    this.jsonView = undefined
    if (this.format === 'json') { this.format = 'structured'; this.clearSearch() }
    const sections = this.nodes.filter(node => node.kind === 'heading')
    const index = sections.findIndex(node => node.section.key === section)
    this.goSection(sections[Math.max(0, Math.min(sections.length - 1, index + direction))]?.section.key)
  }

  private selectable(index: number): boolean {
    const kind = this.nodes[index]?.kind
    return kind === 'heading' || kind === 'disclosure'
  }

  private bodyDocument(node: Extract<DirectoryNode, { kind: 'body' }>): TextDocument {
    return node.document ??= new TextDocument(node.field.text)
  }

  private bodyWidth(node: Extract<DirectoryNode, { kind: 'body' }>, width = this.width): number {
    return Math.max(1, width - (node.indent ?? 4))
  }

  /** A cursor walks visual rows, not a flattened array of the Request's text. */
  private step(cursor: DirectoryCursor, direction: number): DirectoryCursor | undefined {
    const node = this.nodes[cursor.node]
    if (node === undefined) return undefined
    if (direction > 0) {
      if (node.kind === 'body' && this.bodyDocument(node).read(this.bodyWidth(node), cursor.line, 1).hasMore) {
        return { node: cursor.node, line: cursor.line + 1 }
      }
      return cursor.node + 1 < this.nodes.length ? { node: cursor.node + 1, line: 0 } : undefined
    }
    if (cursor.line > 0) return { node: cursor.node, line: cursor.line - 1 }
    const previous = this.nodes[cursor.node - 1]
    if (previous === undefined) return undefined
    const line = previous.kind === 'body'
      ? this.bodyDocument(previous).read(this.bodyWidth(previous), Number.MAX_SAFE_INTEGER, 1).top : 0
    return { node: cursor.node - 1, line }
  }

  private directoryWindow(): DirectoryCursor[] {
    const window: DirectoryCursor[] = []
    let cursor: DirectoryCursor | undefined = this.top
    while (cursor !== undefined && this.nodes[cursor.node] !== undefined && window.length < this.bodyHeight) {
      window.push(cursor)
      cursor = this.step(cursor, 1)
    }
    return window
  }

  private visibleFocus(): boolean {
    return this.focus !== undefined && this.selectable(this.focus)
      && this.directoryWindow().some(cursor => cursor.node === this.focus)
  }

  private move(direction: number): void {
    if (this.jsonView !== undefined) { this.scroll(direction); return }
    const window = this.directoryWindow()
    let next = this.focus === undefined
      ? direction > 0 ? this.top.node : window.at(-1)?.node ?? this.top.node
      : this.focus + direction
    while (next >= 0 && next < this.nodes.length && !this.selectable(next)) next += direction
    if (!this.selectable(next)) return
    this.focus = next
    if (window.some(cursor => cursor.node === next)) return
    this.top = this.preceding({ node: next, line: 0 }, next > this.top.node ? this.bodyHeight - 1 : 0)
  }

  /** Keep context without scanning an unread huge body merely for alignment. */
  private preceding(cursor: DirectoryCursor, rows: number): DirectoryCursor {
    for (let row = 0; row < rows; row++) {
      const previous = this.nodes[cursor.node - 1]
      if (cursor.line === 0 && previous?.kind === 'body'
        && previous.document?.read(this.bodyWidth(previous), 0, 0).totalRows === undefined) break
      const before = this.step(cursor, -1)
      if (before === undefined) break
      cursor = before
    }
    return cursor
  }

  private scroll(delta: number): void {
    if (this.jsonView !== undefined) this.jsonView.top = Math.max(0, this.jsonView.top + delta)
    else {
      for (let count = 0; count < Math.abs(delta); count++) {
        const next = this.step(this.top, Math.sign(delta))
        if (next === undefined) break
        this.top = next
      }
      if (!this.visibleFocus()) this.focus = undefined
    }
  }

  private activate(): void {
    if (this.jsonView !== undefined || !this.visibleFocus()) return
    const node = this.nodes[this.focus!]!
    this.disclose(!this.expanded.has(node.kind === 'disclosure' ? node.key : node.section.key))
  }

  private disclose(expand: boolean): void {
    if (this.jsonView !== undefined || !this.visibleFocus()) return
    const node = this.nodes[this.focus!]!
    const key = node.kind === 'disclosure' ? node.key : node.section.key
    if (expand) this.expanded.add(key)
    else this.expanded.delete(key)
    // Only descendants after the visible target change; its index and the
    // viewport's preceding nodes remain valid. Keep the reading position.
    this.rebuildNodes()
  }

  private async loadEarlier(): Promise<void> {
    const scope = this.scope.fork('history-page')
    this.historyScope = scope
    this.historyNote = `Loading page ${this.historyPages + 1}; Esc stops waiting. Session owns the in-flight page.`
    this.changed()
    try {
      const loaded = await this.onLoadEarlier()
      if (!scope.active) return
      if (loaded) this.historyPages += 1
      this.historyNote = loaded ? `Loaded ${this.historyPages} page(s). Enter loads one more if needed.` : 'No earlier page available. Request remains incomplete.'
    } catch (error: unknown) {
      if (!scope.active) return
      this.historyNote = `History load failed: ${error instanceof Error ? error.message : String(error)}. Enter retries.`
    } finally {
      if (this.historyScope === scope) {
        this.historyScope = undefined
        this.changed()
      }
      await scope.dispose()
    }
  }

  handlePointer(action: SurfacePointerAction): boolean {
    if (!this.scope.active || action.row < 0 || action.row >= this.height || action.column < 0 || action.column >= this.width) return false
    if (action.kind === 'wheel') {
      if (this.editor !== undefined) return false
      this.scroll(action.direction * 3)
      this.changed()
      return true
    }
    const index = this.hitRows.get(action.row)
    if (index === undefined) return false
    this.focus = index
    this.activate()
    this.changed()
    return true
  }

  invalidate(): void { this.editor?.input.invalidate() }

  render(width: number, height = 20): string[] {
    const columns = Math.max(0, Math.floor(width))
    if (columns !== this.width) {
      const node = this.nodes[this.top.node]
      if (node?.kind === 'body') this.top.line = this.bodyDocument(node).read(this.bodyWidth(node, columns), this.top.line, 1).top
    }
    this.width = columns
    this.height = Math.max(0, Math.floor(height))
    this.hitRows.clear()
    if (this.width === 0 || this.height === 0) return []
    const current = this.inspection.current
    let lines: string[]
    if (current.phase !== 'ready') {
      lines = current.phase === 'unavailable'
        ? current.availability.status === 'missing-history'
          ? ['Request unavailable: missing-history', `Need history from seq 0 through ${current.availability.throughSeq}; first missing ${current.availability.firstMissingSeq}.`, 'Enter: load ONE earlier page (may need many pages). Esc: cancel waiting.', 'The single in-flight page is completed by the Session owner.', label(this.historyNote)]
          : [`Request unavailable: missing-request (${current.availability.reason})`]
        : [current.phase === 'error' ? `Request preparation failed: ${label(current.message)}` : current.phase === 'preparing' ? 'Preparing canonical Request…' : 'No Request selected.']
    } else {
      const search = this.inspection.search
      const range = this.format === 'json' ? 'entire canonical JSON' : 'entire Request'
      const state = search.phase === 'searching' ? `${search.totalMatches}+ hits · scanning ${search.scannedFields} fields`
        : search.phase === 'error' ? `Search error: ${label(search.error ?? '')}`
        : search.phase === 'ready' ? `${search.selected === undefined ? 0 : search.selected.ordinal + 1}/${search.totalMatches} hits`
        : 'Search idle'
      lines = [`${this.format === 'json' ? 'JSON' : 'Structure'} · / search · n/N hits · c case · v format · g jump`, `${state} · ${this.caseSensitive ? 'case-sensitive' : 'ignore-case'} · ${range}${search.phase === 'idle' || search.query === '' ? '' : ` · “${label(search.query)}”`}`]
      // Reserve actual content/input space before spending rows on controls.
      lines = lines.slice(0, Math.max(0, this.height - (this.editor !== undefined ? 2 : this.jsonView !== undefined ? 3 : 1)))
      const searchInput = this.editor?.kind === 'search'
        ? [...this.editor.input.render(Math.max(1, this.width - 2)).map(line => `/ ${line}`), 'Enter search · Esc cancel'] : undefined
      if (this.editor?.kind === 'jump') this.renderEditor(lines)
      else if (this.jsonView !== undefined) this.renderJson(lines, searchInput)
      else this.renderDirectory(lines, searchInput)
    }
    return lines.slice(0, this.height).map(line => truncateToWidth(line, this.width, '…'))
  }

  private renderEditor(lines: string[]): void {
    const editor = this.editor!
    const hints = ['latest — newest human input', 'checkpoint — latest canonical checkpoint', '1, 2, … — original message number; Enter jumps']
    if (lines.length < this.height - 1) lines.push(`${editor.kind}>`)
    lines.push(...editor.input.render(this.width))
    if (this.editorError !== '') hints.unshift(this.editorError)
    lines.push(...hints.slice(0, Math.max(0, this.height - lines.length)))
  }

  private renderDirectory(lines: string[], footer?: string[]): void {
    this.bodyHeight = Math.max(1, this.height - lines.length - (footer?.length ?? 1))
    const window = this.directoryWindow()
    if (!this.visibleFocus()) this.focus = undefined
    for (const cursor of window) {
      const node = this.nodes[cursor.node]!
      const selected = cursor.node === this.focus
      const prefix = selected ? '› ' : '  '
      let text: string
      switch (node.kind) {
        case 'heading': {
          const expanded = this.expanded.has(node.section.key)
          const summary = !expanded && node.section.summary ? ` · ${label(node.section.summary)}` : ''
          text = `${prefix}${expanded ? '▾' : '▸'} ${label(node.section.label)}${summary}`
          break
        }
        case 'disclosure': {
          const expanded = this.expanded.has(node.key)
          const summary = !expanded && node.summary ? ` · ${label(node.summary)}` : ''
          let title = label(node.text)
          if (node.field !== undefined && this.highlight(node.field) !== undefined) {
            const document = node.document ??= new TextDocument(node.field.text)
            const width = Math.max(1, this.width - node.indent - 4)
            title = document.read(width, document.locate(width, this.selectedMatch!.start), 1, this.highlight(node.field)).lines[0] ?? title
          }
          text = `${prefix}${' '.repeat(node.indent)}${expanded ? '▾' : '▸'} ${title}${summary}`
          break
        }
        case 'label': text = `${' '.repeat(node.indent ?? 4)}${label(node.text)}`; break
        case 'body': text = `${' '.repeat(node.indent ?? 4)}${this.bodyDocument(node).read(this.bodyWidth(node), cursor.line, 1, this.highlight(node.field)).lines[0] ?? ''}`; break
      }
      if (this.selectable(cursor.node)) this.hitRows.set(lines.length, cursor.node)
      lines.push(selected ? this.theme.focusRow(text) : text)
    }
    lines.push(...footer ?? [`j/k select · J/K scroll · [ ] sections · Enter fold · Esc ${this.inspection.search.phase === 'idle' ? 'parent' : 'clear search'}`])
  }

  private renderJson(lines: string[], footer?: string[]): void {
    const view = this.jsonView!
    this.bodyHeight = Math.max(1, this.height - lines.length - (footer?.length ?? 1))
    const page = view.document.read(this.width, view.top, this.bodyHeight, this.highlight(this.jsonField()))
    view.top = page.top
    lines.push(...page.lines)
    lines.push(...footer ?? [`Lines ${page.top + 1}–${page.top + page.lines.length}/${page.totalRows ?? '?'}${page.hasMore ? ' · more text not yet laid out' : ' · end'} · Esc clear search / directory`])
  }

  /** Leaving this Tab retires transient work, not the current canonical reading anchor. */
  suspend(): void {
    if (!this.scope.active) return
    this.editor = undefined
    void this.historyScope?.dispose()
    this.historyScope = undefined
    this.historyNote = ''
    this.inspection.suspend()
    this.changed()
  }

  dispose(): Promise<void> { return this.scope.dispose() }
}

import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../../text.ts'
import {
  taskRows,
  type TaskSnapshot,
} from '../../runtime/session-controls.ts'
import type { TuiTheme } from '../theme.ts'

export type GoalAction = 'create' | 'edit' | 'rounds' | 'pause' | 'resume' | 'complete' | 'clear'
export type RuntimeAction = 'cancel'

interface ActionRow<T extends string> {
  value: T
  label: string
  description?: string
  dangerous?: boolean
}

type Stage = 'root' | 'goal' | 'todos' | 'runtime' | 'goal-confirm'

/** Keyboard-first task lifecycle and progress surface. */
export class TaskView implements Component {
  private stage: Stage = 'root'
  private index = 0
  private pendingGoalAction: GoalAction | undefined

  constructor(
    private snapshot: TaskSnapshot,
    private readonly theme: TuiTheme,
    private readonly visibleRows: () => number,
    private readonly onGoal: (action: GoalAction) => void,
    private readonly onRuntime: (action: RuntimeAction) => void,
    private readonly onClose: () => void,
  ) {}

  setSnapshot(snapshot: TaskSnapshot): void {
    this.snapshot = snapshot
    this.index = Math.min(this.index, Math.max(0, this.rowCount() - 1))
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      if (this.stage === 'root') this.onClose()
      else if (this.stage === 'goal-confirm') {
        this.stage = 'goal'
        this.pendingGoalAction = undefined
      } else {
        this.stage = 'root'
        this.index = 0
      }
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
      this.index = Math.max(0, this.rowCount() - 1)
      return
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) this.select()
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines = this.stage === 'goal-confirm' ? this.renderGoalConfirmation(width)
      : this.stage === 'todos' ? this.renderTodos(width)
        : this.stage === 'root' ? this.renderRoot(width)
          : this.renderActions(width)
    const safeWidth = Math.max(1, width)
    return lines.map(line => truncateToWidth(line, safeWidth))
  }

  private renderRoot(width: number): string[] {
    const lines = [
      this.theme.bold('Task'),
      this.theme.dim('Current objective, execution progress, and runtime'),
      '',
    ]
    for (const [index, row] of taskRows(this.snapshot).entries()) {
      const cursor = index === this.index ? this.theme.accent('›') : ' '
      const label = index === this.index ? this.theme.bold(row.label.padEnd(12)) : row.label.padEnd(12)
      const value = row.available ? sanitizeTerminalText(row.value) : this.theme.dim(sanitizeTerminalText(row.value))
      lines.push(truncateToWidth(`${cursor} ${label}${value}${this.theme.dim(`  ${row.scope}`)}`, width))
    }
    lines.push('', this.theme.dim('j/k move · enter inspect · g/G first/last · esc close'))
    return lines
  }

  private renderActions(width: number): string[] {
    const title = this.stage === 'goal' ? 'Goal' : 'Runtime'
    const actions = this.actions()
    const lines = [this.theme.bold(title), this.theme.dim(this.stageDetail()), '']
    if (actions.length === 0) lines.push(this.theme.dim('No actions are currently available.'))
    for (const [index, action] of actions.entries()) {
      const cursor = index === this.index ? this.theme.accent('›') : ' '
      const label = index === this.index ? this.theme.bold(action.label) : action.label
      lines.push(truncateToWidth(`${cursor} ${label}`, width))
      if (action.description !== undefined && index === this.index) {
        lines.push(...wrapTextWithAnsi(
          this.theme.dim(sanitizeTerminalText(action.description)),
          Math.max(1, width - 4),
        ).map(line => `    ${line}`))
      }
    }
    lines.push('', this.theme.dim('j/k move · enter apply · esc back'))
    return lines
  }

  private renderGoalConfirmation(width: number): string[] {
    return [
      this.theme.bold(this.theme.warning('Clear durable Goal?')),
      '',
      ...wrapTextWithAnsi(
        sanitizeTerminalText(this.snapshot.goal?.goal.objective ?? 'The current Goal changed.'),
        Math.max(1, width),
      ),
      '',
      this.theme.warning('The Goal is removed from the current task; its durable history remains.'),
      this.theme.dim('enter confirm · esc cancel'),
    ]
  }

  private renderTodos(width: number): string[] {
    const todos = this.snapshot.todos ?? []
    const lines = [this.theme.bold('Tasks'), this.theme.dim('Read-only Host execution checklist'), '']
    if (todos.length === 0) lines.push(this.theme.dim('No tasks are currently available.'))
    const maxVisible = Math.max(1, this.visibleRows() - 7)
    const start = Math.max(0, Math.min(todos.length - maxVisible, this.index - Math.floor(maxVisible / 2)))
    const end = Math.min(todos.length, start + maxVisible)
    if (start > 0) lines.push(this.theme.dim(`  ↑ ${start} more above`))
    for (let index = start; index < end; index += 1) {
      const todo = todos[index]
      if (todo === undefined) continue
      const cursor = index === this.index ? this.theme.accent('›') : ' '
      const marker = todo.status === 'completed'
        ? this.theme.success('✓')
        : todo.status === 'in_progress' ? this.theme.accent('◆') : this.theme.dim('○')
      const content = sanitizeTerminalText(todo.content)
      lines.push(truncateToWidth(`${cursor} ${marker} ${index === this.index ? this.theme.bold(content) : content}`, width))
    }
    if (end < todos.length) lines.push(this.theme.dim(`  ↓ ${todos.length - end} more below`))
    lines.push('', this.theme.dim('j/k move · g/G first/last · esc back'))
    return lines
  }

  private select(): void {
    if (this.stage === 'goal-confirm') {
      const action = this.pendingGoalAction
      this.pendingGoalAction = undefined
      this.stage = 'goal'
      this.index = 0
      if (action !== undefined) this.onGoal(action)
      return
    }
    if (this.stage === 'root') {
      const row = taskRows(this.snapshot)[this.index]
      if (row === undefined || !row.available) return
      this.stage = row.kind
      this.index = 0
      return
    }
    if (this.stage === 'todos') return
    const action = this.actions()[this.index]
    if (action === undefined) return
    if (this.stage === 'runtime') {
      this.onRuntime(action.value as RuntimeAction)
      return
    }
    if (action.dangerous) {
      this.pendingGoalAction = action.value as GoalAction
      this.stage = 'goal-confirm'
      return
    }
    this.onGoal(action.value as GoalAction)
  }

  private move(offset: number): void {
    this.index = Math.max(0, Math.min(Math.max(0, this.rowCount() - 1), this.index + offset))
  }

  private rowCount(): number {
    if (this.stage === 'root') return taskRows(this.snapshot).length
    if (this.stage === 'todos') return this.snapshot.todos?.length ?? 0
    if (this.stage === 'goal-confirm') return 1
    return this.actions().length
  }

  private actions(): readonly ActionRow<string>[] {
    if (this.stage === 'runtime') {
      return this.snapshot.running
        ? [{ value: 'cancel', label: 'Cancel current turn', description: 'Stop the active turn and preserve queued work.' }]
        : []
    }
    if (this.stage !== 'goal') return []
    const phase = this.snapshot.goal?.goal.phase
    if (this.snapshot.goal === null) return [{ value: 'create', label: 'Create goal' }]
    if (phase === 'active') return [
      { value: 'edit', label: 'Edit objective' },
      { value: 'rounds', label: 'Edit round limit' },
      { value: 'pause', label: 'Pause' },
      { value: 'complete', label: 'Complete' },
      { value: 'clear', label: 'Clear', dangerous: true },
    ]
    if (phase === 'paused' || phase === 'blocked') return [
      { value: 'edit', label: 'Edit objective' },
      { value: 'rounds', label: 'Edit round limit' },
      { value: 'resume', label: 'Resume' },
      { value: 'complete', label: 'Complete' },
      { value: 'clear', label: 'Clear', dangerous: true },
    ]
    if (phase === 'complete') return [{ value: 'clear', label: 'Clear', dangerous: true }]
    return []
  }

  private stageDetail(): string {
    if (this.stage === 'runtime') {
      return `Session · ${this.snapshot.running ? 'running' : 'idle'} · ${this.snapshot.queued} queued`
    }
    const goal = this.snapshot.goal
    if (goal === null) return 'Session · No durable goal'
    if (goal === undefined) return 'Session · Unavailable'
    return sanitizeTerminalText(`Session · ${goal.goal.phase} · ${goal.goal.objective}`)
  }
}

import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import { TaskView } from '../../../src/presentation/task/task-view.ts'
import { createTheme } from '../../../src/presentation/theme.ts'

function snapshot() {
  return {
    goal: null,
    todos: [
      { content: 'Design', status: 'completed' as const },
      { content: 'Implement', status: 'in_progress' as const },
    ],
    running: false,
    queued: 0,
  }
}

describe('TaskView', () => {
  it('keeps Goal, Tasks, and Runtime separate from configuration', () => {
    const task = new TaskView(snapshot(), createTheme(false), () => 24, vi.fn(), vi.fn(), vi.fn())

    const rendered = task.render(80).join('\n')
    expect(rendered).toContain('› Goal')
    expect(rendered).toContain('Tasks')
    expect(rendered).toContain('Runtime')
    expect(rendered).not.toContain('Permission')
    task.handleInput('j')
    expect(task.render(80).join('\n')).toContain('› Tasks')
    task.handleInput('G')
    expect(task.render(80).join('\n')).toContain('› Runtime')
  })

  it('keeps Todos read-only while allowing list inspection', () => {
    const goal = vi.fn()
    const task = new TaskView(snapshot(), createTheme(false), () => 24, goal, vi.fn(), vi.fn())

    task.handleInput('j')
    task.handleInput('\r')
    expect(task.render(80).join('\n')).toContain('◆ Implement')
    task.handleInput('\r')
    expect(goal).not.toHaveBeenCalled()
  })

  it('windows long Todo lists around vim tail selection', () => {
    const state = {
      ...snapshot(),
      todos: Array.from({ length: 20 }, (_, index) => ({
        content: `Task ${index}`,
        status: 'pending' as const,
      })),
    }
    const task = new TaskView(state, createTheme(false), () => 12, vi.fn(), vi.fn(), vi.fn())

    task.handleInput('j')
    task.handleInput('\r')
    task.handleInput('G')
    const rendered = task.render(80).join('\n')
    expect(rendered).toContain('› ○ Task 19')
    expect(rendered).toContain('more above')
    expect(rendered.split('\n').length).toBeLessThanOrEqual(12)
  })

  it('confirms destructive Goal clearing and returns one level on Escape', () => {
    const goal = vi.fn()
    const state = {
      ...snapshot(),
      goal: {
        goal: {
          id: 'goal' as never,
          revision: 1,
          objective: 'Ship safely',
          phase: 'complete' as const,
          maxGoalRounds: 8,
        },
        roundsStarted: 3,
        createdAt: 1,
        updatedAt: 2,
      },
    }
    const task = new TaskView(state, createTheme(false), () => 24, goal, vi.fn(), vi.fn())

    task.handleInput('\r')
    task.handleInput('\r')
    expect(task.render(80).join('\n')).toContain('Clear durable Goal?')
    task.handleInput('\u001b')
    expect(task.render(80).join('\n')).toContain('complete · Ship safely')
    expect(goal).not.toHaveBeenCalled()
  })

  it('offers cancellation only while the runtime is active', () => {
    const runtime = vi.fn()
    const task = new TaskView({ ...snapshot(), running: true }, createTheme(false), () => 24, vi.fn(), runtime, vi.fn())

    task.handleInput('G')
    task.handleInput('\r')
    expect(task.render(80).join('\n')).toContain('Cancel current turn')
    task.handleInput('\r')
    expect(runtime).toHaveBeenCalledWith('cancel')
  })

  it('bounds every rendered row in narrow terminals', () => {
    const task = new TaskView(snapshot(), createTheme(false), () => 16, vi.fn(), vi.fn(), vi.fn())

    expect(task.render(32).every(line => visibleWidth(line) <= 32)).toBe(true)
    task.handleInput('\r')
    expect(task.render(32).every(line => visibleWidth(line) <= 32)).toBe(true)
  })
})

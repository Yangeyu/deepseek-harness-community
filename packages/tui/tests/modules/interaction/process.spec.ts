import type { Component, TUI } from '@earendil-works/pi-tui'
import { describe, expect, it, vi } from 'vitest'
import {
  InteractionProcess,
  type InteractionPort,
} from '../../../src/modules/interaction/process.ts'
import { createTheme } from '../../../src/presentation/primitives/theme.ts'
import type { ApprovalPrompt } from '../../../src/runtime/session/interactions.ts'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'
import { isSurfaceInputTarget, type SurfaceInputAction } from '../../../src/presentation/primitives/surface-input.ts'

function act(component: Component | undefined, action: SurfaceInputAction): void {
  const target = component ?? null
  if (!isSurfaceInputTarget(target)) throw new Error('expected semantic Surface input target')
  target.handleAction(action)
}

function approval(id: string): ApprovalPrompt {
  return {
    sessionId: 'session-1' as ApprovalPrompt['sessionId'],
    requestId: id,
    toolName: 'shell',
  }
}

function fixture(overrides: Partial<InteractionPort> = {}) {
  let current: Component | undefined
  const opened: Component[] = []
  const port: InteractionPort = {
    answerApproval: vi.fn(async () => {}),
    answerQuestions: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    notice: vi.fn(),
    ...overrides,
  }
  const scope = new LifecycleScope('interaction')
  const process = new InteractionProcess(
    port,
    {
      open(component) {
        let active = true
        current = component
        opened.push(component)
        return {
          close: () => {
            if (!active) return false
            active = false
            if (current === component) current = undefined
            return true
          },
        }
      },
    },
    {} as TUI,
    createTheme(false),
    () => 24,
    vi.fn(),
    scope,
  )
  return {
    process,
    port,
    scope,
    opened,
    current: () => current,
  }
}

describe('InteractionProcess', () => {
  it('deduplicates requests and advances them in FIFO order', async () => {
    const { process, port, current, opened } = fixture()
    const first = approval('first')
    const second = approval('second')

    process.requestApproval(first)
    process.requestApproval(first)
    process.requestApproval(second)
    expect(process.activeKey).toContain('first')
    expect(opened).toHaveLength(1)

    act(current(), 'surface.confirm')
    await vi.waitFor(() => { expect(process.activeKey).toContain('second') })
    expect(port.answerApproval).toHaveBeenCalledWith(first, 'allowed-once')
    expect(opened).toHaveLength(2)
  })

  it('returns a failed response to the open phase without losing the request', async () => {
    const { process, port, current } = fixture({
      answerApproval: vi.fn(async () => { throw new Error('response rejected') }),
    })
    process.requestApproval(approval('failure'))

    act(current(), 'surface.confirm')

    await vi.waitFor(() => { expect(port.notice).toHaveBeenCalledWith('response rejected') })
    expect(process.active).toBe(true)
    expect(current()).toBeDefined()
  })

  it('cancels the active turn without fabricating an interaction answer', async () => {
    const { process, port } = fixture()
    process.requestApproval(approval('cancel'))

    expect(process.cancel()).toBe(true)

    await vi.waitFor(() => { expect(process.active).toBe(false) })
    expect(port.cancel).toHaveBeenCalledOnce()
    expect(port.answerApproval).not.toHaveBeenCalled()
  })

  it('retires queued interaction state when the owning Session scope closes', async () => {
    const { process, port, current, scope } = fixture()
    process.requestApproval(approval('old-session'))
    expect(current()).toBeDefined()

    await scope.dispose()

    expect(process.active).toBe(false)
    expect(current()).toBeUndefined()
    expect(port.cancel).not.toHaveBeenCalled()
    expect(port.answerApproval).not.toHaveBeenCalled()
  })
})

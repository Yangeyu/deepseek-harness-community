import { describe, expect, it, vi } from 'vitest'
import { RenderScheduler, type ScheduleRenderFrame } from '../../src/runtime/render-scheduler.ts'

function controlledFrame() {
  let pending: (() => void) | undefined
  const schedule: ScheduleRenderFrame = vi.fn((render) => {
    pending = render
    return () => { pending = undefined }
  })
  return {
    schedule,
    run: () => {
      const render = pending
      pending = undefined
      render?.()
    },
  }
}

describe('RenderScheduler', () => {
  it('coalesces invalidations until the next frame', () => {
    const frame = controlledFrame()
    const render = vi.fn()
    const scheduler = new RenderScheduler(render, frame.schedule)

    scheduler.invalidate()
    scheduler.invalidate()
    scheduler.invalidate()

    expect(frame.schedule).toHaveBeenCalledOnce()
    expect(render).not.toHaveBeenCalled()
    frame.run()
    expect(render).toHaveBeenCalledOnce()
  })

  it('allows a render to schedule a following frame', () => {
    const frame = controlledFrame()
    let scheduler!: RenderScheduler
    const render = vi.fn(() => { scheduler.invalidate() })
    scheduler = new RenderScheduler(render, frame.schedule)

    scheduler.invalidate()
    frame.run()
    frame.run()

    expect(render).toHaveBeenCalledTimes(2)
  })

  it('cancels a pending frame when disposed', () => {
    const frame = controlledFrame()
    const render = vi.fn()
    const scheduler = new RenderScheduler(render, frame.schedule)

    scheduler.invalidate()
    scheduler.dispose()
    frame.run()

    expect(render).not.toHaveBeenCalled()
  })
})

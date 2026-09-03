import { describe, expect, it, vi } from 'vitest'
import { ActionDispatcher } from '../../../src/runtime/dispatch/dispatcher.ts'

describe('ActionDispatcher', () => {
  it('routes one semantic action to its explicit owner', () => {
    const dispatcher = new ActionDispatcher<'composer.submit' | 'session.cancel'>()
    const submit = vi.fn()
    dispatcher.register('composer', 'composer.submit', submit)

    expect(dispatcher.ownerOf('composer.submit')).toBe('composer')
    expect(dispatcher.dispatch('composer.submit')).toBe(true)
    expect(dispatcher.dispatch('session.cancel')).toBe(false)
    expect(submit).toHaveBeenCalledWith('composer.submit')
  })

  it('rejects duplicate action ownership during static composition', () => {
    const dispatcher = new ActionDispatcher<'surface.close'>()
    dispatcher.register('surface-host', 'surface.close', () => {})

    expect(() => {
      dispatcher.register('feature', 'surface.close', () => {})
    }).toThrow('already owned by surface-host')
  })
})

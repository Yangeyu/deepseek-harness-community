import { describe, expect, it, vi } from 'vitest'
import { memoryKeymapGateway } from '../../src/application/keymap-settings.ts'

describe('keymap settings gateway', () => {
  it('publishes semantic changes and ignores an unchanged preset', async () => {
    const gateway = memoryKeymapGateway({ keymap: 'standard' })
    const listener = vi.fn()
    const unsubscribe = gateway.subscribe(listener)

    await gateway.setPreset('standard')
    await gateway.setPreset('legacy')
    unsubscribe()
    await gateway.setPreset('standard')

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ keymap: 'legacy' })
    expect(gateway.current()).toEqual({ keymap: 'standard' })
  })
})

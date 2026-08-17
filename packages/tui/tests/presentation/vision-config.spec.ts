import { describe, expect, it, vi } from 'vitest'
import { createTheme } from '../../src/presentation/theme.ts'
import { VisionConfigView } from '../../src/presentation/config/vision-view.ts'

const status = {
  config: {
    mode: 'auto' as const,
    proxyProvider: 'bailian',
    proxyModel: 'qwen3.7-plus',
    maxObservationChars: 12_000,
    maxTokens: 2_048,
  },
  proxyRegistered: true,
  proxySupportsImages: true,
}

describe('VisionConfigView', () => {
  it('renders the provider-neutral proxy route and capability', () => {
    const view = new VisionConfigView(status, createTheme(false), vi.fn(), vi.fn())
    const output = view.render(100).join('\n')

    expect(output).toContain('bailian/qwen3.7-plus')
    expect(output).toContain('multimodal')
    expect(output).toContain('Auto (current)')
  })

  it('supports j/k navigation and applies the selected mode', () => {
    const onMode = vi.fn()
    const view = new VisionConfigView(status, createTheme(false), onMode, vi.fn())

    view.handleInput('j')
    view.handleInput('\r')

    expect(onMode).toHaveBeenCalledWith('proxy')
  })

})

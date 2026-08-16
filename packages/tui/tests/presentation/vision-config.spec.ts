import { describe, expect, it, vi } from 'vitest'
import { createTheme } from '../../src/presentation/theme.ts'
import { VisionConfigView } from '../../src/presentation/config/vision-view.ts'

const status = {
  config: {
    mode: 'auto' as const,
    proxyProvider: 'dashscope-vision',
    proxyModel: 'qwen3.7-plus',
    maxObservationChars: 12_000,
    maxTokens: 2_048,
  },
  proxyRegistered: true,
  proxySupportsImages: true,
  credentialRef: 'DASHSCOPE_API_KEY',
  credentialConfigured: true,
}

describe('VisionConfigView', () => {
  it('renders route and credential status without exposing a secret', () => {
    const view = new VisionConfigView(status, createTheme(false), vi.fn(), vi.fn(), vi.fn())
    const output = view.render(100).join('\n')

    expect(output).toContain('dashscope-vision/qwen3.7-plus')
    expect(output).toContain('DASHSCOPE_API_KEY configured')
    expect(output).toContain('Auto (current)')
  })

  it('supports j/k navigation and applies the selected mode', () => {
    const onMode = vi.fn()
    const view = new VisionConfigView(status, createTheme(false), onMode, vi.fn(), vi.fn())

    view.handleInput('j')
    view.handleInput('\r')

    expect(onMode).toHaveBeenCalledWith('proxy')
  })

  it('confirms before writing the recommended provider profile', () => {
    const onConfigure = vi.fn()
    const view = new VisionConfigView(status, createTheme(false), vi.fn(), onConfigure, vi.fn())
    view.handleInput('G')
    view.handleInput('\r')

    expect(view.render(80).join('\n')).toContain('Configure recommended DashScope route?')
    expect(onConfigure).not.toHaveBeenCalled()
    view.handleInput('\r')
    expect(onConfigure).toHaveBeenCalledOnce()
  })
})

import type { JsonValue, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import {
  createWebExtractTool,
  WEB_EXTRACT_TIMEOUT_MS,
  WEB_EXTRACT_TOOL_NAME,
} from '../src/tool.ts'

function runContext(): ToolRunContext {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name: WEB_EXTRACT_TOOL_NAME,
    arguments: {},
    signal: new AbortController().signal,
    token: Symbol('tool'),
    deferContext: vi.fn(),
    concludeTurn: vi.fn(),
  } as unknown as ToolRunContext
}

describe('web_extract', () => {
  it('owns one vendor-neutral URL schema and forwards cancellation', async () => {
    const extract = vi.fn(async () => ({
      url: 'https://example.com/article',
      content: '# Article',
      truncated: false,
    }))
    const tool = createWebExtractTool({ extract })
    const exec = runContext()

    await expect(tool.execute({ url: ' https://example.com/article ' }, exec)).resolves.toEqual({
      url: 'https://example.com/article',
      content: '# Article',
      truncated: false,
    })
    expect(tool.name).toBe(WEB_EXTRACT_TOOL_NAME)
    expect(tool.timeoutMs).toBe(WEB_EXTRACT_TIMEOUT_MS)
    expect(extract).toHaveBeenCalledWith({ url: 'https://example.com/article' }, exec.signal)
  })

  it('renders bounded extraction state and a truncation notice', () => {
    const tool = createWebExtractTool({ extract: vi.fn() })
    const value = {
      url: 'https://example.com/article',
      content: '# Article\n\nReadable content.',
      truncated: true,
    }

    expect(tool.output.render({}, value as JsonValue)).toEqual([{
      type: 'text',
      text: expect.stringMatching(/^Extracted https:\/\/example\.com\/article\n\n# Article/u),
    }])
    expect(tool.output.render({}, value as JsonValue)[0]).toMatchObject({
      text: expect.stringContaining('Content truncated'),
    })
  })

  it('rejects blank URLs before invoking the capability', async () => {
    const extract = vi.fn()
    const tool = createWebExtractTool({ extract })

    await expect(tool.execute({ url: '   ' }, runContext())).rejects.toThrow('non-empty string')
    expect(extract).not.toHaveBeenCalled()
  })
})

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('Bailian profile', () => {
  it('mounts an explicit provider endpoint and served model catalog', async () => {
    const profile = await readFile(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
    expect(profile).toContain("name: '@vascent/deepseek-harness-tui/bailian'")
    expect(profile).toContain('baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect(profile).toContain('id: deepseek-v4-pro-0813')
    expect(profile).toContain('id: qwen3.7-plus')
    expect(profile).toContain('maxTokens: 393216')
    expect(profile).toContain('maxTokens: 131072')
    expect(profile).toContain('efforts:')
    expect(profile).not.toContain('apiKeyEnv: DASHSCOPE_API_KEY')
    expect(profile).not.toContain('preset:')
    expect(profile).not.toContain('defaultMaxTokens:')
    expect(profile).not.toContain('mode: reasoning-effort')
    expect(profile).not.toContain('mode: qwen-thinking')
  })
})

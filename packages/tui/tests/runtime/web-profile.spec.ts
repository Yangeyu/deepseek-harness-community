import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('community Web profile', () => {
  it('selects the stable policy router while retaining the official tools', async () => {
    const profile = await readFile(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
    expect(profile).toContain('searchProvider: community-web')
    expect(profile).toContain('searchProvider: auto')
    expect(profile).toContain('extractProvider: community-tavily')
    expect(profile).toContain("name: '@vascent/deepseek-harness-tui/web'")
    expect(profile).toContain('tavilyApiKeyEnv: TAVILY_API_KEY')
    expect(profile).toContain('tavilySearchDepth: basic')
    expect(profile).toMatch(/- id: tool-web[\s\S]*?fetch: false/u)
  })
})

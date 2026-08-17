import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('community Web profile', () => {
  it('selects community providers while retaining the official tools', async () => {
    const profile = await readFile(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
    expect(profile).toContain('searchProvider: community-brave')
    expect(profile).toContain('extractProvider: community-tavily')
    expect(profile).toContain("name: '@vascent/deepseek-harness-tui/web'")
    expect(profile).toContain('braveApiKeyEnv: BRAVE_API_KEY')
    expect(profile).toContain('tavilyApiKeyEnv: TAVILY_API_KEY')
    expect(profile).toMatch(/- id: tool-web[\s\S]*?fetch: false/u)
  })
})

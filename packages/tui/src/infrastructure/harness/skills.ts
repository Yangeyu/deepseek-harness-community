import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy'
import type { SkillCatalogSource } from '../../modules/skills/contracts.ts'

/** ApiProxy adapter for the Skills feature's consumer-owned catalog port. */
export function harnessSkillCatalogSource(api: IApiClient): SkillCatalogSource {
  return {
    async list(sessionId, signal) {
      if (signal.aborted) return []
      const response = await api.skills.list({ sessionId })
      if (!response.result.ok) throw new Error(response.result.error.message)
      return signal.aborted ? [] : response.result.value.skills
    },
  }
}

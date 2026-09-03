import type { SessionSkillCatalog } from '@deepseek-ai/dsh-api-session-controller'
import type { SkillCatalogSource } from '../../modules/skills/contracts.ts'

/** Session Controller adapter for the Skills feature's consumer-owned catalog port. */
export function harnessSkillCatalogSource(
  catalog: Pick<SessionSkillCatalog, 'list'>,
): SkillCatalogSource {
  return {
    async list(sessionId, signal) {
      if (signal.aborted) return []
      const response = await catalog.list({ sessionId }, signal)
      return signal.aborted ? [] : response.skills
    },
  }
}

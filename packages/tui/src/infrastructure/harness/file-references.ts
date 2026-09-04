import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { FileReferenceService } from '@deepseek-ai/dsh-file-reference'
import type { FileReferenceSource } from '../../modules/composer/autocomplete.ts'
import type { SessionId } from '../../runtime/session/contracts.ts'

/** Resolve a terminal Session to its Agent before entering the Host file-reference service. */
export class HarnessFileReferenceSource implements FileReferenceSource {
  constructor(
    private readonly controller: Pick<SessionController, 'resolveAgent'>,
    private readonly references: Pick<FileReferenceService, 'list'>,
  ) {}

  async list(sessionId: SessionId, query: string, signal: AbortSignal) {
    const result = await this.controller.resolveAgent(sessionId)
    if ('error' in result) throw new Error(result.error.message)
    return this.references.list(result.agent, query, signal)
  }
}

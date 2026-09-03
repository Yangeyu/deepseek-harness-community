import type { ModelCatalog, ModelSelection } from '../../runtime/session/contracts.ts'
import type { ModelPort } from '../../modules/configuration/contracts.ts'
import type { SessionEffectScopeSource } from '../../runtime/session/effect-scope.ts'
import type { SessionTransport } from '../../runtime/session/transport.ts'

/** Harness adapter that commits model results only into the captured Session epoch. */
export class HarnessModelPort implements ModelPort {
  constructor(
    private readonly transport: Pick<SessionTransport, 'modelCatalog' | 'selectModel'>,
    private readonly sessions: SessionEffectScopeSource,
  ) {}

  async refresh(): Promise<ModelCatalog> {
    const scope = this.sessions.captureSession()
    const catalog = await this.transport.modelCatalog()
    scope.commitModelCatalog(catalog)
    return catalog
  }

  async select(selection: ModelSelection): Promise<void> {
    const scope = this.sessions.captureSession()
    await this.transport.selectModel(scope.sessionId, selection)
  }
}

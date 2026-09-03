import type { IApiClient, ModelSelection, SessionModels } from '@deepseek-ai/dsh-host-apiproxy'
import type { ModelPort } from '../../modules/configuration/contracts.ts'
import type { SessionEffectScopeSource } from '../../runtime/session/effect-scope.ts'
import { harnessValue } from './result.ts'

/** Harness adapter that commits model results only into the captured Session epoch. */
export class HarnessModelPort implements ModelPort {
  constructor(
    private readonly api: IApiClient,
    private readonly sessions: SessionEffectScopeSource,
  ) {}

  async refresh(): Promise<SessionModels> {
    const scope = this.sessions.captureSession()
    const models = harnessValue(await this.api.sessions.models({ sessionId: scope.sessionId }))
    scope.commitModels(models)
    return models
  }

  async select(selection: ModelSelection): Promise<void> {
    const scope = this.sessions.captureSession()
    const selected = harnessValue(await this.api.sessions.selectModel({
      sessionId: scope.sessionId,
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    })).selected
    scope.commitModelSelection(selected)
  }
}

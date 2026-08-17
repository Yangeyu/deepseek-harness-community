import {
  LlmError,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
} from '@deepseek-ai/dsh-llm'
import type {
  BailianReasoningEffort,
  ResolvedBailianModel,
  ResolvedBailianReasoningLevel,
} from './config.ts'

function effortName(effort: string): string {
  return `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`
}

export function modelInfo(provider: string, model: ResolvedBailianModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: [...model.input],
  }
}

export function resolvedModelInfo(provider: string, model: ResolvedBailianModel): LlmResolvedModelInfo {
  return {
    ...modelInfo(provider, model),
    context: { contextWindow: model.contextWindow },
    ...model.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: model.defaultMaxTokens },
    ...model.reasoning === false
      ? {}
      : {
          reasoning: {
            efforts: [...model.reasoning.efforts.keys()].map(effort => ({
              id: ReasoningEffortId(effort),
              name: effortName(effort),
            })),
            defaultEffort: ReasoningEffortId(model.reasoning.defaultEffort),
          },
        },
  }
}

export function resolveReasoningLevel(
  model: ResolvedBailianModel,
  requested: GenerateOptions['reasoningEffort'],
  purpose: GenerateOptions['purpose'],
): ResolvedBailianReasoningLevel | undefined {
  if (model.reasoning === false) {
    if (requested !== undefined) {
      throw new LlmError(`Bailian model "${model.id}" does not support reasoning`, 'UNSUPPORTED_REASONING_EFFORT')
    }
    return undefined
  }
  const effort = purpose === 'session-title' && model.reasoning.efforts.has('off')
    ? 'off'
    : String(requested ?? model.reasoning.defaultEffort) as BailianReasoningEffort
  const level = model.reasoning.efforts.get(effort)
  if (level === undefined) {
    throw new LlmError(
      `Bailian model "${model.id}" does not support reasoning effort "${effort}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  return level
}

export function resolveMaxTokens(model: ResolvedBailianModel, requested: number | undefined): number | undefined {
  const value = requested ?? model.defaultMaxTokens
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LlmError('Bailian maxTokens must be a positive safe integer', 'INVALID_REQUEST')
  }
  if (value > model.maxOutputTokens) {
    throw new LlmError(
      `Bailian maxTokens ${String(value)} exceeds model "${model.id}" output capacity ${String(model.maxOutputTokens)}`,
      'INVALID_REQUEST',
    )
  }
  return value
}

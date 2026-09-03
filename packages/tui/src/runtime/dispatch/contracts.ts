export interface EffectContext {
  readonly signal: AbortSignal
}

export type ScopedEffect<Result = void> = (context: EffectContext) => Promise<Result>

export type ActionHandler<Action> = (action: Action) => boolean | void

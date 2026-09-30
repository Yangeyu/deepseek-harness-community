import { afterEach, describe, expect, it } from 'vitest'
import { Context, resolveConfig } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as Bailian from '../src/index.ts'
import type { BailianModelConfig } from '../src/config.ts'

const cleanups: Array<() => Promise<void>> = []

function model(name?: string): BailianModelConfig {
  return {
    ...name === undefined ? {} : { name },
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    maxTokensField: 'max_tokens',
    input: ['text'],
    reasoning: {
      defaultEffort: 'high',
      efforts: {
        off: { enableThinking: false },
        high: { enableThinking: true, reasoningEffort: 'high' },
      },
    },
  }
}

async function boot() {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Loader)
  ctx.loader.builtins.bailian = Bailian
  const initial = { baseURL: 'http://127.0.0.1:1', models: { base: model('Composition Base') } }
  const id = await ctx.loader.create({ name: 'cordis:bailian', config: initial })
  const entry = ctx.loader.resolve(id)
  const fiber = entry.fiber!
  await fiber.await()
  const update = async (patch: Record<string, unknown>) => {
    const next = { ...initial, ...patch, models: { ...initial.models, ...patch.models as object } }
    resolveConfig(fiber.runtime!, fiber.ctx.waterfall(fiber, 'internal/config', next, () => next))
    await entry.update({ config: next })
    await entry.fiber!.await()
  }
  return { ctx, entry, fiber, update }
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

describe('Bailian live plugin configuration', () => {
  it('applies model additions and retry policy changes without restarting the Provider', async () => {
    const { ctx, entry, fiber, update } = await boot()
    const observed: string[][] = []
    ctx.on('llm/adapters-updated', () => {
      observed.push(ctx.llm.listProviders().map(provider => provider.id))
    })

    await update({
      models: { added: model('Settings Model') },
      retryPolicy: {
        mode: 'always',
        backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 },
      },
    })

    await expect(ctx.llm.listModels('bailian')).resolves.toEqual([
      {
        provider: 'bailian',
        id: 'base',
        name: 'Composition Base',
        inputModalities: ['text'],
      },
      {
        provider: 'bailian',
        id: 'added',
        name: 'Settings Model',
        inputModalities: ['text'],
      },
    ])
    expect(ctx.llm.providerRetryPolicy('bailian')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
    expect(observed).toEqual([['bailian']])
    expect(entry.fiber === fiber).toBe(true)
  })

  it('rejects a resolver-invalid update atomically and keeps the last-good snapshot', async () => {
    const { ctx, update } = await boot()

    await expect(update({
      baseURL: 'https://rejected.example.invalid/v1',
      models: {
        duplicate: model(),
        ' duplicate ': model(),
      },
    })).rejects.toThrow('duplicate model id "duplicate" after trimming')

    await expect(ctx.llm.listModels('bailian')).resolves.toEqual([{
      provider: 'bailian',
      id: 'base',
      name: 'Composition Base',
      inputModalities: ['text'],
    }])
  })

})

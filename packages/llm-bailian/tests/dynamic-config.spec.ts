import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as Bailian from '../src/index.ts'
import type { BailianModelConfig } from '../src/config.ts'

const NS = settingsNamespace('llm-bailian')
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

async function boot(): Promise<Context> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bailian-settings-'))
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(directory, 'settings.yaml'), watch: false })
  await ctx.plugin(Bailian, {
    baseURL: 'http://127.0.0.1:1',
    models: { base: model('Composition Base') },
  })
  return ctx
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

describe('Bailian dynamic settings', () => {
  it('applies model additions and retry policy changes without restarting the Provider', async () => {
    const ctx = await boot()
    const observed: string[][] = []
    ctx.on('llm/adapters-updated', () => {
      observed.push(ctx.llm.listProviders().map(provider => provider.id))
    })

    await ctx.settings.update(NS, {
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
  })

  it('rejects a resolver-invalid update atomically and keeps the last-good snapshot', async () => {
    const ctx = await boot()

    await expect(ctx.settings.update(NS, {
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

import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage, type GenerateOptions, type LlmCallConfig, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it } from 'vitest'
import { HarnessSessionTransport } from '../../../src/infrastructure/harness/session-transport.ts'
import { HostRewindFork } from '../../../src/modules/rewind/adapters/fork.ts'

// Resolve the installed loop through its declared owner, not a pnpm store path or a user profile.
const require = createRequire(import.meta.url)
const baseRequire = createRequire(require.resolve('@deepseek-ai/dsh-base/package.json'))
const { AgentLoop } = await import(pathToFileURL(baseRequire.resolve('@deepseek-ai/dsh-agent-loop')).href) as {
  AgentLoop: new (ctx: Context, config: { agents: [] }) => unknown
}

const { default: JsonlSessionPersistence } = await import(pathToFileURL(baseRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href) as {
  default: new (ctx: Context, config: { root: string }) => SessionPersistence
}
const agentRequire = createRequire(require.resolve('@deepseek-ai/dsh-agent'))
const { scopeOf } = await import(pathToFileURL(agentRequire.resolve('@deepseek-ai/dsh-scope')).href) as {
  scopeOf: (ctx: Context) => Agent
}

function transportFor(ctx: Context, controller: SessionController) {
  return new HarnessSessionTransport({
    cwd: '/workspace', controller,
    forkSession: request => new HostRewindFork(ctx).fork(request),
    tools: { get: () => undefined }, toolScope: () => undefined as never,
    onStatus: () => () => {}, onError: () => () => {},
  })
}

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function fixture(root?: string) {
  const ctx = new Context()
  if (root !== undefined) new JsonlSessionPersistence(ctx, { root })
  const requests: GenerateOptions[] = []
  const configs: LlmCallConfig[] = []
  const errors: unknown[] = []
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  // Only non-execution host capabilities are stubs. Forking, replay, queue mutation,
  // model request assembly and the pump all run their real upstream implementations.
  ctx.provide('tools', { get: () => undefined } as never)
  ctx.provide('llm', {
    listProviders: () => [{ id: 'fixture' }],
    resolveCallConfig: async (config: LlmCallConfig) => config,
    prepareCall: async (config: LlmCallConfig) => ({
      config,
      async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(request)
        configs.push(config)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'done' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }),
  } as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'no-network' }), saveSelection: async () => {},
  } as never)
  ctx.provide('typert', { lookups: { configure() {} }, contexts: { configureHost() {} } } as never)
  ctx.provide('fileUploads', {
    registerAgentResolver: () => () => {}, retirePrompt() {},
    bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }),
  } as never)
  ctx.provide('attachments', {
    admitPromptContent: async (content: unknown) => content,
    imageLimits: {
      maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1,
      maxImagePixels: 1, maxImageDimension: 1, mediaTypes: ['image/png'],
    },
  } as never)
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  ctx.provide('sessionQuery', {
    async observeSession(id: SessionId) {
      const session = ctx.sessions.get(id)!
      return {
        header: session.header, events: session.snapshotEvents(),
        projections: ctx.sessionProjections.snapshot(session), [Symbol.dispose]() {},
      }
    },
  } as never)
  new AgentLoop(ctx, { agents: [] })
  const controller = new SessionController(ctx, { nativeOpen: false })
  const source = (await ctx.agents.create({
    sessionId: SessionId('source'), agentOptions: { provider: 'fixture', model: 'no-network' },
  })).agent
  source.followup(message('HISTORY'))
  await source.whenIdle()
  expect(errors).toEqual([])
  const boundary = source.session.snapshotEvents().findLast(event => event.type === 'turn/end')!
  requests.length = 0
  configs.length = 0
  return { ctx, source, boundary, requests, configs, errors, controller, transport: transportFor(ctx, controller) }
}

async function queue(controller: SessionController, id: SessionId) {
  const abort = new AbortController()
  const iterator = controller.control(abort.signal)[Symbol.asyncIterator]()
  try {
    const frame = await iterator.next()
    if (frame.done || frame.value.type !== 'baseline') throw new Error('expected control baseline')
    return frame.value.value.queues[id]!
  } finally {
    abort.abort()
    await iterator.return?.()
  }
}

function userTexts(request: GenerateOptions) {
  return request.messages.filter(entry => entry.role === 'user')
    .flatMap(entry => entry.content.flatMap(block => block.type === 'text' ? [block.text] : []))
}

function observeCreation(ctx: Context) {
  const seen: { kind: string; id: SessionId; inbox: unknown }[] = []
  const record = (kind: string, session: Session) => seen.push({
    kind, id: session.id,
    inbox: structuredClone(ctx.sessionProjections.stateOf(session, 'inbox')),
  })
  ctx.on('session/created', session => { record('session', session) })
  ctx.on('agent/created', ({ agent }) => { record('agent', agent.session) })
  return seen
}

function preset(ctx: Context, mount: (agent: Agent) => void) {
  ctx.provide('agentPresets', {
    resolve: async () => ({ id: 'fixture-preset' }),
    mount: async (agentCtx: Context) => { mount(scopeOf(agentCtx)) },
  } as never)
}

async function prompt(host: Awaited<ReturnType<typeof fixture>>, sessionId: SessionId, text: string) {
  await host.transport.prompt({
    sessionId, requestId: text as never, content: [{ type: 'text', text }], mode: 'queue',
  }, new AbortController().signal)
  await host.ctx.agents.get(sessionId)!.whenIdle()
}

const emptyInbox = { 'next-turn': [], 'next-step': [] }

describe('rewind fork inbox isolation', () => {
  it('publishes a clean inbox to both observers and reopens its full disk log without altering the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rewind-'))
    const reader = new Context()
    let host: Awaited<ReturnType<typeof fixture>> | undefined
    try {
      host = await fixture(root)
      host.source.inbox.splice('next-turn', 0, 0, [message('QUEUED')])
      host.source.inbox.splice('next-step', 0, 0, [message('STEERING'), createUserMessage({
        content: [{ type: 'text', text: 'CONTEXT' }], source: { kind: 'plugin', plugin: 'fixture' },
      })])
      const sourceEvents = host.source.session.snapshotEvents()
      const sourceQueue = await queue(host.controller, host.source.id)
      expect(sourceQueue.map(item => item.placement)).toEqual(['queued', 'steering', 'context'])

      const seen = observeCreation(host.ctx)
      const child = await host.transport.forkSession({ sessionId: host.source.id, atSeq: host.boundary.seq })

      expect(seen).toEqual(['session', 'agent'].map(kind => ({ kind, id: child.sessionId, inbox: emptyInbox })))
      expect(await queue(host.controller, child.sessionId)).toEqual([])
      const childSession = host.ctx.sessions.get(child.sessionId)!
      expect(childSession.snapshotEvents().slice(0, sourceEvents.length)).toEqual(sourceEvents)
      expect(await queue(host.controller, host.source.id)).toEqual(sourceQueue)
      expect(host.source.session.snapshotEvents()).toEqual(sourceEvents)
      expect(host.requests).toEqual([])
      await host.ctx.fiber.dispose()

      // A fresh backend and projection owner cannot reuse the live branch or a cached fold.
      const storage = new JsonlSessionPersistence(reader, { root })
      new AgentRegistry(reader)
      new SessionStore(reader)
      new SessionProjectionRegistry(reader)
      new SystemPrompt(reader, { includeHarnessIdentity: false, includeRuntimeContext: false })
      new AgentLoop(reader, { agents: [] })
      await reader.agents.create({ sessionId: SessionId('projection-reader') })
      await using handle = await storage.open(child.sessionId, 'read')
      const loaded = await handle.read()
      const restored = Session.fromRestore(
        handle.id, loaded.events, handle.header, handle.inheritedEventCount, loaded.eventState,
      )
      expect(loaded.events.slice(0, sourceEvents.length)).toEqual(sourceEvents)
      expect(reader.sessionProjections.stateOf(restored, 'inbox')).toEqual(emptyInbox)
    } finally {
      await host?.ctx.fiber.dispose()
      await reader.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves fresh preset context after clearing inherited work', async () => {
    const host = await fixture()
    try {
      host.source.inbox.splice('next-turn', 0, 0, [message('OLD')])
      const fresh = createUserMessage({
        content: [{ type: 'text', text: 'FRESH' }], source: { kind: 'plugin', plugin: 'fixture' },
      })
      preset(host.ctx, agent => { agent.inject(fresh) })
      const seen = observeCreation(host.ctx)
      const child = await host.transport.forkSession({ sessionId: host.source.id, atSeq: host.boundary.seq })
      expect(seen.map(item => item.inbox)).toEqual([0, 1].map(() => ({ 'next-turn': [], 'next-step': [fresh] })))
      await prompt(host, child.sessionId, 'NEW')
      expect(host.requests.map(userTexts)).toEqual([['HISTORY', 'FRESH', 'NEW']])
      expect(host.errors).toEqual([])
    } finally {
      await host.ctx.fiber.dispose()
    }
  })

  it('rolls back failed preset mount without publishing either identity', async () => {
    const host = await fixture()
    try {
      host.source.inbox.splice('next-turn', 0, 0, [message('OLD')])
      const failure = new Error('preset mount failed')
      let unpublished: Agent | undefined
      preset(host.ctx, agent => { unpublished = agent; throw failure })
      const seen = observeCreation(host.ctx)
      const sourceEvents = host.source.session.snapshotEvents()
      await expect(host.transport.forkSession({ sessionId: host.source.id, atSeq: host.boundary.seq })).rejects.toBe(failure)
      expect(unpublished).toBeDefined()
      expect(seen).toEqual([])
      expect(host.ctx.agents.get(unpublished!.id)).toBeUndefined()
      expect(host.ctx.sessions.get(unpublished!.id)).toBeUndefined()
      expect(host.source.session.snapshotEvents()).toEqual(sourceEvents)
      expect(host.requests).toEqual([])
    } finally {
      await host.ctx.fiber.dispose()
    }
  })

  it('honors inherited pending selection on first Controller prompt and later switches exactly once', async () => {
    const host = await fixture()
    try {
      host.source.session.append('model/selection', { provider: 'fixture', model: 'pending' })
      const child = await host.transport.forkSession({ sessionId: host.source.id, atSeq: host.boundary.seq })
      await prompt(host, child.sessionId, 'FIRST')
      await host.transport.selectModel(child.sessionId, { provider: 'fixture', model: 'later' })
      await prompt(host, child.sessionId, 'SECOND')
      await prompt(host, child.sessionId, 'THIRD')
      expect(host.configs.map(config => config.model)).toEqual(['pending', 'later', 'later'])
      const switches = host.ctx.sessions.get(child.sessionId)!.snapshotEvents()
        .filter(event => event.type === 'user/message' && event.data.source.kind === 'plugin'
          && event.data.source.plugin === 'model-selection')
      expect(switches).toHaveLength(2)
      expect(host.errors).toEqual([])
    } finally {
      await host.ctx.fiber.dispose()
    }
  })

  it('refuses a delegated source before creating a branch', async () => {
    const host = await fixture()
    try {
      const delegated = (await host.ctx.agents.create({
        sessionId: SessionId('delegated'), meta: { origin: 'subagent', parentSession: host.source.id },
        seed: host.source.session.snapshotEvents(), agentOptions: { provider: 'fixture', model: 'no-network' },
      })).agent
      const seen = observeCreation(host.ctx)
      await expect(host.transport.forkSession({ sessionId: delegated.id, atSeq: host.boundary.seq }))
        .rejects.toThrow('ordinary session')
      expect(seen).toEqual([])
      expect(host.requests).toEqual([])
    } finally {
      await host.ctx.fiber.dispose()
    }
  })

  it('executes only NEW after rewinding a source with historical between-turn work', async () => {
    const host = await fixture()
    try {
      const old = message('OLD')
      host.source.inbox.splice('next-turn', 0, 0, [old])
      const enqueue = host.source.session.snapshotEvents().at(-1)!
      expect(enqueue.type).toBe('agent/inbox/spliced')
      expect(enqueue.seq).toBe(host.boundary.seq + 1)
      const child = await host.transport.forkSession({ sessionId: host.source.id, atSeq: host.boundary.seq })
      await prompt(host, child.sessionId, 'NEW')

      expect(host.errors).toEqual([])
      expect(host.requests.map(userTexts)).toEqual([['HISTORY', 'NEW']])
      expect(await queue(host.controller, child.sessionId)).toEqual([])
      expect(host.source.inbox.nextTurn).toEqual([old])
    } finally {
      await host.ctx.fiber.dispose()
    }
  })
})

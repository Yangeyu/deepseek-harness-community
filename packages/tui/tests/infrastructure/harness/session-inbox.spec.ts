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
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { VisionService } from '@vascent/deepseek-harness-vision'
import { harnessImageInput } from '../../../src/infrastructure/harness/image-input.ts'
import { AttachmentCoordinator, type PreparedPromptSender } from '../../../src/modules/composer/attachments/coordinator.ts'
import { AttachmentDraftStore } from '../../../src/modules/composer/attachments/drafts.ts'
import { promptTextFromContent } from '../../../src/runtime/execution/prompt-text.ts'
import { promptImagesFromContent, visionEvidenceFromContent } from '../../../src/runtime/session/input.ts'
import { preparePromptDraft } from '../../../src/modules/rewind/application/prompt-draft.ts'
import { TranscriptModel } from '../../../src/modules/transcript/model.ts'
import { LifecycleScope } from '../../../src/runtime/lifecycle/scope.ts'
import { SessionRuntime } from '../../../src/runtime/session/runtime.ts'

// Resolve the installed loop through its declared owner, not a pnpm store path or a user profile.
const require = createRequire(import.meta.url)
const baseRequire = createRequire(require.resolve('@deepseek-ai/dsh-base/package.json'))
const { AgentLoop } = await import(pathToFileURL(baseRequire.resolve('@deepseek-ai/dsh-agent-loop')).href) as {
  AgentLoop: new (ctx: Context, config: { agents: [] }) => unknown
}

const { default: JsonlSessionPersistence } = await import(pathToFileURL(baseRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href) as {
  default: new (ctx: Context, config: { root: string }) => SessionPersistence
}
const { default: LocalAttachmentStore } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-attachment-local')).href) as {
  default: new (ctx: Context, config: { dshHome: string }) => AttachmentStore
}
const agentRequire = createRequire(require.resolve('@deepseek-ai/dsh-agent'))
const { scopeOf } = await import(pathToFileURL(agentRequire.resolve('@deepseek-ai/dsh-scope')).href) as {
  scopeOf: (ctx: Context) => Agent
}

function transportFor(ctx: Context, controller: SessionController) {
  return new HarnessSessionTransport({
    cwd: '/workspace', controller,
    forkSession: request => new HostRewindFork(ctx).fork(request),
    tools: { get: () => undefined }, agentFor: sessionId => ctx.agents.get(sessionId),
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
  const proxyRequests: GenerateOptions[] = []
  type Gate = { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> }
  let streamGate: Gate | undefined
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  new AgentRegistry(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false })
  // Only non-execution host capabilities are stubs. Forking, replay, queue mutation,
  // model request assembly and the pump all run their real upstream implementations.
  ctx.provide('tools', { get: () => undefined, register() {} } as never)
  ctx.provide('llm', {
    listProviders: () => [{ id: 'fixture' }],
    resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model, inputModalities: ['text', 'image'] }),
    async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      proxyRequests.push(request)
      const text = '[Image #1] shows the old layout; [Image #2] shows the new layout.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    resolveCallConfig: async (config: LlmCallConfig) => config,
    prepareCall: async (config: LlmCallConfig) => ({
      config,
      async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
        requests.push(request)
        configs.push(config)
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'done' }
        const gate = streamGate
        streamGate = undefined
        if (gate !== undefined) {
          gate.entered.resolve()
          await gate.release.promise
        }
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
  if (root !== undefined) new LocalAttachmentStore(ctx, { dshHome: root })
  else ctx.provide('attachments', {
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
        source: 'live', header: session.header, events: session.snapshotEvents(),
        cursor: session.seq - 1, inheritedEventCount: session.inheritedEventCount,
        projections: ctx.sessionProjections.snapshot(session), [Symbol.dispose]() {},
      }
    },
  } as never)
  new AgentLoop(ctx, { agents: [] })
  const controller = new SessionController(ctx, { nativeOpen: false })
  const source = (await ctx.agents.create({
    sessionId: SessionId('source'), meta: { cwd: '/workspace' }, agentOptions: { provider: 'fixture', model: 'no-network' },
  })).agent
  source.followup(message('HISTORY'))
  await source.whenIdle()
  expect(errors).toEqual([])
  const boundary = source.session.snapshotEvents().findLast(event => event.type === 'turn/end')!
  requests.length = 0
  configs.length = 0
  return {
    ctx, source, boundary, requests, configs, errors, proxyRequests, controller, transport: transportFor(ctx, controller),
    pauseNextStream() {
      const gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
      streamGate = gate
      return gate
    },
  }
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

describe('follow-owned prompt presentation', () => {
  it('keeps one complete prompt through a real claim paused before user/message', async () => {
    const host = await fixture()
    const scope = new LifecycleScope('host-prompt-handoff')
    const runtime = new SessionRuntime(scope, host.source.id, 1, '/workspace', { events: 'online', control: 'online' })
    const follow = host.transport.follow(host.source.id, 50, scope.signal)[Symbol.asyncIterator]()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const stop = host.ctx.on('agent/pre-step', async (_payload, next) => {
      entered.resolve()
      await release.promise
      return next()
    })
    const model = new TranscriptModel(true, 100)
    const publications: { prompts: { key: string; body: string }[]; queued: boolean }[] = []
    let unsubscribe = () => {}
    try {
      const opening = await follow.next()
      if (opening.done || opening.value.type !== 'snapshot') throw new Error('expected follow snapshot')
      expect(opening.value.page.projections?.values.inbox).toEqual(emptyInbox)
      runtime.hydrate(opening.value.page, opening.value.cursor, opening.value.assistantStream)
      unsubscribe = runtime.subscribe(snapshot => {
        publications.push({
          prompts: model.project(snapshot, false).items.filter(item => item.kind === 'prompt')
            .map(item => ({ key: item.key, body: item.body })),
          queued: snapshot.queue.length > 0,
        })
      })
      const text = `Full prompt before the claim gate: ${'retain every word '.repeat(30)}END`
      const submission = runtime.startSubmission(text, 'queue')!
      const key = `prompt:${submission.requestId}`
      await host.transport.prompt({
        sessionId: host.source.id, requestId: submission.requestId,
        content: [{ type: 'text', text }], mode: 'queue',
      }, scope.signal)
      await entered.promise

      const advance = async () => {
        const frame = await follow.next()
        if (frame.done || frame.value.type === 'snapshot') throw new Error('expected live follow frame')
        if (frame.value.type === 'event') expect(runtime.appendEvent(frame.value.entry)).toBe('appended')
        else runtime.acceptAssistantFrame(frame.value.frame)
      }
      while (!runtime.current.pendingSubmissions.some(item => item.requestId === submission.requestId && item.messageId !== undefined)) {
        await advance()
      }
      expect(runtime.current.queue).toEqual([])
      expect(runtime.current.pendingSubmissions).toEqual([expect.objectContaining({ requestId: submission.requestId, text })])
      expect(host.source.session.snapshotEvents().some(event => event.type === 'user/message'
        && event.data.source.kind === 'user' && 'rpcId' in event.data.source
        && event.data.source.rpcId === submission.requestId)).toBe(false)
      expect(publications.some(publication => publication.queued)).toBe(true)

      release.resolve()
      while (runtime.current.pendingSubmissions.length > 0) await advance()
      expect(runtime.current.events.at(-1)?.event.type).toBe('user/message')
      for (const publication of publications) {
        expect(publication.prompts.filter(item => item.key === key || item.body === text)).toEqual([{ key, body: text }])
      }
      await host.source.whenIdle()
      expect(host.errors).toEqual([])
    } finally {
      unsubscribe()
      stop()
      release.resolve()
      await scope.dispose()
      await follow.return?.()
      await host.ctx.fiber.dispose()
    }
  })

  it('seeds existing inbox rows from the follow cut without replaying historical insertions', async () => {
    const host = await fixture()
    const scope = new LifecycleScope('host-inbox-baseline')
    const runtime = new SessionRuntime(scope, host.source.id, 1, '/workspace', { events: 'online', control: 'online' })
    const existing = message('ALREADY QUEUED')
    host.source.inbox.splice('next-turn', 0, 0, [existing])
    const follow = host.transport.follow(host.source.id, 50, scope.signal)[Symbol.asyncIterator]()
    try {
      const opening = await follow.next()
      if (opening.done || opening.value.type !== 'snapshot') throw new Error('expected follow snapshot')
      expect(opening.value.page.projections?.values.inbox?.['next-turn']).toEqual([existing])
      runtime.hydrate(opening.value.page, opening.value.cursor, opening.value.assistantStream)
      expect(runtime.current.queue.map(item => item.id)).toEqual([existing.id])

      const later = message('ADMITTED AFTER THE CUT')
      host.source.inbox.splice('next-turn', 1, 0, [later])
      const update = await follow.next()
      if (update.done || update.value.type !== 'event') throw new Error('expected live inbox event')
      expect(runtime.appendEvent(update.value.entry)).toBe('appended')
      expect(runtime.current.queue.map(item => item.id)).toEqual([existing.id, later.id])
    } finally {
      await scope.dispose()
      await follow.return?.()
      await host.ctx.fiber.dispose()
    }
  })
})

describe('TUI interrupt', () => {
  it.each([true, false])('resubmits pending steering after cancellation (steering: %s)', async (withSteering) => {
    const host = await fixture()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const stop = host.ctx.on('agent/request', async (_payload, next) => {
      entered.resolve(undefined)
      await release.promise
      return next()
    })
    try {
      host.source.followup(message('INTERRUPTED'))
      await entered.promise
      stop()
      const context = createUserMessage({
        content: [{ type: 'text', text: 'CONTEXT' }], source: { kind: 'plugin', plugin: 'fixture' },
      })
      const first = message('FIRST')
      const second = message('SECOND')
      if (withSteering) host.source.steer(first)
      host.source.inject(context)
      if (withSteering) host.source.steer(second)

      await host.transport.cancel(host.source.id)
      release.resolve(undefined)
      await host.source.whenIdle()

      expect(host.requests.map(userTexts)).toEqual(withSteering ? [['HISTORY', 'CONTEXT', 'FIRST', '\n\n', 'SECOND']] : [])
      const admitted = host.source.session.snapshotEvents()
        .filter(event => event.seq > host.boundary.seq && event.type === 'user/message')
        .map(event => event.data)
      if (withSteering) {
        expect(admitted).toEqual([context, expect.objectContaining({
          content: [...first.content, { type: 'text', text: '\n\n' }, ...second.content], source: expect.objectContaining({ kind: 'user' }),
        })])
        expect(host.source.inbox.nextStep).toEqual([])
      } else {
        expect(admitted).toEqual([])
        expect(host.source.inbox.nextStep).toEqual([context])
      }
      expect(host.errors).toEqual([])
    } finally {
      stop()
      release.resolve(undefined)
      await host.ctx.fiber.dispose()
    }
  })
})

describe('complete image input', () => {
  it('continues merged native and proxy steering after a streaming interrupt and replays every image occurrence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-image-input-'))
    const reader = new Context()
    const host = await fixture(root)
    const gate = host.pauseNextStream()
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    try {
      host.source.followup(message('ORIGINAL'))
      await gate.entered.promise
      await host.transport.prompt({
        sessionId: host.source.id, requestId: 'queued' as never,
        content: [{ type: 'text', text: 'QUEUED' }], mode: 'queue',
      }, new AbortController().signal)

      await host.transport.prompt({
        sessionId: host.source.id, requestId: 'earlier' as never,
        content: [{ type: 'text', text: 'Earlier [Image #1] was incorrect.' }], mode: 'steer',
      }, new AbortController().signal)
      const nativeDrafts = new AttachmentDraftStore()
      nativeDrafts.complete(nativeDrafts.reserve(), { mediaType: 'image/png', name: 'native.png', data: png, source: 'file' })
      const submit = (requestId: string): PreparedPromptSender => async (_text, mode, prepare) => {
        const prepared = await prepare({ setActivity() {} })
        await host.transport.prompt({ sessionId: host.source.id, requestId: requestId as never, mode, content: prepared.content }, new AbortController().signal)
      }
      await new AttachmentCoordinator(nativeDrafts, harnessImageInput(host.ctx.llm)).submit(
        { provider: 'fixture', model: 'no-network' }, 'native [Image #1] details', 'steer', submit('native'),
      )
      const native = host.source.inbox.nextStep[1]!.content.find(block => block.type === 'image')!

      const config = { mode: 'proxy' as const, proxyProvider: 'fixture', proxyModel: 'vision', maxObservationChars: 12000, maxTokens: 2048 }
      host.ctx.provide('settings', { register: () => ({ get: () => config }) } as never)
      const vision = new VisionService(host.ctx, config)
      const proxyDrafts = new AttachmentDraftStore()
      for (const name of ['before.png', 'after.png']) {
        proxyDrafts.complete(proxyDrafts.reserve(), { mediaType: 'image/png', name, data: png, source: 'file' })
      }
      await new AttachmentCoordinator(proxyDrafts, harnessImageInput(host.ctx.llm, vision)).submit(
        { provider: 'fixture', model: 'no-network' }, 'before [Image #1] after [Image #2]', 'steer', submit('proxy'),
      )
      expect(host.proxyRequests).toHaveLength(1)
      await host.transport.cancel(host.source.id)
      gate.release.resolve()
      await host.source.whenIdle()

      expect(host.errors).toEqual([])
      expect(host.requests).toHaveLength(3)
      expect(userTexts(host.requests[1]!)).toContain('QUEUED')
      const event = host.source.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user')!
      if (event.type !== 'user/message') throw new Error('expected continued input')
      const content = event.data.content
      expect(promptTextFromContent(content)).toBe('Earlier [Image #1] was incorrect.\n\nnative [Image #2] details\n\nbefore [Image #3] after [Image #4]')
      expect(content.find(block => block.type === 'image')).toEqual(native)
      const [evidence] = visionEvidenceFromContent(content)
      expect(evidence).toMatchObject({
        references: ['[Image #3]', '[Image #4]'],
        observation: '[Image #3] shows the old layout; [Image #4] shows the new layout.',
      })
      expect(host.proxyRequests).toHaveLength(1)
      expect(host.requests[2]!.messages.findLast(message => message.source.kind === 'user')?.content).toEqual(content)
      expect(await queue(host.controller, host.source.id)).toEqual([])
      await host.ctx.fiber.dispose()

      const storage = new JsonlSessionPersistence(reader, { root })
      const attachments = new LocalAttachmentStore(reader, { dshHome: root })
      await using handle = await storage.open(host.source.id, 'read')
      const loaded = await handle.read()
      const replay = loaded.events.findLast(event => event.type === 'user/message')!
      if (replay.type !== 'user/message') throw new Error('expected replayed input')
      expect(replay.data.content).toEqual(content)
      const restored = await preparePromptDraft({
        text: promptTextFromContent(replay.data.content),
        attachments: promptImagesFromContent(replay.data.content),
      }, attachments)
      expect(restored.text).toBe('Earlier [Image #1] was incorrect.\n\nnative [Image #2] details\n\nbefore [Image #3] after [Image #4]')
      expect(restored.attachments.map(image => image.placeholder)).toEqual(['[Image #2]', '[Image #3]', '[Image #4]'])
      expect(restored.attachments.map(image => image.name)).toEqual(['native.png', 'before.png', 'after.png'])
    } finally {
      gate.release.resolve()
      await host.ctx.fiber.dispose()
      await reader.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

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

  it('uses the current model on a historical branch and retains it after a cold reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rewind-model-'))
    let host: Awaited<ReturnType<typeof fixture>> | undefined
    let reader: Awaited<ReturnType<typeof fixture>> | undefined
    try {
      host = await fixture(root)
      await prompt(host, host.source.id, 'DISCARDED')
      const selection = { provider: 'fixture', model: 'current', reasoningEffort: 'high' }
      await host.transport.selectModel(host.source.id, selection)

      const child = await host.transport.forkSession({ sessionId: host.source.id, atSeq: host.boundary.seq })
      await host.transport.selectModel(child.sessionId, selection)
      await prompt(host, child.sessionId, 'RETRY')

      expect(host.configs.at(-1)).toMatchObject(selection)
      expect(host.errors).toEqual([])
      await host.ctx.fiber.dispose()

      reader = await fixture()
      const storage = new JsonlSessionPersistence(reader.ctx, { root })
      await using handle = await storage.open(child.sessionId, 'read')
      const loaded = await handle.read()
      const restored = Session.fromRestore(
        handle.id, loaded.events, handle.header, handle.inheritedEventCount, loaded.eventState,
      )
      expect(reader.ctx.sessionProjections.snapshot(restored).values.modelSelection?.next).toEqual(selection)
    } finally {
      await host?.ctx.fiber.dispose()
      await reader?.ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
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

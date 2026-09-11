import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-workspace'

/** Community Host policy: restore an ordinary conversation, not historical pending work. */
export class HostRewindFork {
  // The stable Host plugin scope owns factory-created Agents, never the source Agent/UI epoch.
  constructor(private readonly ctx: Context) {}

  async fork(request: { readonly sessionId: SessionId; readonly atSeq: number }): Promise<{ readonly sessionId: SessionId }> {
    using source = await this.ctx.sessionQuery.observeSession(request.sessionId)
    const parent = source.header.parentSession === undefined ? undefined : this.ctx.agents.get(source.header.parentSession)
    if (source.header.origin === 'subagent' || (parent !== undefined && this.ctx.agents.isOwnedBy(request.sessionId, parent))) {
      throw new Error('Rewind requires an ordinary session, not a delegated Agent.')
    }
    const boundary = source.events.findIndex(event => event.seq === request.atSeq && event.type === 'turn/end')
    if (boundary < 0) throw new Error('The rewind anchor must be an exact completed turn boundary.')
    // Keep between-turn policy/model facts, but never include the next turn's committed input.
    const nextTurn = source.events.findIndex((event, index) => index > boundary && event.type === 'turn/start')
    const seed = source.events.slice(0, nextTurn < 0 ? source.events.length : nextTurn)
    if (source.projections === undefined) throw new Error('Rewind requires a projected source session.')
    const presetId = source.projections.values.agentPreset ?? undefined
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined && presetId !== undefined) throw new Error('The source Agent preset cannot be mounted in this Host.')
    const resolvedPreset = presets === undefined ? undefined : (await presets.resolve(presetId)).id
    const workspace = this.ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(source.header.id))
    const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
    const sessionId = SessionId(`session-${randomUUID()}`)
    const handle = await this.ctx.agents.create({
      sessionId,
      seed,
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: {
        ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
        parentSession: source.header.id,
        isSeeded: true,
        ...(resolvedPreset === undefined ? {} : { agentPreset: resolvedPreset }),
      },
      agentOptions: { provider, model },
      setup: async (agentCtx, agent) => {
        // Public Inbox.clear appends cancellation events on the child's own suffix.
        // The factory persists setup before publication. Never edit/filter inherited events.
        agent.inbox.clear()
        // Fresh setup context belongs to the new branch and must survive the inherited clear.
        if (resolvedPreset !== undefined) await presets!.mount(agentCtx, resolvedPreset)
        // Do not install another model-selection binding. Controller.prompt/selectModel
        // binds its own selection before driving any adopted, factory-created live Agent.
      },
    })
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        // Workspace attachment requires an already-published identity. Stop the unused Agent;
        // do not pretend disposal erases the durable branch or earlier creation notifications.
        try { await handle.dispose() } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], `Rewind workspace attachment and cleanup failed for ${sessionId}.`)
        }
        throw new Error(`Rewound session ${sessionId} could not attach to its workspace; a persisted branch may remain.`, { cause: error })
      }
    }
    return { sessionId }
  }
}

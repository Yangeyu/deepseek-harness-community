import { describe, expect, it, vi } from 'vitest'
import { createCopyCommand, type CopyReplySession } from '../../../../src/application/commands/builtins/copy.ts'
import type { HistoryEntry } from '../../../../src/runtime/session/contracts.ts'

function reply(text: string, extra: Record<string, unknown> = {}): HistoryEntry {
  return { event: { type: 'assistant/message', surfaceOp: 'append', data: {
    message: { content: [{ type: 'text', text }] }, ...extra,
  } } } as HistoryEntry
}

function setup(events: readonly HistoryEntry[] = [], historyHasMore = false) {
  const captured = { active: true }
  const session = {
    current: { events, historyHasMore },
    captureSession: vi.fn(() => captured),
    loadEarlierHistory: vi.fn(async () => false),
    notice: vi.fn(),
  } satisfies CopyReplySession
  const clipboard = vi.fn(async (_text: string) => {})
  const abort = new AbortController()
  return { session, captured, clipboard, abort, command: createCopyCommand(session, clipboard, abort.signal) }
}

describe('/copy', () => {
  it('copies the newest completed append reply as original Markdown, ignoring non-answer content', async () => {
    const markdown = '# Answer\n\n```ts\nconst x = 1\n```'
    const answer = reply('', { message: { content: [
      { type: 'reasoning', text: 'private' }, { type: 'text', text: markdown },
      { type: 'text', text: 'Done.' },
    ] } })
    const replacement = { ...reply('summary'), event: { ...reply('summary').event, surfaceOp: 'replace' } } as HistoryEntry
    const { command, clipboard } = setup([
      reply('older'), answer, reply('   '), reply('interrupted', { interrupted: true }), replacement,
      reply('', { message: { content: [{ type: 'reasoning', text: 'thoughts' }] } }),
      { event: { type: 'tool/result', data: {
        message: { content: [{ type: 'text', text: 'Tool output' }] },
      } } } as unknown as HistoryEntry,
    ])
    await command.handler('')
    expect(clipboard).toHaveBeenCalledWith(`${markdown}\nDone.`)
  })

  it('reports an empty unbound conversation without requiring a captured Session', async () => {
    const { session, command, clipboard } = setup()
    session.captureSession.mockImplementation(() => { throw new Error('No bound Session') })
    await command.handler('')
    expect(session.notice).toHaveBeenCalledWith('No completed assistant reply to copy.')
    expect(clipboard).not.toHaveBeenCalled()
  })

  it('rereads paged history until an earlier completed reply is available', async () => {
    const { session, command, clipboard } = setup([], true)
    session.loadEarlierHistory
      .mockImplementationOnce(async () => {
        session.current = { events: [reply('attempt', { interrupted: true })], historyHasMore: true }
        return true
      })
      .mockImplementationOnce(async () => {
        session.current = { events: [reply('earlier answer'), ...session.current.events], historyHasMore: false }
        return true
      })
    await command.handler('')
    expect(clipboard).toHaveBeenCalledWith('earlier answer')
  })

  it.each(['retired', 'aborted'] as const)('does not copy a replacement Session after paging is %s', async reason => {
    const page = Promise.withResolvers<boolean>()
    const { session, captured, abort, command, clipboard } = setup([], true)
    session.loadEarlierHistory.mockReturnValue(page.promise)
    const pending = command.handler('')
    session.current = { events: [reply('different Session')], historyHasMore: false }
    if (reason === 'retired') captured.active = false
    else abort.abort()
    page.resolve(true)
    await pending
    expect(clipboard).not.toHaveBeenCalled()
    expect(session.notice).not.toHaveBeenCalled()
  })

  it('propagates history loading failures instead of treating them as empty history', async () => {
    const failure = new Error('History unavailable')
    const { session, command } = setup([], true)
    session.loadEarlierHistory.mockRejectedValue(failure)
    await expect(command.handler('')).rejects.toBe(failure)
  })
})

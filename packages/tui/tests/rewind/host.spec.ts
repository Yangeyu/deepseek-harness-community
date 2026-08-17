import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { installRewindWorkspaceAdapter, type RewindWorkspaceSink } from '../../src/rewind/index.ts'
import { decodeWorkspaceMutation } from '../../src/rewind/adapters/host.ts'

const target = {
  targetKey: '/workspace/a.txt',
  displayPath: '/workspace/a.txt',
} as unknown as FsTarget

describe('decodeWorkspaceMutation', () => {
  it('accepts the shared edit and write outcome contracts without reading tool names', () => {
    expect(decodeWorkspaceMutation(target, {
      path: target.displayPath,
      before: 'before',
      after: 'after',
    })).toMatchObject({ kind: 'reversible', before: 'before', after: 'after' })
    expect(decodeWorkspaceMutation(target, {
      path: target.displayPath,
      operation: 'create',
      before: null,
      after: 'created',
    })).toMatchObject({ kind: 'reversible', before: null, after: 'created' })
  })

  it('marks an overwrite without a contextual basis as unsupported', () => {
    expect(decodeWorkspaceMutation(target, {
      path: target.displayPath,
      operation: 'update',
      before: null,
      after: 'replacement',
    })).toMatchObject({ kind: 'unsupported' })
  })

  it('rejects mismatched targets, presentation payloads, and extra fields', () => {
    expect(decodeWorkspaceMutation(target, {
      path: '/workspace/other.txt',
      before: 'before',
      after: 'after',
    })).toBeUndefined()
    expect(decodeWorkspaceMutation(target, {
      path: target.displayPath,
      diffs: [],
    })).toBeUndefined()
    expect(decodeWorkspaceMutation(target, {
      path: target.displayPath,
      before: 'before',
      after: 'after',
      tool: 'edit',
    })).toBeUndefined()
  })

  it('correlates filesystem observation and result by the same execution identity', async () => {
    const ctx = new Context()
    const recordWorkspaceMutation = vi.fn()
    const sink: RewindWorkspaceSink = { recordWorkspaceMutation }
    installRewindWorkspaceAdapter(ctx, sink)
    const signal = new AbortController().signal
    const exec = {
      callId: 'call-1',
      rootCallId: 'call-1',
      name: 'any-provider-defined-name',
      arguments: {},
      signal,
      token: Symbol('execution'),
      agent: {
        id: 'session-1',
        session: {
          id: 'session-1',
          header: { cwd: '/workspace' },
          events: [{
            type: 'tool/call',
            seq: 3,
            time: 3,
            data: { turn: 2, step: 1, callId: 'call-1', name: 'root', arguments: '{}' },
          }],
        },
      },
    } as unknown as ToolExecution
    const result = Object.freeze({
      isError: false,
      value: { path: target.displayPath, before: 'before', after: 'after' },
      content: Object.freeze([]),
    }) as unknown as ToolExecutionResult

    ctx.emit('fs/observed', target, { kind: 'present', version: 'v1' as never }, exec)
    ctx.emit('tools/result', exec, result)

    expect(recordWorkspaceMutation).toHaveBeenCalledWith({
      kind: 'reversible',
      sessionId: 'session-1',
      turn: 2,
      callId: 'call-1',
      rootCallId: 'call-1',
      order: 1,
      workspaceRoot: '/workspace',
      path: '/workspace/a.txt',
      before: 'before',
      after: 'after',
    })
    await ctx.fiber.dispose()
  })
})

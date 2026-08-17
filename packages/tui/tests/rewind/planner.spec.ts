import { describe, expect, it } from 'vitest'
import type { WorkspaceMutation } from '../../src/rewind/index.ts'
import { planWorkspaceContent } from '../../src/rewind/domain/planner.ts'

function mutation(before: string | null, after: string): Extract<WorkspaceMutation, { kind: 'reversible' }> {
  return {
    kind: 'reversible',
    id: 'mutation',
    sourceSessionId: 'session',
    sourceTurn: 1,
    callId: 'call',
    rootCallId: 'call',
    order: 1,
    absolutePath: '/workspace/a.txt',
    before,
    after,
    bytes: (before?.length ?? 0) + after.length,
    createdAt: 1,
  }
}

describe('planWorkspaceContent', () => {
  it('returns an exact safe target when the current content is the AI after-state', () => {
    expect(planWorkspaceContent('after\n', [mutation('before\n', 'after\n')])).toMatchObject({
      state: 'safe',
      target: 'before\n',
    })
  })

  it('preserves a non-overlapping later edit', () => {
    expect(planWorkspaceContent(
      'one\nAI\nthree\nexternal\n',
      [mutation('one\ntwo\nthree\n', 'one\nAI\nthree\n')],
    )).toMatchObject({ state: 'mergeable', target: 'one\ntwo\nthree\nexternal\n' })
  })

  it('rejects overlapping edits and changed AI-created files', () => {
    expect(planWorkspaceContent(
      'one\nexternal\nthree\n',
      [mutation('one\ntwo\nthree\n', 'one\nAI\nthree\n')],
    )).toMatchObject({ state: 'conflict' })
    expect(planWorkspaceContent('changed\n', [mutation(null, 'created\n')])).toMatchObject({ state: 'conflict' })
  })
})

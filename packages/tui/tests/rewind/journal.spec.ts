import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { describe, expect, it } from 'vitest'
import type { RewindPointInput } from '../../src/modules/rewind/index.ts'
import { RewindJournal } from '../../src/modules/rewind/domain/journal.ts'

function journal(history = 2): RewindJournal {
  return new RewindJournal({ history, maxMutationBytes: 100, maxSessionBytes: 200 })
}

function point(sessionId: string, turn: number, prompt: string): RewindPointInput {
  return {
    pointId: `${sessionId}-prompt-${String(turn)}`,
    sessionId,
    turn,
    workspaceRoot: '/workspace',
    input: { text: prompt, attachments: [] },
    promptSeq: turn,
    createdAt: turn,
  }
}

function attachment(id = 'attachment-1'): ImageAttachmentRef {
  return {
    attachmentId: id as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
    name: 'image.png',
  }
}

describe('RewindJournal', () => {
  it('rejects malformed Prompt identities before they enter durable state', () => {
    const history = journal()
    expect(() => history.recordPoint({ ...point('session', 1, 'one'), pointId: '' }))
      .toThrow('point identity')
    expect(() => history.recordPoint({ ...point('session', 1, 'one'), createdAt: -1 }))
      .toThrow('creation time')
  })

  it('revalidates Prompt invariants when hydrating an external repository snapshot', () => {
    const source = journal()
    source.recordPoint(point('session', 1, 'one'))
    const snapshot = source.snapshot('/workspace')
    if (snapshot === undefined) throw new Error('expected timeline snapshot')
    const restored = journal()

    expect(() => restored.hydrate({
      ...snapshot,
      nodes: snapshot.nodes.map(node => ({ ...node, input: { text: '', attachments: [] } })),
    })).toThrow('prompt text')
  })

  it('retains bounded Prompt history', () => {
    const history = journal()
    history.recordPoint(point('session', 1, 'one'))
    history.recordPoint(point('session', 2, 'two'))
    history.recordPoint(point('session', 3, 'three'))

    expect(history.activePoints('session').map(point => point.turn)).toEqual([2, 3])
  })

  it('records a complete image Prompt once when its admission is replayed', () => {
    const history = journal()
    const admitted = {
      ...point('session', 1, 'compare [Image #1] and [Image #2]'),
      input: {
        text: 'compare [Image #1] and [Image #2]',
        attachments: [
          { reference: '[Image #1]', attachment: attachment() },
          { reference: '[Image #2]', attachment: attachment() },
        ],
      },
    }
    expect(history.recordPoint(admitted).changed).toBe(true)
    expect(history.recordPoint(admitted).changed).toBe(false)
    expect(history.activePoints('session')).toHaveLength(1)
    expect(history.activePoints('session')[0]?.input).toEqual(admitted.input)
  })

  it('moves a timeline cursor without deleting future nodes until a new Prompt branches', () => {
    const history = journal(4)
    history.recordPoint(point('session', 1, 'one'))
    history.recordPoint(point('session', 2, 'two'))
    history.recordPoint(point('session', 3, 'three'))
    const points = history.activePoints('session')

    history.commit('session', points[1]?.id ?? '', 'code-and-conversation', 'forked')

    expect(history.activePoints('forked').map(point => point.turn)).toEqual([1])
    expect(history.snapshot('/workspace')).toMatchObject({ cursor: 1, nodes: [{ turn: 1 }, { turn: 2 }, { turn: 3 }] })

    history.recordPoint(point('forked', 3, 'replacement'))

    expect(history.activePoints('forked').map(point => point.turn)).toEqual([1, 3])
    expect(history.snapshot('/workspace')).toMatchObject({ cursor: 2, nodes: [{ turn: 1 }, { turn: 3 }] })
  })

  it('does not make another Session Prompt depend on the current effect owner', () => {
    const history = journal()
    history.recordPoint(point('session', 1, 'one'))

    const observed = history.recordPoint(point('other', 1, 'independent'))

    expect(observed.durable).toBe(false)
    expect(history.activePoints('session')).toHaveLength(1)
    expect(history.activePoints('other')).toEqual([])
    expect(history.selectEffects('other', 'other-prompt-1').codeScope).toBe('none')
  })
})

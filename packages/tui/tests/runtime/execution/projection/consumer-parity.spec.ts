import { describe, expect, it } from 'vitest'
import { composerExecutionActivity } from '../../../../src/modules/composer/execution-activity.ts'
import {
  buildTranscriptItems,
  type TranscriptToolItem,
} from '../../../../src/modules/transcript/model.ts'
import {
  executionStatus,
  executionStartedAt,
  toolExecutionKey,
} from '../../../../src/runtime/execution/projection/index.ts'
import {
  buildTrajectoryRecords,
  trajectoryParentKey,
  trajectoryTiming,
} from '../../../../src/modules/trajectory/records.ts'
import type { RuntimeSessionSnapshot } from '../../../../src/runtime/session/manager.ts'
import { state, toolEvents } from '../../../modules/trajectory/fixtures.ts'

function transcriptTool(snapshot: RuntimeSessionSnapshot): TranscriptToolItem {
  const items = buildTranscriptItems(
    snapshot,
    true,
    false,
    20,
  )
  const activity = items.find(item => item.kind === 'activity')
  const tool = activity?.kind === 'activity'
    ? activity.items.find(item => item.kind === 'tool')
    : undefined
  if (tool?.kind !== 'tool') throw new Error('expected the tool transcript projection')
  return tool
}

describe('execution consumer parity', () => {
  it('shares one settled Tool node across Transcript and Trajectory', () => {
    const snapshot = state(toolEvents(true))
    const node = snapshot.execution.get(toolExecutionKey('call-1'))
    const transcript = transcriptTool(snapshot)
    const trajectory = buildTrajectoryRecords(snapshot.events, snapshot.execution)
      .find(record => record.kind === 'tool')

    expect(node).toBeDefined()
    expect(transcript.execution).toBe(node)
    expect(transcript.key).toBe(node?.key)
    expect(trajectory !== undefined && 'execution' in trajectory ? trajectory.execution : undefined).toBe(node)
    expect(trajectory === undefined ? undefined : trajectoryParentKey(trajectory)).toBe('step:1:1')
    expect(node === undefined ? undefined : executionStatus(node)).toBe('completed')
    expect(trajectory === undefined ? undefined : trajectoryTiming(trajectory)).toMatchObject({
      status: 'completed',
      startedAt: 1_200,
      completedAt: 1_500,
    })
  })

  it('uses the same running boundary for Transcript, Trajectory, and Composer', () => {
    const snapshot = state(toolEvents(false), { runState: 'running' })
    const node = snapshot.execution.get(toolExecutionKey('call-1'))
    const transcript = transcriptTool(snapshot)
    const trajectory = buildTrajectoryRecords(snapshot.events, snapshot.execution)
      .find(record => record.kind === 'tool')
    const composer = composerExecutionActivity(snapshot)

    expect(transcript.execution).toBe(node)
    expect(trajectory !== undefined && 'execution' in trajectory ? trajectory.execution : undefined).toBe(node)
    expect(composer).toEqual({
      key: 'turn:1',
      kind: 'execution',
      startedAt: executionStartedAt(node!),
    })
    expect(node === undefined ? undefined : executionStatus(node)).toBe('running')
  })
})

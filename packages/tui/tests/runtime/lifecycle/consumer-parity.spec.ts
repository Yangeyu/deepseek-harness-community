import { describe, expect, it } from 'vitest'
import { composerExecutionActivity } from '../../../src/presentation/composer-activity.ts'
import {
  buildTranscriptItems,
  type TranscriptToolItem,
} from '../../../src/presentation/transcript-model.ts'
import {
  executionStatus,
  lifecycleStartedAt,
  toolLifecycleKey,
} from '../../../src/runtime/lifecycle/index.ts'
import {
  buildTrajectoryRecords,
  trajectoryParentKey,
  trajectoryTiming,
} from '../../../src/trajectory/records.ts'
import type { TuiState } from '../../../src/runtime/controller.ts'
import { state, toolEvents } from '../../trajectory/fixtures.ts'

function transcriptTool(snapshot: TuiState): TranscriptToolItem {
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

describe('lifecycle consumer parity', () => {
  it('shares one settled Tool node across Transcript and Trajectory', () => {
    const snapshot = state(toolEvents(true))
    const node = snapshot.lifecycle.get(toolLifecycleKey('call-1'))
    const transcript = transcriptTool(snapshot)
    const trajectory = buildTrajectoryRecords(snapshot.events, snapshot.lifecycle)
      .find(record => record.kind === 'tool')

    expect(node).toBeDefined()
    expect(transcript.lifecycle).toBe(node)
    expect(transcript.key).toBe(node?.key)
    expect(trajectory !== undefined && 'lifecycle' in trajectory ? trajectory.lifecycle : undefined).toBe(node)
    expect(trajectory === undefined ? undefined : trajectoryParentKey(trajectory)).toBe('step:1:1')
    expect(node === undefined ? undefined : executionStatus(node)).toBe('completed')
    expect(trajectory === undefined ? undefined : trajectoryTiming(trajectory)).toMatchObject({
      status: 'completed',
      startedAt: 1_200,
      completedAt: 1_500,
    })
  })

  it('uses the same running boundary for Transcript, Trajectory, and Composer', () => {
    const snapshot = state(toolEvents(false), { running: true })
    const node = snapshot.lifecycle.get(toolLifecycleKey('call-1'))
    const transcript = transcriptTool(snapshot)
    const trajectory = buildTrajectoryRecords(snapshot.events, snapshot.lifecycle)
      .find(record => record.kind === 'tool')
    const composer = composerExecutionActivity(snapshot)

    expect(transcript.lifecycle).toBe(node)
    expect(trajectory !== undefined && 'lifecycle' in trajectory ? trajectory.lifecycle : undefined).toBe(node)
    expect(composer).toEqual({
      key: 'turn:1',
      kind: 'execution',
      startedAt: lifecycleStartedAt(node!),
    })
    expect(node === undefined ? undefined : executionStatus(node)).toBe('running')
  })
})

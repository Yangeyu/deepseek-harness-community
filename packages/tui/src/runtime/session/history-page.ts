import type { HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'

export interface SessionProjectionBaseline {
  readonly asOfSeq: number
  readonly values: Partial<SessionProjectionMap>
}

/** Transport-neutral, message-aligned history page consumed by SessionRuntime. */
export interface SessionHistoryPage {
  readonly events: readonly HistoryEntry[]
  readonly hasMore: boolean
  readonly projections?: SessionProjectionBaseline
}

import type {
  MemoryActivity,
  MemoryOverview,
  MemorySessionPolicy,
} from '@vascent/deepseek-harness-memory'

export interface MemoryPort {
  onActivity(listener: (activity: MemoryActivity) => void): () => void
  overview(cwd: string, sessionId?: string): Promise<MemoryOverview>
  setPolicy(sessionId: string, patch: Partial<MemorySessionPolicy>): MemorySessionPolicy
}

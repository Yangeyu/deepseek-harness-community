import type {
  MemoryActivity,
  MemoryOverview,
  MemorySessionPolicy,
} from '@vascent/deepseek-harness-memory'

export interface MemoryPort {
  onActivity(listener: (activity: MemoryActivity) => void): () => void
  overview(cwd: string, sessionId?: string): Promise<MemoryOverview>
  policy(sessionId: string): Promise<MemorySessionPolicy>
  setPolicy(sessionId: string, patch: Partial<MemorySessionPolicy>): Promise<MemorySessionPolicy>
}

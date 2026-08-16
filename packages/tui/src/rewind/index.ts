export { RewindService, type RewindServiceOptions } from './application/service.ts'
export { RewindTransaction, type RewindTransactionPhase } from './application/transaction.ts'
export { installRewindLifecycle } from './adapters/host.ts'
export { FileRewindRepository, type FileRewindRepositoryOptions } from './adapters/file-repository.ts'
export { LocalWorkspaceRewind } from './adapters/local-workspace.ts'
export type {
  RewindRepositoryEntry,
  RewindRepository,
  StoredRewindParticipant,
  StoredRewindTimeline,
} from './application/repository.ts'
export { RewindRepositoryConflictError } from './application/repository.ts'
export {
  MEMORY_REWIND_PARTICIPANT,
  MemoryRewindParticipant,
} from './adapters/memory.ts'
export type {
  CanonicalWorkspaceMutation,
  PreparedRewindParticipant,
  PreparedWorkspaceRewind,
  RewindApplicableState,
  RewindBlockedState,
  RewindCompensation,
  RewindConversationPort,
  RewindDirection,
  RewindEffectInput,
  RewindEffectPayload,
  RewindEffectReference,
  RewindEffectSink,
  RewindFilePlan,
  RewindLifecycleSink,
  RewindParticipant,
  RewindParticipantImpact,
  RewindPlan,
  RewindPlanState,
  RewindPointInput,
  RewindPointSummary,
  RewindPort,
  WorkspaceMutation,
  WorkspaceMutationInput,
  WorkspaceRewindBackend,
} from './contracts.ts'

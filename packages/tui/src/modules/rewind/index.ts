export { RewindService, type RewindServiceOptions } from './application/service.ts'
export { RewindTransaction, type RewindTransactionPhase } from './application/transaction.ts'
export { installRewindWorkspaceAdapter } from './adapters/host.ts'
export { HostRewindConversationHistory, rewindPointsFromSession } from './adapters/conversation.ts'
export { HostRewindFork } from './adapters/fork.ts'
export { installRewindPromptAdapter, rewindPointFromPrompt } from './adapters/prompt.ts'
export { FileRewindRepository, type FileRewindRepositoryOptions } from './adapters/file-repository.ts'
export { LocalWorkspaceRewind } from './adapters/local-workspace.ts'
export type {
  RewindRepositoryEntry,
  RewindRepository,
  StoredRewindTimeline,
} from './application/repository.ts'
export { RewindRepositoryConflictError } from './application/repository.ts'
export type {
  CanonicalWorkspaceMutation,
  PreparedWorkspaceRewind,
  RewindApplicableState,
  RewindBlockedState,
  RewindAction,
  RewindCodeScope,
  RewindCompensation,
  RewindConversationHistory,
  RewindConversationPort,
  RewindFilePlan,
  RewindPointSink,
  RewindPlan,
  RewindPlanState,
  RewindPointInput,
  RewindPointSummary,
  RewindPromptInput,
  RewindPort,
  RewindWorkspaceSink,
  WorkspaceMutation,
  WorkspaceMutationInput,
  WorkspaceRewindBackend,
} from './contracts.ts'

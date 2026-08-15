import { MemoryDocument, MemoryFileMutation, MemoryFileStore, MemoryForgetInput, MemoryProject, MemoryScope, MemoryTopic, MemoryWriteInput, memoryTopics } from "./store.js";
import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
//#region src/index.d.ts
/** Per-session switches exposed to terminal and browser consumers. */
interface MemorySessionPolicy {
  readonly useMemories: boolean;
  readonly generateMemories: boolean;
}
/** Complete Memory management view for one working directory and session. */
interface MemoryOverview {
  readonly project: MemoryProject;
  readonly policy: MemorySessionPolicy;
  readonly global: MemoryDocument;
  readonly projectMemory: MemoryDocument;
  readonly documents: readonly MemoryDocument[];
}
/** Background-learning state emitted without entering conversation history. */
type MemoryActivity = {
  readonly state: 'idle';
} | {
  readonly state: 'learning';
  readonly projectId: string;
  readonly sourceSessionId: string;
  readonly sourceTurn: number;
} | {
  readonly state: 'updated';
  readonly projectId: string;
  readonly summary: string;
} | {
  readonly state: 'error';
  readonly projectId: string;
  readonly message: string;
};
/** Reversible logical update attributed to its originating user turn. */
interface MemoryMutation {
  readonly id: string;
  readonly sourceSessionId?: string;
  readonly sourceTurn?: number;
  readonly scope: MemoryScope;
  readonly summary: string;
  readonly operation: 'write' | 'forget';
  readonly files: readonly MemoryFileMutation[];
  readonly createdAt: number;
}
/** Plugin configuration; every deployment-varying limit remains patchable. */
interface Config {
  readonly root: string;
  readonly useMemories?: boolean;
  readonly generateMemories?: boolean;
  readonly idleDelayMs?: number;
  readonly maxContextBytes?: number;
  readonly maxDocumentBytes?: number;
  readonly maxSummaryChars?: number;
  readonly maxDetailsChars?: number;
  readonly extractionMaxInputBytes?: number;
  readonly minCandidateChars?: number;
  readonly extractionProvider?: string;
  readonly extractionModel?: string;
}
interface MutationSource {
  readonly sessionId: string;
  readonly turn: number;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: ProjectMemoryService;
  }
}
/** Complete file provider, model tools, context consumer, and background learner. */
declare class ProjectMemoryService extends Service {
  static inject: string[];
  static Config: z<Config>;
  readonly store: MemoryFileStore;
  private readonly config;
  private readonly sessionPolicies;
  private readonly activityListeners;
  private readonly mutationListeners;
  private readonly childSources;
  private readonly learningTails;
  private readonly lifecycle;
  constructor(ctx: Context, config: Config);
  /** Resolve the policy currently applied to one live or resumable session id. */
  policy(sessionId?: string): MemorySessionPolicy;
  /** Replace current-session memory switches without changing deployment defaults. */
  setPolicy(sessionId: string, patch: Partial<MemorySessionPolicy>): MemorySessionPolicy;
  /** Build the complete management view used by TUI and other in-process surfaces. */
  overview(cwd: string, sessionId?: string): Promise<MemoryOverview>;
  /** Read one Markdown document. */
  read(cwd: string, scope: MemoryScope, topic?: MemoryTopic): Promise<MemoryDocument>;
  /** Persist one memory and publish its reversible mutation. */
  write(input: MemoryWriteInput, source?: MutationSource): Promise<MemoryMutation>;
  /** Forget one memory and publish its reversible mutation. */
  forget(input: MemoryForgetInput, source?: MutationSource): Promise<MemoryMutation>;
  /** Restore or reapply a previously published mutation without publishing a new one. */
  restore(mutation: MemoryMutation, direction: 'before' | 'after'): Promise<void>;
  /** Observe quiet learner progress; the disposer removes exactly this callback. */
  onActivity(listener: (activity: MemoryActivity) => void): () => void;
  /** Observe writes for integration with unified rewind checkpoints. */
  onMutation(listener: (mutation: MemoryMutation) => void): () => void;
  private registerTools;
  private registerContextInjection;
  private registerBackgroundLearning;
  private enqueueLearning;
  private learnWhenIdle;
  private runLearningAgent;
  private toMutation;
  private publishActivity;
  private publishMutation;
}
//#endregion
export { Config, MemoryActivity, type MemoryDocument, type MemoryFileMutation, MemoryFileStore, type MemoryForgetInput, MemoryMutation, MemoryOverview, type MemoryProject, type MemoryScope, MemorySessionPolicy, type MemoryTopic, type MemoryWriteInput, ProjectMemoryService, ProjectMemoryService as default, memoryTopics };
//# sourceMappingURL=index.d.ts.map
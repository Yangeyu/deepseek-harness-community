import z from "@deepseek-ai/schemastery";
import { Context, Service } from "@deepseek-ai/cordis";
//#region ../memory/lib/store.d.ts
//#region src/store.d.ts
/** Markdown file storage for global and project-scoped agent memory. */
declare const MEMORY_TOPICS: readonly ["preferences", "conventions", "decisions", "debugging"];
/** Stable memory scope selected by callers and model-facing tools. */
type MemoryScope = 'global' | 'project';
/** One supported topic file below a scope's compact MEMORY.md index. */
type MemoryTopic = (typeof MEMORY_TOPICS)[number];
/** Project identity and local storage directory resolved from one working directory. */
interface MemoryProject {
  readonly id: string;
  readonly root: string;
  readonly directory: string;
}
/** One Markdown document available in a memory scope. */
interface MemoryDocument {
  readonly scope: MemoryScope;
  readonly topic?: MemoryTopic;
  readonly path: string;
  readonly exists: boolean;
  readonly content: string;
  readonly bytes: number;
}
/** Before/after bytes for one reversible memory file write. */
interface MemoryFileMutation {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
}
/** One logical memory update, possibly touching an index and topic file. */
interface MemoryStoreMutation {
  readonly files: readonly MemoryFileMutation[];
  readonly changed: boolean;
}
/** Input accepted by a deterministic Markdown memory write. */
interface MemoryWriteInput {
  readonly cwd: string;
  readonly scope: MemoryScope;
  readonly summary: string;
  readonly topic?: MemoryTopic;
  readonly details?: string;
}
/** Input accepted by deterministic removal of one remembered summary. */
interface MemoryForgetInput {
  readonly cwd: string;
  readonly scope: MemoryScope;
  readonly summary: string;
  readonly topic?: MemoryTopic;
}
/** File store construction policy. */
interface MemoryFileStoreOptions {
  readonly root: string;
  readonly maxDocumentBytes: number;
  readonly maxSummaryChars: number;
  readonly maxDetailsChars: number;
}
/** Local Markdown implementation used by the Harness service. */
declare class MemoryFileStore {
  private readonly options;
  readonly root: string;
  private readonly queues;
  constructor(options: MemoryFileStoreOptions);
  /** Resolve a stable project directory, sharing identity across clones with the same origin URL. */
  project(cwd: string): Promise<MemoryProject>;
  /** Read one bounded Markdown memory document without creating it. */
  read(cwd: string, scope: MemoryScope, topic?: MemoryTopic): Promise<MemoryDocument>;
  /** List existing Markdown documents for both memory scopes. */
  list(cwd: string): Promise<MemoryDocument[]>;
  /** Append one deduplicated memory and return the exact reversible file mutation. */
  write(input: MemoryWriteInput): Promise<MemoryStoreMutation>;
  /** Remove one exact remembered summary from its index and optional topic. */
  forget(input: MemoryForgetInput): Promise<MemoryStoreMutation>;
  /** Apply an exact before/after mutation direction with stale-state protection. */
  restore(files: readonly MemoryFileMutation[], direction: 'before' | 'after'): Promise<void>;
  private pathFor;
  private cleanText;
  private assertDocumentSize;
  private isOwnedPath;
  private enqueue;
}
/** Public topic vocabulary shared by tools and UI consumers. */
declare const memoryTopics: readonly MemoryTopic[];
//#endregion
//#region ../memory/lib/index.d.ts
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
export { MemorySessionPolicy as a, MemoryFileMutation as c, MemoryProject as d, MemoryScope as f, memoryTopics as h, MemoryOverview as i, MemoryFileStore as l, MemoryWriteInput as m, MemoryActivity as n, ProjectMemoryService as o, MemoryTopic as p, MemoryMutation as r, MemoryDocument as s, Config as t, MemoryForgetInput as u };
//# sourceMappingURL=index-CbzrvIlp.d.ts.map
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
  private migrateLegacyProjectDirectories;
  private migrateLegacyProjectDirectory;
  private enqueue;
}
/** Public topic vocabulary shared by tools and UI consumers. */
declare const memoryTopics: readonly MemoryTopic[];
//#endregion
export { MemoryDocument, MemoryFileMutation, MemoryFileStore, MemoryFileStoreOptions, MemoryForgetInput, MemoryProject, MemoryScope, MemoryStoreMutation, MemoryTopic, MemoryWriteInput, memoryTopics };
//# sourceMappingURL=store.d.ts.map
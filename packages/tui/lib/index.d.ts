import { r as MemoryMutation } from "./index-BX8q4BCW.js";
import { GoalRef, HistoryEntry, IApiClient, ModelSelection, MuxFrame, QueuedInboxItem, RpcId, SessionModels, SessionSummary } from "@deepseek-ai/dsh-host-apiproxy";
import { Component, EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";
import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
import { SessionProjectionMap } from "@deepseek-ai/dsh-session-projection/types";
//#region src/application/config.d.ts
/** User-configurable TUI presentation and history bounds. */
interface Config {
  historyMessages?: number;
  rewindCheckpoints?: number;
  maxToolOutputLines?: number;
  thinkingMaxLines?: number;
  showReasoning?: boolean;
  showHardwareCursor?: boolean;
  color?: boolean;
  title?: string;
  cwd?: string;
  sessionId?: string;
}
/** Loader schema for the public plugin configuration. */
declare const Config: z<Config>;
/** Fully materialized settings consumed by the application. */
interface ResolvedConfig {
  historyMessages: number;
  rewindCheckpoints: number;
  maxToolOutputLines: number;
  thinkingMaxLines: number;
  showReasoning: boolean;
  showHardwareCursor: boolean;
  color: boolean;
  title: string;
  cwd: string;
  sessionId?: string;
}
/** Resolve optional loader fields once at application startup. */
declare function resolveConfig(config: Config): ResolvedConfig;
//#endregion
//#region src/checkpoint.d.ts
/** One file that differs from the pre-turn worktree checkpoint. */
interface CheckpointFileChange {
  path: string;
  added?: number;
  removed?: number;
}
/** Immutable confirmation payload for one selected-turn rewind. */
interface RewindPreview {
  checkpointId: string;
  sessionId: string;
  turn: number;
  prompt: string;
  createdAt: number;
  previousTurnEndSeq?: number;
  files: CheckpointFileChange[];
  currentTree: string;
  memoryMutations?: readonly MemoryMutation[];
}
//#endregion
//#region src/runtime/submission.d.ts
/** Locally visible prompt retained until its durable user-message event is observed. */
interface PendingSubmission {
  key: number;
  text: string;
  mode: 'queue' | 'steer';
  intent: 'working' | 'queueing' | 'steering';
  rpcId?: RpcId;
}
//#endregion
//#region src/runtime/controller.d.ts
type SessionId$1 = SessionSummary['sessionId'];
/** Answerable approval request delivered by the mux stream. */
type ApprovalPrompt = Extract<MuxFrame, {
  type: 'approval/requested';
}> & {
  rpcId: RpcId;
};
/** Answerable question batch delivered by the mux stream. */
type QuestionPrompt = Extract<MuxFrame, {
  type: 'question/requested';
}> & {
  rpcId: RpcId;
};
/** Renderer-facing state for the one active terminal session. */
interface TuiState {
  sessionId: SessionId$1 | undefined;
  cwd: string;
  running: boolean;
  connected: boolean;
  events: HistoryEntry[];
  historyHasMore: boolean;
  queue: QueuedInboxItem[];
  pendingSubmissions: PendingSubmission[];
  models: SessionModels | undefined;
  projections: Partial<SessionProjectionMap>;
  notice: string | undefined;
  error: string | undefined;
}
/** UI callbacks kept independent from the concrete pi-tui renderer. */
interface TuiControllerSink {
  render(state: Readonly<TuiState>): void;
  requestApproval(prompt: ApprovalPrompt): void;
  requestQuestions(prompt: QuestionPrompt): void;
}
/** Session and stream coordinator over the transport-neutral Harness API. */
declare class HarnessController {
  private readonly api;
  private readonly sink;
  private readonly historyMessages;
  private readonly abort;
  private state;
  private resyncTask;
  private generation;
  private projectionSeqs;
  private readonly submissions;
  constructor(api: IApiClient, sink: TuiControllerSink, cwd: string, historyMessages: number);
  /** Current immutable-by-convention state snapshot. */
  get current(): Readonly<TuiState>;
  /** Create or resume the initial session, then attach both event streams. */
  start(resumeSessionId?: string): Promise<void>;
  /** Stop stream reads and reject further controller work. */
  dispose(): void;
  /** Publish a transient terminal-only notice. */
  notice(message: string): void;
  /** List resumable session rows for a terminal selector. */
  sessions(): Promise<SessionSummary[]>;
  /** Prepend one older, message-aligned history page without disturbing live tail events. */
  loadEarlierHistory(): Promise<boolean>;
  /** Switch the terminal to a fresh session in the current working directory. */
  newSession(): Promise<void>;
  /** Clear the visible conversation immediately, then attach a fresh session. */
  clearSession(): Promise<void>;
  /** Switch the terminal to an existing persisted or live session. */
  resume(sessionId: string): Promise<void>;
  /** Fork to the boundary before the checkpointed turn, then open and return the replacement session. */
  rewind(preview: RewindPreview, onPhase?: (phase: 'forking' | 'opening') => void): Promise<SessionId$1>;
  /** Submit ordinary text using the caller-selected queue placement. */
  prompt(text: string, mode: 'queue' | 'steer'): Promise<void>;
  /** Create a durable Goal; the read side remains the goal projection. */
  createGoal(objective: string, maxGoalRounds?: number): Promise<GoalRef>;
  /** Edit the exact projected Goal revision with Host compare-and-set semantics. */
  editGoal(ref: GoalRef, objective?: string, maxGoalRounds?: number): Promise<GoalRef>;
  pauseGoal(ref: GoalRef): Promise<GoalRef>;
  resumeGoal(ref: GoalRef): Promise<GoalRef>;
  completeGoal(ref: GoalRef): Promise<GoalRef>;
  clearGoal(ref: GoalRef): Promise<void>;
  /** Hand a local authoring file to the Host platform opener when available. */
  openPath(path: string, signal: AbortSignal): Promise<void>;
  /** Cancel the active turn while preserving pending queued work. */
  cancel(): Promise<void>;
  /** Refresh the model directory used by the selector and status line. */
  refreshModels(): Promise<SessionModels>;
  /** Select an exact model route for subsequent steps. */
  selectModel(selection: ModelSelection): Promise<void>;
  /** Answer one approval request through the response leg of the RPC protocol. */
  answerApproval(prompt: ApprovalPrompt, outcome: 'allowed-once' | 'rejected'): Promise<void>;
  /** Answer a complete question batch through the response leg of the RPC protocol. */
  answerQuestions(prompt: QuestionPrompt, answers: Array<{
    id: string;
    selected: string[];
    custom?: string;
  }>): Promise<void>;
  /** Cancel a question batch without manufacturing an answer. */
  cancelQuestions(prompt: QuestionPrompt): Promise<void>;
  private respond;
  private requireSession;
  private openSession;
  private resync;
  private runMuxLoop;
  private runHostLoop;
  private handleMux;
  private handleHost;
  private appendEvent;
  private mergeProjectionBaseline;
  private applyProjection;
  private emptySessionState;
  private patch;
  private emit;
}
//#endregion
//#region src/runtime/commands.d.ts
type SessionId = SessionSummary['sessionId'];
/** Toolkit-neutral command metadata used by help and autocomplete surfaces. */
interface TerminalCommandDescriptor {
  name: string;
  description: string;
  argumentHint?: string;
}
/** TUI-owned command with aliases and a local interaction handler. */
interface TerminalCommandDefinition extends TerminalCommandDescriptor {
  aliases?: readonly string[];
  handler(argument: string): void | Promise<void>;
}
interface HostCommandResult {
  kind: 'success' | 'error';
  text?: string;
  sourceEventSeq?: number;
}
/** Bare-invocation UI attached to an existing Host command. */
interface TerminalCommandDecoration {
  name: string;
  handler(): void | Promise<void>;
}
/** Host-backed command discovery and execution without leaking Cordis into the application. */
interface HostCommandSource {
  list(sessionId: SessionId | undefined): readonly TerminalCommandDescriptor[];
  execute(sessionId: SessionId, line: string, signal: AbortSignal): Promise<HostCommandResult | undefined>;
  subscribe(listener: () => void): () => void;
}
/**
 * One command directory for local interaction commands and agent-scoped Host
 * commands. Rendering libraries consume its plain descriptors; resolved Host
 * commands execute through the Host port and never fall through to the model.
 */
declare class TerminalCommandDirectory {
  private readonly local;
  private readonly source?;
  private readonly onChange;
  private readonly localByName;
  private readonly decorations;
  private readonly executions;
  private readonly removeHostListener;
  private sessionId;
  private host;
  private signature;
  constructor(local: readonly TerminalCommandDefinition[], source?: HostCommandSource | undefined, onChange?: () => void, decorations?: readonly TerminalCommandDecoration[]);
  /** Effective discovery rows, with TUI-local commands shadowing Host names. */
  get descriptors(): readonly TerminalCommandDescriptor[];
  /** Every effective dispatch name, including local aliases hidden from discovery rows. */
  get resolutionNames(): readonly string[];
  has(name: string): boolean;
  /** Refresh the agent-scoped Host view when the active session changes. */
  setSession(sessionId: SessionId | undefined): boolean;
  /** Dispatch a local interaction or a resolved Host command. */
  dispatch(text: string): Promise<boolean>;
  /** Execute an already selected Host command without re-entering local dispatch. */
  dispatchHost(text: string): Promise<void>;
  /** Complete help content generated from the same effective discovery rows. */
  helpText(): string;
  dispose(): void;
  private abortExecutions;
  private refreshHost;
}
//#endregion
//#region src/application/app.d.ts
/** Launcher-owned exit function used instead of calling process.exit from raw mode. */
interface TuiRuntime {
  exit(code: number): void;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}
//#endregion
//#region src/presentation/diff-location.d.ts
/** Per-card, per-hunk starting line numbers. */
type DiffLineStarts = ReadonlyMap<string, readonly (number | undefined)[]>;
//#endregion
//#region src/presentation/theme.d.ts
type Paint = (text: string) => string;
/** Terminal presentation roles used by the renderer and dialogs. */
interface TuiTheme {
  accent: Paint;
  bold: Paint;
  dim: Paint;
  diffAdded: Paint;
  diffRemoved: Paint;
  error: Paint;
  hover: Paint;
  reasoning: Paint;
  success: Paint;
  tool: Paint;
  underline: Paint;
  user: Paint;
  userBlock: Paint;
  warning: Paint;
  editor: EditorTheme;
  markdown: MarkdownTheme;
  select: SelectListTheme;
}
//#endregion
//#region src/presentation/transcript.d.ts
/** Scrollback-first transcript component rebuilt from the current API event window. */
declare class TranscriptComponent implements Component {
  private readonly theme;
  private readonly showReasoning;
  private readonly maxToolOutputLines;
  private readonly thinkingMaxLines;
  private state;
  private showDetails;
  private readonly expandedThinking;
  private readonly toolExpansion;
  private readonly collapsedDiffs;
  private readonly followingThinking;
  private readonly blockOffsets;
  private readonly blockMaxOffsets;
  private blockHits;
  private hoveredBlockKey;
  private diffLineStarts;
  constructor(state: Readonly<TuiState>, theme: TuiTheme, showReasoning: boolean, maxToolOutputLines: number, thinkingMaxLines?: number);
  setState(state: Readonly<TuiState>): void;
  setDetails(show: boolean): void;
  /** Supply asynchronously resolved absolute file-line starts for diff cards. */
  setDiffLineStarts(starts: DiffLineStarts): void;
  invalidate(): void;
  /** Apply one pointer action to the block rendered at a transcript-relative row. */
  handlePointer(line: number, action: 'move' | 'click' | 'wheel-up' | 'wheel-down'): boolean;
  render(width: number): string[];
  private renderPromptBlock;
  private contentWidth;
  private frameContent;
  private pushBlock;
  private renderThinking;
  private renderTool;
  private isToolExpanded;
  private renderDiff;
  private renderDiffTitle;
  private renderDiffLine;
  private renderBlockTitle;
  private resolveBlockOffset;
  private scrollBlock;
}
//#endregion
//#region src/trajectory/records.d.ts
type TrajectoryKind = 'turn' | 'step' | 'user' | 'request' | 'assistant' | 'tool' | 'command' | 'context' | 'event';
type TrajectoryStatus = 'pending' | 'completed' | 'warning' | 'failed' | 'info';
/** One semantic execution record assembled from the durable session event log. */
interface TrajectoryRecord {
  key: string;
  kind: TrajectoryKind;
  type: string;
  completionType?: string;
  seq: number;
  completionSeq?: number;
  turn?: number;
  step?: number;
  title: string;
  /** Compact, single-line preview used only by the execution ledger. */
  summary: string;
  /** Complete semantic text shown by the Summary tab. */
  detail?: string;
  status: TrajectoryStatus;
  startedAt: number;
  completedAt?: number;
  payload?: unknown;
  result?: unknown;
  schema?: unknown;
}
/** Pair lifecycle boundaries and tool call/results into an ordered diagnostic ledger. */
declare function buildTrajectoryRecords(entries: readonly HistoryEntry[]): TrajectoryRecord[];
//#endregion
//#region src/trajectory/view.d.ts
/** Full-screen, keyboard-first execution ledger and event detail surface. */
declare class TrajectoryView implements Component {
  private readonly visibleRows;
  private readonly theme;
  private readonly onLoadEarlier;
  private readonly onInterrupt;
  private readonly onCancel;
  private readonly onChange;
  private state;
  private records;
  private model;
  private index;
  private mode;
  private tabIndex;
  private detailOffset;
  private detailPageRows;
  private detailMaxOffset;
  private listPageRows;
  private followTail;
  private loadingEarlier;
  private loadError;
  private splitLayout;
  private readonly collapsedTurns;
  private readonly collapsedSteps;
  constructor(state: Readonly<TuiState>, visibleRows: () => number, theme: TuiTheme, onLoadEarlier: () => Promise<boolean>, onInterrupt: () => void, onCancel: () => void, onChange: () => void);
  /** Rebuild from the latest live event window while preserving the selected semantic record. */
  setState(state: Readonly<TuiState>): void;
  handleInput(data: string): void;
  invalidate(): void;
  render(width: number): string[];
  private renderList;
  private renderSplit;
  private renderDetail;
  private renderDetailPanel;
  private renderOverviewHeader;
  private renderColumnHeader;
  private renderListRows;
  private renderRecord;
  private visibleRecordIndexes;
  private collapseSelected;
  private expandSelected;
  private move;
  private openDetail;
  private selectTab;
  private scrollDetail;
  private loadEarlier;
  private fit;
}
//#endregion
//#region src/trajectory/model.d.ts
/** Minimal semantic shape required to index and measure a trace record. */
interface TrajectoryNode {
  key: string;
  kind: string;
  turn?: number;
  step?: number;
  title: string;
  status: string;
  startedAt: number;
  completedAt?: number;
}
interface TrajectoryMetrics {
  durationMs?: number;
  offsetMs: number;
  shareOfParent?: number;
  slowest: boolean;
  parentTitle?: string;
}
interface TrajectoryMeasurement<T extends TrajectoryNode> {
  metrics: ReadonlyMap<string, TrajectoryMetrics>;
  bottleneck: T | undefined;
}
/**
 * Immutable relationship index for one trace snapshot. Parent lookup is O(1),
 * and a complete timing measurement is O(n) even for long paged sessions.
 */
declare class TrajectoryModel<T extends TrajectoryNode> {
  private readonly records;
  private readonly parents;
  constructor(records: readonly T[]);
  parentOf(record: T): T | undefined;
  measure(now: number): TrajectoryMeasurement<T>;
}
//#endregion
//#region src/text.d.ts
/** Remove terminal control sequences from untrusted model, tool, and user text. */
declare function sanitizeTerminalText(value: string): string;
//#endregion
//#region src/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Loader settlement barrier supplied by dsh profile boot. */
    loader?: {
      await(): Promise<void>;
    };
    /** Application command line supplied by the dsh launcher. */
    cmdlineArgs?: {
      get(): readonly string[];
    };
    /** Bounded process exit supplied by the dsh launcher. */
    appExit?: (code: number) => void;
  }
}
/** Stable Cordis plugin name. */
declare const name = "community-tui";
/** The in-process API gateway must exist before the terminal can activate. */
declare const inject: string[];
/** Mount the terminal application and bind its lifetime to the plugin effect. */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { type ApprovalPrompt, Config, type Config as TuiConfig, HarnessController, type HostCommandSource, type PendingSubmission, type QuestionPrompt, type TerminalCommandDefinition, type TerminalCommandDescriptor, TerminalCommandDirectory, type TrajectoryMeasurement, type TrajectoryMetrics, TrajectoryModel, type TrajectoryNode, type TrajectoryRecord, TrajectoryView, TranscriptComponent, type TuiControllerSink, type TuiRuntime, type TuiState, apply, buildTrajectoryRecords, inject, name, resolveConfig, sanitizeTerminalText };
//# sourceMappingURL=index.d.ts.map
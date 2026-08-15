import { r as MemoryMutation } from "./index-CbzrvIlp.js";
import { HistoryEntry, IApiClient, ModelSelection, MuxFrame, QueuedInboxItem, RpcId, SessionModels, SessionSummary } from "@deepseek-ai/dsh-host-apiproxy";
import { Component, EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";
import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
import { SessionProjectionMap } from "@deepseek-ai/dsh-session-projection/types";
//#region src/config.d.ts
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
//#region src/submission.d.ts
/** Locally visible prompt retained until its durable user-message event is observed. */
interface PendingSubmission {
  key: number;
  text: string;
  mode: 'queue' | 'steer';
  intent: 'working' | 'queueing' | 'steering';
  rpcId?: RpcId;
}
//#endregion
//#region src/controller.d.ts
type SessionId = SessionSummary['sessionId'];
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
  sessionId: SessionId | undefined;
  cwd: string;
  running: boolean;
  connected: boolean;
  events: HistoryEntry[];
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
  /** Switch the terminal to a fresh session in the current working directory. */
  newSession(): Promise<void>;
  /** Clear the visible conversation immediately, then attach a fresh session. */
  clearSession(): Promise<void>;
  /** Switch the terminal to an existing persisted or live session. */
  resume(sessionId: string): Promise<void>;
  /** Fork to the boundary before the checkpointed turn, then open and return the replacement session. */
  rewind(preview: RewindPreview, onPhase?: (phase: 'forking' | 'opening') => void): Promise<SessionId>;
  /** Submit ordinary text using the caller-selected queue placement. */
  prompt(text: string, mode: 'queue' | 'steer'): Promise<void>;
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
//#region src/app.d.ts
/** Launcher-owned exit function used instead of calling process.exit from raw mode. */
interface TuiRuntime {
  exit(code: number): void;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}
//#endregion
//#region src/diff-location.d.ts
/** Per-card, per-hunk starting line numbers. */
type DiffLineStarts = ReadonlyMap<string, readonly (number | undefined)[]>;
//#endregion
//#region src/theme.d.ts
type Paint = (text: string) => string;
/** Terminal presentation roles used by the renderer and dialogs. */
interface TuiTheme {
  accent: Paint;
  assistant: Paint;
  bold: Paint;
  dim: Paint;
  diffAdded: Paint;
  diffRemoved: Paint;
  error: Paint;
  hover: Paint;
  reasoning: Paint;
  success: Paint;
  underline: Paint;
  user: Paint;
  userBlock: Paint;
  warning: Paint;
  editor: EditorTheme;
  markdown: MarkdownTheme;
  select: SelectListTheme;
}
//#endregion
//#region src/transcript.d.ts
/** Scrollback-first transcript component rebuilt from the current API event window. */
declare class TranscriptComponent implements Component {
  private readonly theme;
  private readonly showReasoning;
  private readonly maxToolOutputLines;
  private readonly thinkingMaxLines;
  private state;
  private showDetails;
  private readonly expandedThinking;
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
  private pushBlock;
  private renderThinking;
  private renderDiff;
  private renderDiffTitle;
  private renderDiffLine;
  private renderBlockTitle;
  private resolveBlockOffset;
  private scrollBlock;
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
export { type ApprovalPrompt, Config, type Config as TuiConfig, HarnessController, type PendingSubmission, type QuestionPrompt, TranscriptComponent, type TuiControllerSink, type TuiRuntime, type TuiState, apply, inject, name, resolveConfig, sanitizeTerminalText };
//# sourceMappingURL=index.d.ts.map
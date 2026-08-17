# Changelog

All notable changes to this project are documented in this file.

## Unreleased

- Add official `web_search` and provider-neutral `web_extract` tool support
  through explicitly selected Brave Search and Tavily Extract providers, per-operation Harness
  credential resolution, bounded output, stable error mapping, cancellation,
  and a secret-free `/config web` status surface.

## 0.1.10 - 2026-08-17

- Add drag-based mouse text selection across rendered TUI content and copy the
  completed selection to the system clipboard without changing application
  focus or command interaction.
- Add `@` workspace file references with ranked path matching, keyboard and
  mouse selection, and the same above-composer suggestion surface used by slash
  commands so opening results does not move the input.
- Preserve approval and question interactions while runtime cancellation
  settles, and keep interruption ownership tied to the active operation.
- Add stable workspace and Git branch context to the composer footer, improve
  persistent status contrast, and make repeated `Ctrl+C` exit deterministically
  when interrupted work does not settle.
- Expand `dsh-tui` into a side-effect-free typed command surface with canonical
  session resume, session listing, headless execution, diagnostics, shell
  completion, profile configuration and plugin delegation, startup controls,
  command help, and `-v`/`-V`/`--version` aliases.

## 0.1.9 - 2026-08-17

- Make idle `Esc` clear and retain one unified text-and-image Composer draft,
  restore or hide that draft with `Up`/`Down`, and count only physical key
  presses toward `Esc Esc` Rewind while preserving autocomplete, modal,
  attachment-focus, and running-task cancellation priority.
- Replace whole-worktree Git checkpoints with source-attributed Rewind points
  backed by correlated Host filesystem observations and canonical mutation
  outcomes; external-window changes are no longer listed or restored.
- Add safe, mergeable, conflict, and unsupported restore planning with exact
  path disclosure, non-overlapping edit preservation, stale guards, and atomic
  workspace/Memory/conversation compensation.
- Separate pure Rewind contracts, Journal, and reverse planner from Host,
  Memory, and local-filesystem adapters; consume the capability through a
  narrow application port and bound retained mutation content by bytes.
- Persist one active editing lineage per canonical workspace under the Harness
  home so its owner session can resume Rewind after TUI restart; retain cursor
  and future-node state for a later timeline-navigation UI.
- Model every admitted human input as one stable Prompt lifecycle node and bind
  delayed Vision evidence to its explicit Prompt identity instead of inferring
  ownership from event proximity.
- Retain complete Prompt text and immutable image references in Rewind, verify
  every image before mutation, and restore text and image drafts together in
  the forked Composer after a successful rewind.
- Add atomic content-addressed storage, opaque participant hydration,
  cross-process locking, optimistic revision checks, corruption quarantine,
  bounded LRU compaction, and stale-history invalidation after failed saves.
- Remove detached Git-index snapshots, asynchronous whole-tree file counts,
  duplicate checkpoint state, implementation-coupled checkpoint tests, and
  presentation paths that hid durable user input when lifecycle metadata was
  unavailable.

## 0.1.8 - 2026-08-16

- Expose the TUI, Memory, and Vision APIs through public subpaths of the single
  `@vascent/dsh-tui` release artifact.
- Add the `v0.1.8` unified execution lifecycle: one typed replayable snapshot
  now drives Transcript, Trajectory, composer status, Diff, Activity, and
  pre-admission Vision feedback with stable identities and atomic controller
  publication.
- Remove consumer event-pairing Maps, copied execution statuses and clocks,
  Host-running child overrides, and duplicate glyph/disclosure policies; add
  monotonic transition diagnostics, immutable boundaries, and indexed
  long-history replay.
- Keep failed Session opens from invalidating active prompt work, bind composer
  timing to semantic Activity identity, preserve Activity disclosure through
  history prepend, reuse lifecycle snapshots for unrelated controller updates,
  and derive Trajectory parents and duration text from shared policies.

## 0.1.7 - 2026-08-16

- Standardize maintained implementation on TypeScript `src/`, generate ignored
  workspace and launcher output under `dist/`, and keep npm archives under
  `artifacts/` instead of committing generated runtime and declaration files.
- Add a semantic, context-aware keymap layer with persisted Standard and Legacy
  presets, `/keymap` and `/config keybindings`, `Tab` queueing while working,
  and restored `Alt+Enter` multiline input under the default preset.
- Add repeatable `-i`/`--image` startup attachments for new and resumed
  sessions, using the same validated in-memory draft path as `/attach`.
- Normalize Kitty press/repeat/release events before shortcut dispatch and
  coalesce concurrent clipboard reads so one paste creates one image draft.
- Keep the first composer footer row limited to model identity and reasoning,
  preserve session metrics on the second row, and keep shortcut discovery in
  `/keymap`.
- Group adjacent thinking and non-diff tools into compact, expandable Activity
  segments with stable timing/count summaries, live latest-action context, and
  automatic failure disclosure; share terminal lifecycle and status-glyph
  semantics across Thought, tools, and Diffs, settle interrupted work at
  `turn/end`, settle Thought when answer streaming starts, and keep returned
  file evidence in the main conversation timeline.
- Add file and macOS clipboard image drafts with a fixed two-row attachment
  rail, primary `Ctrl+V` paste, compatible `Alt+V` fallback, keyboard
  management, retained retry state, and Host limit prechecks.
- Add the internal Vision service workspace with explicit native/proxy routing,
  DashScope `qwen3.7-plus` configuration, credential preflight, bounded
  untrusted observations, exact-id staging, and durable attachment evidence.
- Persist completed proxy evidence through a structured, supported
  `user/message` source instead of an unregistered `vision/analysis` event;
  present the user prompt before its Vision card and keep failed pre-submission
  analyses out of session history.
- Commit proxy prompts through a two-phase, restart-safe inbox admission that
  retains standard image blocks for authenticated lookup and session export,
  then admits only the exact user text and untrusted observation to text models.
- Add `/config vision` and `/vision`, model-switch safety for native-image
  history, expandable Transcript cards, and timed Trajectory records that
  participate in bottleneck detection.

## 0.1.6 - 2026-08-16

- Define the `v0.1.6` Configuration, Task, and User Extensions product roadmap,
  interaction contracts, module boundaries, compatibility behavior, delivery
  slices, and release acceptance criteria.
- Add a scoped `/config` center for model, reasoning, effective permissions,
  Plan Mode, and terminal details, plus a separate `/task` surface for CAS-safe
  Goal operations, read-only Todo progress, and runtime cancellation.
- Preserve `/permission` as a direct deep link into the shared Config flow.
- Merge effective Host Commands and user-invocable Skills into autocomplete
  with deterministic Command precedence, exact Host-owned Skill invocation,
  stale-safe per-session discovery, and local rejection of unknown slash input.
- Add a searchable `/skills` browser plus safe project/user Skill creation and
  editing with canonical frontmatter, collision protection, external-editor
  terminal restoration, post-edit validation, and effective-catalog refresh.
- Split session-control selectors, Config/Task presentation, Slash resolution,
  Skill caching, local authoring, and authoring coordination into independently
  tested modules rather than adding feature state to the main application.
- Execute every discovered Host Command through `ctx.commands.execute` instead
  of allowing it to fall through to model prompting, and decorate bare
  `/permission` with the projection-backed TUI selector while preserving
  canonical argued execution and full-access confirmation.

## 0.1.5 - 2026-08-15

- Merge TUI-local interactions with the effective agent-scoped Harness command
  catalog so autocomplete and `/help` share one source while Host commands
  continue through ApiProxy and never reach the model.
- Render durable `command/run` and `command/done` pairs as one settled command
  node in both the conversation and `/trajectory` inspector without duplicating
  the result as a terminal-only notice.
- Extract indexed trajectory relationships and timing analysis into a
  toolkit-neutral, linear-time `TrajectoryModel` with focused unit coverage.
- Document Host, terminal-runtime, and presentation ownership plus the staged
  route toward semantic event assembly and durable Host checkpoints.
- Organize sources and tests by application, runtime, trajectory, and
  presentation ownership while preserving the package entry point and exports.

## 0.1.4 - 2026-08-15

- Refine inline tool and file-diff presentation with brighter titles, compact
  disclosure controls, accurate wrapped changes, and a resume command on exit.
- Add content-scoped reading padding and a dedicated conversation/composer gap,
  render deep Markdown headings without source markers, improve Thinking
  contrast, and make individual tool calls clickable for arguments/results.
- Add a responsive `/trajectory` trace explorer with paired lifecycles, paged
  history, fixed duration/share visualization, bottleneck highlighting,
  collapsible hierarchy, and complete side-by-side event inspection.
- Share project memory across linked Git Worktrees and differently named clones,
  including migration of existing local-directory-based memory.
- Keep the header inside the scrollable conversation viewport and add an
  isolated development launcher that cannot modify the production profile.

## 0.1.3 - 2026-08-15

- Add the standalone file-backed Memory plugin to the TUI bundle, including
  `/memories`, quiet-learning status, per-session policy switches, and unified
  workspace/memory/conversation rewind.
- Add application-owned conversation scrolling with pointer and PageUp/PageDown
  navigation while preserving local Thinking and Diff viewports.
- Render submitted prompts immediately, hand presentation to visible queue
  snapshots, and retire local state on durable user-message RPC identity.
- Show explicit checkpoint preview, workspace restore, conversation rewind,
  session reload, and failure rollback progress without unlocking the composer.
- Replace last-turn-only rewind with an instant bounded checkpoint selector,
  keyboard navigation, asynchronous file counts, and selected-node restore.
- Add input history navigation and an optimistic `/clear` session transition
  with failure recovery.
- Replace prompt `Sending`/`Accepted` phases with one animated composer status
  line fixed directly above the editor through Thinking, answers, tool
  execution, and between-step waits, with elapsed time and an interrupt hint.
- Render user-authored messages as full-width, padded transcript blocks with a
  stable `›` anchor so prompts remain visually discoverable in long sessions.
- Report checkpoint file counts per turn instead of cumulative rollback scope,
  and align confirmation with a vertical Claude Code-style choice surface.
- Preserve checkpoints before the restored turn on the forked conversation so
  rewind can be used repeatedly until its retained history is exhausted.

## 0.1.0 - 2026-08-15

- Add the DeepSeek Harness terminal profile bundle and in-process API client.
- Add streaming Markdown, model selection, usage statistics, and interaction dialogs.
- Add mouse-only expandable thinking blocks and Claude Code-style file edit cards.
- Add coordinated last-turn workspace and conversation rewind.

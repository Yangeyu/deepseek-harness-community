# Changelog

All notable changes to this project are documented in this file.

## Unreleased

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

# DeepSeek Harness Community TUI

A keyboard-first terminal client bundle for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This is a private source workspace maintained in the community extension
repository, outside the upstream Harness `packages/` tree:

```text
Workplace/
├── deepseek-harness/            # upstream project
└── deepseek-harness-community/  # launcher, Memory, and TUI
```

Keeping upstream and community code separate makes ownership explicit while
the monorepo gives the launcher and both plugins one tested release unit.

## Current status

The initial terminal client supports:

- creating, resuming, and switching sessions;
- streaming assistant text, reasoning, tool calls, and tool results;
- terminal Markdown rendering for headings, emphasis, lists, links, quotes,
  tables, and fenced code blocks;
- collapsed-by-default thinking blocks with a readable secondary foreground,
  an eight-line viewport, hover highlighting, click-to-toggle, and wheel scrolling;
- Claude Code-style edit cards with exact changed-line counts, contextual lines,
  absolute line numbers when the applied hunk can be located, syntax colors,
  and red/green changed-line backgrounds;
- bounded turn checkpoints with an instant keyboard selector, changed-file
  preview, workspace restore, conversation fork, and original-prompt refill;
- Codex-style full-width user-message blocks with restrained background color,
  internal text padding, a stable `›` anchor, and no persistent speaker labels;
- queueing input while a turn is running and steering the active turn;
- immediate local prompt rendering, one animated working row fixed directly
  above the editor for the full running turn with elapsed time and an interrupt hint,
  authoritative queue presentation, and `rpcId` reconciliation with the
  durable session event;
- cancelling a running turn;
- model and reasoning-effort selection;
- a Codex-style model surface that temporarily replaces the composer and moves
  from model selection to a separate reasoning-effort step;
- approval and structured-question dialogs;
- Markdown-backed global and per-project memory, explicit remember/forget
  tools, quiet correction learning, and a `/memories` management surface;
- reconnect and history resynchronization;
- merged discovery of TUI-local interactions and agent-scoped Harness commands,
  with one catalog driving both autocomplete and `/help`;
- the same durable turn/step timing, decode throughput, cache-hit, token-usage,
  and context-pressure projections shown below the Harness Web composer;
- individually clickable tool calls with bounded Arguments and Result details;
- a responsive `/trajectory` trace explorer with paired turn, step, and tool
  lifecycles, bottleneck timing, and Summary, Input, Output, Schema, and Timing
  inspection; and
- an application-owned transcript viewport with pointer and keyboard scrolling,
  stable history position, and automatic tail following.

The UI follows the low-chrome interaction style of coding-agent terminals, but
it does not copy Claude Code internals. The renderer is
[`@earendil-works/pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui)
behind a transport-neutral controller, so it can be replaced without moving
session logic into UI components.

## Install

The TUI supports DeepSeek Harness `>=0.1.0-rc.6 <0.2.0`. Install the repository's
single public package; its launcher installs Harness and configures this workspace automatically:

```sh
npm install --global @vascent/dsh-tui
dsh-tui
```

The repository commits verified `lib/` artifacts, so installation does not build
this workspace on the target machine. The bundle's `cordis.patch.yml` layers the
required Host services, its `./memory` plugin entry, and the terminal entry point
over the automatically installed `dsh-base` profile. The subpath embeds the
private Memory workspace runtime, so installation has no standalone plugin dependency.

## Develop

```sh
cd ../..
pnpm install --frozen-lockfile
pnpm run check
```

Run the complete profile through the monorepo launcher from the project the
agent should edit:

```sh
pnpm run start
```

## Command-line options

```text
dsh-tui [options]

--resume <session-id>  Resume an existing session
--cwd <path>           Start a new session in this directory
--no-color             Disable ANSI color
-h, --help             Show help
```

After a normal exit, the restored shell prints a copyable
`dsh-tui --resume <session-id>` command for the active session.

## Keyboard and input behavior

| Input | Behavior |
| --- | --- |
| `Enter` | Send while idle; steer while running |
| `Alt+Enter` | Queue explicitly |
| `Esc` | Cancel the active turn |
| `Ctrl+C` | Cancel while running; exit while idle |
| `Ctrl+O` | Toggle expanded tool details |
| `Shift+Tab` | Cycle supported reasoning efforts |
| `↑` / `↓` | Browse previously submitted input while editing |
| `PageUp` / `PageDown` | Scroll conversation history while the editor is empty |
| `Esc Esc` | Open the checkpoint selector; use `↑`/`↓` and `Enter` to inspect a node |

`/trajectory` temporarily replaces the conversation composer with a full-screen,
live execution ledger for the current session. Use `↑`/`↓` or `j`/`k` to select a
semantic event, `Enter` to inspect it, and `Tab` or `←`/`→` to move through Summary,
Input, Output, Schema, and Timing. Each ledger row reserves fixed Start, Time, and
relative Share columns so long titles cannot hide duration; the header and `▲`
marker identify the current bottleneck. `h`/`l` collapses or expands Turn and Step
nodes, while `g`/`G` jumps to the first or last visible record.

At 120 columns or wider, the ledger and selected detail render side by side;
narrow terminals retain the single-pane `Enter`/`Esc` drill-down flow. Summary
wraps the complete semantic text and includes duration, parent share, lifecycle,
location, and sequence information. `PageUp` at the earliest loaded record fetches
an older, message-aligned history page without losing live tail events. `Ctrl+C`
remains an interrupt while the session is running.

The model selector uses `↑`/`↓` (or `1`–`9`) in both the model and reasoning
effort steps. `Enter` advances or applies the complete selection to the current session;
the Harness Host also saves it as the default for new sessions, matching the
current Web client behavior.

Thinking and ordinary tool-call titles highlight on pointer hover and toggle on
click. Tool details show both the recorded Arguments and Result; `Ctrl+O`
remains the keyboard shortcut for expanding or collapsing them together. The
pointer wheel scrolls expanded thinking and long inline diffs inside their
bounded viewports; at a block boundary or over ordinary output, the same wheel
scrolls the conversation. Scrolling upward pauses automatic tail following,
and PageDown or a downward wheel returns to live output. Hold the terminal's
mouse-bypass modifier (usually Shift) when native terminal text selection is
needed.

Rewind snapshots the Git worktree immediately before the first step of each
user-authored turn. `Esc Esc` opens the process-local checkpoint history
immediately; per-turn changed-file counts fill in asynchronously rather than
showing the cumulative rollback scope. `↑`/`↓` selects a prompt node, `Enter`
opens a vertical confirmation with the target prompt and restore impact, and
`Esc` returns to the list or closes it. One confirmation restores the selected
workspace checkpoint, reverts memory writes attributed to that turn and every
later turn, forks the conversation before that turn, and returns the selected
prompt to the editor. Workspace and memory state are compensated if the
conversation fork fails. The implementation never runs `git reset` and never
changes the user's Git index. The history limit defaults to 20 through
`rewindCheckpoints`. Checkpoints before the restored turn follow the forked
conversation, so `Esc Esc` can rewind repeatedly until the retained history is
exhausted. Checkpoints cover Git-tracked plus non-ignored untracked files;
ignored files and submodule contents are outside the current restore scope.

## Memory

Memory is stored as ordinary Markdown under the configured Harness home:

```text
memories/
├── global/MEMORY.md
└── projects/<project-id>/
    ├── MEMORY.md
    └── preferences.md | conventions.md | decisions.md | debugging.md
```

The files are authoritative and may be edited or synchronized like other text
files. Bounded global and project indexes enter the durable session log as a
source-attributed snapshot when first used and whenever their effective content
changes. Disabling memory publishes a replacement marker so earlier snapshots
stop applying. `memory_write`, `memory_read`, and `memory_forget` handle explicit
requests. Turns containing a likely reusable correction are reviewed after the
main Agent becomes idle by a short-lived, logged maintenance Agent restricted
to those memory tools.

`/memories` opens a composer-anchored view for browsing the Markdown files and
turning memory use or background learning on and off for the current session.
The status row shows a separate animation while quiet learning is running.

`/clear` removes the visible conversation synchronously and then attaches a
fresh session; if session creation fails, the previous view is restored. Slash
commands: `/help`, `/clear`, `/new`, `/resume`, `/model`, `/details`, `/status`,
`/trajectory`, `/memories`, `/rewind`, and `/exit`.

## Architecture

```text
Cordis bundle entry
  -> file-backed Memory plugin (context, tools, quiet learner, mutations)
  -> in-process ApiProxy client
     -> HarnessController (session and stream state)
        -> pi-tui application (input, dialogs, unified rewind transaction)
           -> ComposerAnchoredLayout (transcript viewport and tail following)
              -> TranscriptComponent (pure event/view projection)
              -> TrajectoryModel (indexed hierarchy and timing semantics)
                 -> TrajectoryView (paged execution ledger and event inspection)
```

The detailed ownership rules and staged design are recorded in
[`docs/tui-architecture.md`](../../docs/tui-architecture.md).

The TUI consumes tool-provided presentation intent (`generic`, `terminal`,
`diff`, and related cards) rather than branching on tool names. New tools can
therefore add render behavior through Harness's existing presenter extension
point without changing the terminal controller.

Applied diff line numbers are resolved asynchronously against the workspace and
cached outside the renderer. Missing, deleted, or ambiguous historical hunks
still render correctly without inventing an absolute line number.

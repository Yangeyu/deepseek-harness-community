# @yangeyu/deepseek-harness-tui

A keyboard-first terminal client bundle for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This is a third-party integration package. It deliberately lives beside the
Harness checkout instead of under `deepseek-harness/packages/`:

```text
Workplace/
├── deepseek-harness/       # upstream project
├── deepseek-harness-memory/ # file-backed Memory plugin
└── deepseek-harness-tui/    # this package
```

Keeping the repositories separate makes the ownership boundary explicit and
lets the TUI follow Harness through its public plugin and ApiProxy interfaces.

## Current status

The initial terminal client supports:

- creating, resuming, and switching sessions;
- streaming assistant text, reasoning, tool calls, and tool results;
- terminal Markdown rendering for headings, emphasis, lists, links, quotes,
  tables, and fenced code blocks;
- collapsed-by-default thinking blocks with an eight-line viewport, foreground
  hover highlighting, click-to-toggle, and wheel scrolling;
- Claude Code-style edit cards with exact changed-line counts, contextual lines,
  absolute line numbers when the applied hunk can be located, syntax colors,
  and red/green changed-line backgrounds;
- bounded turn checkpoints with an instant keyboard selector, changed-file
  preview, workspace restore, conversation fork, and original-prompt refill;
- Codex-style full-width user-message blocks with restrained background color,
  a stable `›` anchor, and no persistent speaker labels;
- queueing input while a turn is running and steering the active turn;
- immediate local prompt rendering, one animated working row that remains
  visible for the full running turn with elapsed time and an interrupt hint,
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
- the same durable turn/step timing, decode throughput, cache-hit, token-usage,
  and context-pressure projections shown below the Harness Web composer;
- bounded tool output with expandable details; and
- an application-owned transcript viewport with pointer and keyboard scrolling,
  stable history position, and automatic tail following.

The UI follows the low-chrome interaction style of coding-agent terminals, but
it does not copy Claude Code internals. The renderer is
[`@earendil-works/pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui)
behind a transport-neutral controller, so it can be replaced without moving
session logic into UI components.

## Install

The package supports DeepSeek Harness `>=0.1.0-rc.5 <0.2.0`. Install the tagged
GitHub release directly into a `tui` profile, then start it:

```sh
dsh plugin --profile tui add github:Yangeyu/deepseek-harness-tui#v0.1.0
dsh --profile tui
```

The repository commits its verified `lib/` artifacts, so installing from a tag
does not run a package build on the target machine. To install the downloadable
release tarball instead:

```sh
dsh plugin --profile tui add ./yangeyu-deepseek-harness-tui-0.1.0.tgz
dsh --profile tui
```

The bundle's `cordis.patch.yml` layers the required Host services, its
`./memory` plugin entry, and the terminal entry point over the automatically
installed `dsh-base` profile. The subpath keeps Cordis resolution anchored to
the directly installed TUI package while delegating implementation to the
standalone `@yangeyu/deepseek-harness-memory` dependency.

## Develop

```sh
pnpm install --frozen-lockfile
pnpm run check
```

For unreleased local development, clone `deepseek-harness-memory` beside this
repository before installing dependencies. Then run the complete profile from
a neighboring Harness checkout:

```sh
cd ../deepseek-harness
pnpm dsh plugin --profile tui add ../deepseek-harness-tui
pnpm dsh --profile tui
```

## Command-line options

```text
dsh --profile tui [options]

--resume <session-id>  Resume an existing session
--cwd <path>           Start a new session in this directory
--no-color             Disable ANSI color
-h, --help             Show help
```

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

The model selector uses `↑`/`↓` (or `1`–`9`) in both the model and reasoning
effort steps. `Enter` advances or applies the complete selection to the current session;
the Harness Host also saves it as the default for new sessions, matching the
current Web client behavior.

Thinking blocks highlight on pointer hover and toggle on click. The pointer
wheel scrolls expanded thinking and long inline diffs inside their bounded
viewports; at a block boundary or over ordinary output, the same wheel scrolls
the conversation. Scrolling upward pauses automatic tail following, and
PageDown or a downward wheel returns to live output. Hold the terminal's
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
`/memories`, `/rewind`, and `/exit`.

## Architecture

```text
Cordis bundle entry
  -> file-backed Memory plugin (context, tools, quiet learner, mutations)
  -> in-process ApiProxy client
     -> HarnessController (session and stream state)
        -> pi-tui application (input, dialogs, unified rewind transaction)
           -> ComposerAnchoredLayout (transcript viewport and tail following)
              -> TranscriptComponent (pure event/view projection)
```

The TUI consumes tool-provided presentation intent (`generic`, `terminal`,
`diff`, and related cards) rather than branching on tool names. New tools can
therefore add render behavior through Harness's existing presenter extension
point without changing the terminal controller.

Applied diff line numbers are resolved asynchronously against the workspace and
cached outside the renderer. Missing, deleted, or ambiguous historical hunks
still render correctly without inventing an absolute line number.

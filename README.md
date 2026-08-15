# @yangeyu/deepseek-harness-tui

A keyboard-first, scrollback-preserving terminal client bundle for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This is a third-party integration package. It deliberately lives beside the
Harness checkout instead of under `deepseek-harness/packages/`:

```text
Workplace/
├── deepseek-harness/       # upstream project
└── deepseek-harness-tui/   # this package
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
- last-turn rewind with a changed-file checkpoint preview, workspace restore,
  conversation fork, and original-prompt refill;
- Codex-style user prompts with highlighted foreground text, a `›` marker, and
  no persistent speaker labels;
- queueing input while a turn is running and steering the active turn;
- cancelling a running turn;
- model and reasoning-effort selection;
- a Codex-style model surface that temporarily replaces the composer and moves
  from model selection to a separate reasoning-effort step;
- approval and structured-question dialogs;
- reconnect and history resynchronization;
- the same durable turn/step timing, decode throughput, cache-hit, token-usage,
  and context-pressure projections shown below the Harness Web composer;
- bounded tool output with expandable details; and
- terminal scrollback instead of an alternate-screen application.

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

The bundle's `cordis.patch.yml` layers the required Host services and terminal
entry point over the automatically installed `dsh-base` profile.

## Develop

```sh
pnpm install --frozen-lockfile
pnpm run check
```

For a local end-to-end run from a neighboring Harness checkout:

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
| `Esc Esc` | Preview and confirm the last-turn workspace and conversation rewind |

The model selector uses `↑`/`↓` (or `1`–`9`) in both the model and reasoning
effort steps. `Enter` advances or applies the complete selection to the current session;
the Harness Host also saves it as the default for new sessions, matching the
current Web client behavior.

Thinking blocks highlight on pointer hover and toggle on click. The pointer
wheel scrolls expanded thinking and long inline diffs inside their bounded
viewports. Mouse tracking keeps keyboard focus in the editor and preserves the
main-screen scrollback model; hold the terminal's mouse-bypass modifier (usually
Shift) when native terminal text selection is needed.

Rewind snapshots the Git worktree immediately before the first step of each
user-authored turn. `Esc Esc` shows the changed paths and line counts, then one
confirmation restores the checkpoint, forks the conversation before that turn,
and returns the original prompt to the editor. The implementation never runs
`git reset` and never changes the user's Git index. Checkpoints are process-local
and cover Git-tracked plus non-ignored untracked files; ignored files and
submodule contents are outside the current restore scope.

Slash commands: `/help`, `/new`, `/resume`, `/model`, `/details`, `/status`,
`/rewind`, and `/exit`.

## Architecture

```text
Cordis bundle entry
  -> in-process ApiProxy client
     -> HarnessController (session and stream state)
        -> pi-tui application (input, dialogs, rendering)
           -> TranscriptComponent (pure event/view projection)
```

The TUI consumes tool-provided presentation intent (`generic`, `terminal`,
`diff`, and related cards) rather than branching on tool names. New tools can
therefore add render behavior through Harness's existing presenter extension
point without changing the terminal controller.

Applied diff line numbers are resolved asynchronously against the workspace and
cached outside the renderer. Missing, deleted, or ambiguous historical hunks
still render correctly without inventing an absolute line number.

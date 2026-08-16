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
the monorepo gives the launcher and private workspaces one tested release unit.

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
- a scoped `/config` center for model, reasoning, permissions, Plan Mode,
  Vision, and terminal display preferences, plus a separate `/task` surface for durable
  Goals, read-only Todos, and runtime actions;
- effective Skill discovery and canonical `/name` invocation through the Slash
  catalog, plus a searchable `/skills` browser and safe project/user authoring;
- the same durable turn/step timing, decode throughput, cache-hit, token-usage,
  and context-pressure projections on the second composer footer row;
- individually clickable tool calls with bounded Arguments and Result details;
- a responsive `/trajectory` trace explorer with paired turn, step, and tool
  lifecycles, bottleneck timing, and Summary, Input, Output, Schema, and Timing
  inspection; and
- explicit image drafts from files or the macOS clipboard, automatic native
  multimodal routing, and a configurable DashScope proxy for text-only models;
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

The release pipeline builds verified `dist/` artifacts before packaging, so
installation does not build this workspace on the target machine. Generated
artifacts are not committed. The bundle's `cordis.patch.yml` layers the required
Host services, its `./memory` plugin entry, and the terminal entry point over the
automatically installed `dsh-base` profile. The subpath embeds the private Memory
workspace runtime, so installation has no standalone plugin dependency.

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
-i, --image <path>     Attach an image at startup; repeat for multiple images
--no-color             Disable ANSI color
-h, --help             Show help
```

After a normal exit, the restored shell prints a copyable
`dsh-tui --resume <session-id>` command for the active session.

## Keyboard and input behavior

| Input | Behavior |
| --- | --- |
| `Enter` | Send while idle; steer while running |
| `Tab` | Queue explicitly while a turn is running |
| `Alt+Enter` | Insert a newline with the default keymap |
| `Esc` | Cancel Vision analysis or the active turn |
| `Ctrl+V` | Attach the current macOS clipboard image |
| `Alt+A` | Focus and manage the attachment rail |
| `Alt+Backspace` | Remove the latest image draft |
| `Ctrl+C` | Cancel while running; exit while idle |
| `Ctrl+O` | Toggle expanded tool details |
| `Shift+Tab` | Cycle supported reasoning efforts |
| `↑` / `↓` | Browse previously submitted input while editing |
| `PageUp` / `PageDown` | Scroll conversation history while the editor is empty |
| `Esc Esc` | Open the checkpoint selector; use `↑`/`↓` and `Enter` to inspect a node |

Open `/keymap` or `/config keybindings` to switch the persistent TUI keymap.
The default Standard preset follows the running-turn `Enter`/`Tab` interaction
while preserving `Alt+Enter` for multiline input. The Legacy preset restores
`Alt+Enter` queueing only while a turn is running, so idle multiline input
remains available. Keymap resolution is context-aware; idle `Tab` still belongs
to the editor and autocomplete.

The first fixed-footer row intentionally shows only the active provider/model
and reasoning effort. Shortcut discovery belongs to `/keymap`; the existing
session and model metrics remain visible on the second footer row.

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

`/config` is the unified configuration entry for the active session and TUI.
It shows Model, Reasoning, Permission, Plan Mode, Vision, Keybindings, and Details with an explicit
`Session` or `TUI` scope. `/task` owns the current Goal, read-only Todo progress,
and runtime cancellation. Both surfaces use `j`/`k`, arrows, `g`/`G`, `Enter`,
and `Esc`, and neither retains a second copy of Host state.

Permission widening to `danger-full-access` requires an explicit confirmation,
pending Plan state is distinct from effective state, and Goal mutations use the
projected compare-and-set revision.

Bare `/permission` opens the same Permission selector directly. An argued
`/permission <preset>`, Plan actions, and every other discovered Host Command
execute through the Host command registry rather than model prompting. Known
Commands therefore never appear as user/assistant conversation messages.

## Vision input

Use repeatable `-i`/`--image <path>` at startup, `/attach <path>` while the TUI
is open, `/paste-image` for the macOS clipboard, or `Ctrl+V` (`Alt+V` remains a
compatibility alias). Drafts stay in memory above the editor until Host
admission succeeds. Press `Alt+A` to focus the rail, then use `h`/`l` or arrows
to select, `Delete` to remove, and `Esc` to return to the editor.

In Auto mode, a model that explicitly declares image input receives the image
natively. A text-only or unknown route uses the configured Vision proxy and
receives only a bounded, source-attributed, untrusted observation. Missing
capability, credentials, validation, or provider success retains both the text
and drafts instead of silently sending an image-less prompt.

For the recommended Alibaba Cloud Bailian route:

```sh
export DASHSCOPE_API_KEY='...'
dsh-tui
```

Then open `/config vision` (or `/vision`), select “Configure recommended
DashScope route,” and confirm. The settings reference `DASHSCOPE_API_KEY`; the
secret value is not copied into configuration or session events. Completed
proxy analyses appear after their user prompt as expandable Vision cards and
timed `/trajectory` records. Pre-submission failures retain the draft and stay
out of conversation history.

`/skills` lists effective user-invocable Skills for the current session. Use
`j`/`k` to navigate, `Enter` to insert the canonical `/name ` gesture, `l` for
details, `/` to filter, `n` to create, `e` to edit a local definition, and `r`
to refresh. New Skills use either `<project>/.dsh/skills/<name>/SKILL.md` or
`$DSH_HOME/skills/<name>/SKILL.md`. `$VISUAL` and `$EDITOR` are preferred for
editing; terminal ownership is restored after exit, and the resulting file is
validated before its effective catalog status is reported.

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
commands: `/help`, `/clear`, `/new`, `/resume`, `/model`, `/attach`,
`/paste-image`, `/vision`, `/keymap`, `/details`, `/status`, `/config`, `/task`, `/skills`,
`/trajectory`, `/memories`, `/rewind`, and `/exit`.

## Architecture

```text
Cordis bundle entry
  -> file-backed Memory plugin (context, tools, quiet learner, mutations)
  -> Vision plugin (routing, proxy analysis, observation staging, events)
  -> in-process ApiProxy client
     -> application/ (bootstrap orchestration and local interactions)
        ├─ input/ (semantic keymap actions and context-aware binding resolution)
        ├─ runtime/ (controller, scoped session selectors, Slash and Skill catalogs)
        ├─ trajectory/ (semantic hierarchy, timing, and trace view)
        └─ presentation/ (config/task/skill surfaces, transcript, diffs, and dialogs)
```

The detailed ownership rules and staged design are recorded in
[`docs/tui-architecture.md`](../../docs/tui-architecture.md).
The product sequence and next-version interaction contracts are recorded in
[`docs/tui-product-roadmap.md`](../../docs/tui-product-roadmap.md) and
[`docs/tui-v0.1.7-design.md`](../../docs/tui-v0.1.7-design.md).

The TUI consumes tool-provided presentation intent (`generic`, `terminal`,
`diff`, and related cards) rather than branching on tool names. New tools can
therefore add render behavior through Harness's existing presenter extension
point without changing the terminal controller.

Applied diff line numbers are resolved asynchronously against the workspace and
cached outside the renderer. Missing, deleted, or ambiguous historical hunks
still render correctly without inventing an absolute line number.

# DeepSeek Harness Community TUI

A keyboard-first terminal client bundle for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This workspace owns a public API within the community extension repository,
outside the upstream Harness `packages/` tree:

```text
Workplace/
├── deepseek-harness/            # upstream project
└── deepseek-harness-community/  # launcher, Memory, and TUI
```

Keeping upstream and community code separate makes ownership explicit. The
workspace is not published independently; its API is bundled into the single
`@vascent/dsh-tui` release artifact.

## Current status

The initial terminal client supports:

- creating, resuming, and switching sessions;
- streaming assistant text, reasoning, tool calls, and tool results;
- terminal Markdown rendering for headings, emphasis, lists, links, quotes,
  tables, and fenced code blocks;
- collapsed-by-default Activity groups for adjacent thinking and ordinary tool
  calls, with stable live summaries, nested details, failure expansion, and
  bounded reasoning viewports;
- Claude Code-style edit cards with exact changed-line counts, contextual lines,
  absolute line numbers when the applied hunk can be located, syntax colors,
  and red/green changed-line backgrounds;
- bounded source-attributed Rewind history with exact AI-owned file plans,
  conflict protection, workspace restore, conversation fork, and prompt refill;
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
- a composer-anchored approval decision dock and structured-question dialogs;
- Markdown-backed global and per-project memory, explicit remember/forget
  tools, quiet correction learning, and a `/memories` management surface;
- reconnect and history resynchronization;
- merged discovery of TUI-local interactions and agent-scoped Harness commands,
  with one catalog driving both autocomplete and `/help`;
- fuzzy `@path` references for ignored-aware workspace files and directories,
  with quoted insertion for paths containing spaces;
- a scoped `/config` center for model, reasoning, permissions, Plan Mode,
  Vision, persistent Web provider selection, and terminal display preferences, plus a separate `/task` surface for durable
  Goals, read-only Todos, and runtime actions;
- effective Skill discovery and canonical `/name` invocation through the Slash
  catalog, plus a searchable `/skills` browser and safe project/user authoring;
- the same durable turn/step timing, decode throughput, cache-hit, token-usage,
  and context-pressure projections on the second composer footer row;
- compact, expandable Activity segments for adjacent thinking and non-diff
  tools, while applied file changes stay in the main conversation timeline;
- individually clickable tool calls with bounded Arguments and Result details;
- a responsive `/trajectory` trace explorer backed by the shared turn, step,
  and tool lifecycle snapshot, with bottleneck timing plus Summary, Input,
  Output, Schema, and Timing inspection;
- explicit image drafts from files or the macOS clipboard, automatic native
  multimodal routing, and a configurable DashScope proxy for text-only models;
- official `web_search` with automatic or explicit DeepSeek/Tavily selection,
  plus provider-neutral Tavily-backed `web_extract`;
- an application-owned transcript viewport with pointer and keyboard scrolling,
  stable history position, and automatic tail following.

The UI follows the low-chrome interaction style of coding-agent terminals, but
it does not copy Claude Code internals. The renderer is
[`@earendil-works/pi-tui`](https://github.com/earendil-works/pi-mono/tree/main/packages/tui)
behind a transport-neutral controller, so it can be replaced without moving
session logic into UI components.

## Install

The TUI supports DeepSeek Harness `>=0.1.0-rc.6 <0.2.0`. Install the repository's
single public package; its launcher installs Harness and configures this
workspace automatically:

```sh
npm install --global @vascent/dsh-tui
dsh-tui
```

The release pipeline builds verified `dist/` artifacts before packaging, so
installation does not build this workspace on the target machine. Generated
artifacts are not committed. The bundle's `cordis.patch.yml` layers the required
Host services, its bundled `./memory`, `./vision`, and `./web` entries, and the terminal
entry point over the automatically installed `dsh-base` profile. Library and
Cordis consumers use the public `@vascent/dsh-tui/tui`,
`@vascent/dsh-tui/memory`, `@vascent/dsh-tui/vision`, and
`@vascent/dsh-tui/web` subpaths from the same
installation.

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
dsh-tui [options] [prompt...]
dsh-tui resume <session-id> [options] [prompt...]
dsh-tui resume --last [options] [prompt...]
dsh-tui sessions [list] [--json]
dsh-tui exec [-C <path>] [prompt...]
dsh-tui doctor [--json]
dsh-tui completion <bash|zsh|fish|powershell>
dsh-tui config [show|default]
dsh-tui plugin <pnpm-args...>
dsh-tui -v | -V | --version
```

Interactive options include `-C`/`--cwd`, repeatable `-i`/`--image`,
`-m`/`--model`, `--effort`, `--permission-mode`, `--plan`, `--no-color`, and
repeatable launcher-owned `--patch` overlays. A positional prompt is submitted
after the session, startup settings, and image drafts are ready.

`--resume <session-id>` remains a compatibility form. `sessions` is a
non-interactive Host query; `exec` uses the Harness headless profile and accepts
a positional prompt or piped stdin. `doctor` is read-only, while `config` and
`plugin` explicitly delegate to the Harness profile manager.
`-v`, `-V`, and `--version` print the public root package version without
initializing the TUI profile.

After a normal exit, the restored shell prints a copyable
`dsh-tui resume <session-id>` command for the active session.

## Keyboard and input behavior

| Input | Behavior |
| --- | --- |
| `Enter` | Send while idle; steer while running |
| `Tab` | Queue explicitly while a turn is running |
| `Alt+Enter` | Insert a newline with the default keymap |
| `Esc` | Dismiss the active composer layer, cancel active work, or clear and retain idle text and images |
| `Ctrl+V` | Attach the current macOS clipboard image |
| `Alt+A` | Focus and manage the attachment rail |
| `Alt+Backspace` | Remove the latest image draft |
| `@` | Find and insert a file or directory reference from the active workspace |
| `Ctrl+C` | Cancel while running; exit while idle |
| `Ctrl+O` | Toggle all Activity details |
| `Shift+Tab` | Cycle supported reasoning efforts |
| `↑` / `↓` | Restore/hide the last Esc-cleared text-and-image draft, then browse submitted input history |
| `PageUp` / `PageDown` | Scroll conversation history while the editor is empty |
| `Esc Esc` | Open Rewind history after two physical key presses; use `↑`/`↓` and `Enter` to inspect a Prompt boundary |

Open `/keymap` or `/config keybindings` to switch the persistent TUI keymap.
The default Standard preset follows the running-turn `Enter`/`Tab` interaction
while preserving `Alt+Enter` for multiline input. The Legacy preset restores
`Alt+Enter` queueing only while a turn is running, so idle multiline input
remains available. Keymap resolution is context-aware; idle `Tab` still belongs
to the editor and autocomplete.

Typing `@` at a token boundary opens a fuzzy workspace-path picker. Continue
typing to filter, use `↑`/`↓` to move, and confirm with `Enter` or `Tab`. Files
are inserted as `@relative/path `; directories remain open-ended so another
path segment can be selected. Paths containing spaces are quoted. The visible
reference stays in the prompt, and the Agent resolves it against the active
working directory before reading it with workspace tools. Raster image
references use native `read_image` when the active model accepts images, or the
proxy-backed `inspect_image` fallback on text-only routes. The picker grows
upward so filtering candidates does not move the input frame or footer.

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
It shows Model, Reasoning, Permission, Plan Mode, Vision, Web, Keybindings, and
Details with an explicit `Session` or `TUI` scope. `/task` owns the current Goal,
read-only Todo progress, and runtime cancellation. Both surfaces use `j`/`k`,
arrows, `g`/`G`, `Enter`, and `Esc`, and neither retains a second copy of Host
state.

Permission widening to `danger-full-access` requires an explicit confirmation,
pending Plan state is distinct from effective state, and Goal mutations use the
projected compare-and-set revision.

Bare `/permission` opens the same Permission selector directly. An argued
`/permission <preset>`, Plan actions, and every other discovered Host Command
execute through the Host command registry rather than model prompting. Known
Commands therefore never appear as user/assistant conversation messages.

## Web access

The profile retains the official Harness `ctx.web` registry and official
`web_search` model tool, but permanently selects one `community-web` policy
provider. That provider routes each search to the persisted concrete provider
or uses `auto`, which chooses the highest-priority locally ready registration
before the request starts. It never retries another provider after dispatch.
`/config web` renders the provider registry and applies selection live, so a new
provider registration needs no Profile, router, or UI branch.

The community package also owns a separate provider-neutral `web_extract`
capability backed by Tavily. Extraction is not presented as official
`web_fetch`: Tavily returns readable content but not the origin response status
required by the upstream fetch contract. Tavily search and extraction share
authentication, cancellation, and error mapping but retain independent request
and result contracts.

Set a Tavily credential to make it the preferred automatic search route and to
enable page reading. Without it, automatic search uses a ready lower-priority
provider such as DeepSeek Official:

```sh
export TAVILY_API_KEY='...'
dsh-tui
```

`/config web` (or `/web`) selects the search policy and displays every registered
provider, endpoint host, and credential source/status. It never reads or renders a credential value. Keys
are resolved through the Harness credential service for every operation, so
rotation applies to the next call without a profile restart. Search results are
bounded and normalized into citeable URLs; page content is remotely extracted,
bounded again before model presentation, and has no implicit retry or fallback.

## Vision input

Use repeatable `-i`/`--image <path>` at startup, `/attach <path>` while the TUI
is open, `/paste-image` for the macOS clipboard, or `Ctrl+V` (`Alt+V` remains a
compatibility alias). Drafts stay in memory above the editor until Host
admission succeeds. Idle `Esc` clears text and images as one recoverable
Composer draft; `↑` restores both. Press `Alt+A` to focus the rail, then use
`h`/`l` or arrows to select, `Delete` to remove, and `Esc` to return to the
editor.

In Auto mode, a model that explicitly declares image input receives the image
natively. A text-only or unknown route uses the configured Vision proxy and
receives only a bounded, source-attributed, untrusted observation. Missing
capability, credentials, validation, or provider success retains both the text
and drafts instead of silently sending an image-less prompt.

The same proxy is available to the Agent as `inspect_image`. It reads only a
regular PNG, JPEG, WebP, or GIF whose resolved identity remains inside the
active workspace, enforces the attachment byte and media limits, and returns
text-only untrusted evidence. This makes `@image-path` references and image
paths discovered in files usable even when the active model is text-only.

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

Adjacent Thinking and ordinary tool calls form one collapsed Activity group.
Click its summary to reveal the ordered child titles, then click a child to
inspect bounded reasoning or the recorded Arguments and Result. Successful
groups stay compact, live groups expose their latest action in the summary, and
failed groups open to the failed child by default without preventing a manual
collapse. A terminal turn marks unresolved work as interrupted instead of
leaving stale live output. When answer text starts streaming, its preceding
Thought settles immediately. Thought, tool, and Diff titles share `◦` running,
`•` completed, `×` failed, and `!` interrupted status glyphs. File edits are
hard Activity boundaries: returned Diff evidence remains a top-level
conversation card regardless of execution status and opens by default.
`Ctrl+O` expands or collapses Activity, Thought, and tool details together.
The pointer wheel scrolls expanded thinking inside its bounded viewport. File
diffs render inline without a nested scroll window, so the wheel over them and
ordinary output scrolls the conversation. Scrolling upward pauses automatic
tail following, and PageDown or a downward wheel returns to live output. Drag
directly across rendered TUI text to select it; the selected
cells are highlighted and copied to the system clipboard when the primary
button is released. A primary-button gesture toggles a block only when it did
not form a text selection. Platform clipboard commands are preferred locally,
with OSC 52 as the remote-terminal fallback; Shift remains available only when
terminal-native selection is explicitly desired.

Rewind registers a boundary from the durable user message accepted into each
user-authored turn. Text, native-image, and proxy-image submissions follow the
same Prompt lifecycle; Vision preparation never decides whether a boundary
exists. It does not diff or snapshot the Git worktree. The filesystem adapter
correlates an authoritative `fs/observed` event with the same
execution's canonical `before`/`after` result, so the history counts only file
mutations that can be attributed to this Agent call. Files edited by another
window are not listed and are never restored merely because they changed
during the turn. A successful attributed edit remains reversible when its
canonical local target is outside the session workspace; the original
filesystem authorization controls the edit, while the explicit Rewind
confirmation controls its restoration.

Steering messages remain first-class `in-turn` Prompt lifecycle nodes, but are
not listed as Rewind points: the current Host conversation API can restore only
completed-turn boundaries. The adapter makes that capability boundary explicit
rather than presenting a steer that cannot be restored faithfully.

`Esc Esc` and `/rewind` enter the same Rewind workflow over Prompt boundaries
rebuilt from the active Host Session log. A newly opened or resumed conversation
therefore has checkpoints as soon as it has accepted user turns; visibility does
not depend on which session owns reversible file effects. Key release and repeat
events do not count as the second Esc press. `Enter` prepares a stale-guarded reverse plan
for the selected turn and every later turn. Exact matches are `safe`;
non-overlapping later edits are `mergeable` and preserved;
overlapping edits are `conflict`; provider outcomes without a reversible
before-state are `unsupported`. The confirmation lists the exact affected paths
and independently offers **Restore code and conversation**, **Restore
conversation only**, and **Restore code only**. Conversation-only remains
available when code restore is blocked or no source-attributed code state is
retained. Restoring conversation forks at the checkpoint and refills the
selected Prompt's text and attached images; restoring code reverts only the
listed AI-owned text and corresponding Memory mutations, including listed
external local paths. Attachments are
verified from their durable Host references before a conversation restore;
missing image data therefore cannot produce a partial restore. Workspace and
Memory changes are compensated if a later conversation phase fails. Native
filesystem calls that do not publish the semantic mutation
contract, including arbitrary shell-side edits, are deliberately excluded
rather than guessed. The history limit defaults to 20 through `rewindHistory`;
earlier boundaries follow the forked conversation for repeated Rewind. A
proxy-image prompt appears once; its Vision observation is execution detail,
not a second checkpoint. Native image blocks and proxy Vision evidence enrich
the same retained Prompt input. Evidence carries the admitted Prompt identity,
so delayed events cannot attach an image to a nearby user message.

The active reversible-effect timeline survives TUI shutdown under
`$DSH_HOME/rewind/v2`, so `dsh-tui --resume <session-id>` can Rewind attributed
edits made before restart while Prompt visibility continues to come from the
Session log. Storage is scoped to one canonical workspace lineage, uses
private versioned manifests and content-addressed objects, and is bounded to 16
MiB per object, 64 MiB per timeline, and 512 MiB globally. Invalid history is
quarantined. Opening another session never hides its Prompt checkpoints and does
not take effect ownership until that session produces its first attributed edit.
The workspace key owns timeline persistence only; each mutation retains its own
canonical absolute filesystem identity, so one restore transaction can safely
span multiple local roots. Schema 2 relative mutation paths are migrated on
load.

After a code-and-conversation Rewind, the forked session owns a code/effect
cursor before the selected turn. Code-only restore moves the same cursor without
forking; conversation-only restore forks without moving it. A retained future
code segment is discarded only when a new attributed branch replaces it. This
release exposes backward code restore only; a forward checkpoint remains
available for conversation-only restore and reports that forward code restore
is not implemented yet.

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
`/paste-image`, `/vision`, `/web`, `/keymap`, `/details`, `/status`, `/config`,
`/task`, `/skills`, `/trajectory`, `/memories`, `/rewind`, and `/exit`.

## Architecture

```text
Cordis bundle entry
  -> file-backed Memory plugin (context, tools, quiet learner, mutations)
  -> Vision plugin (routing, proxy analysis, observation staging, events)
  -> Web plugin (registry-driven search policy + Tavily extraction)
  -> in-process ApiProxy client
     -> application/ (bootstrap orchestration and local interactions)
        ├─ input/ (semantic keymap actions and context-aware binding resolution)
        ├─ runtime/ (controller, one execution lifecycle, scoped selectors, catalogs)
        ├─ trajectory/ (semantic hierarchy, timing, and trace view)
        └─ presentation/ (config/task/skill surfaces, transcript, diffs, and dialogs)
```

The detailed ownership rules and staged design are recorded in
[`docs/tui-architecture.md`](../../docs/tui-architecture.md).
The product sequence and implemented `v0.1.8` lifecycle contracts are recorded in
[`docs/tui-product-roadmap.md`](../../docs/tui-product-roadmap.md) and
[`docs/tui-v0.1.8-design.md`](../../docs/tui-v0.1.8-design.md).

The TUI consumes tool-provided presentation intent (`generic`, `terminal`,
`diff`, and related cards) rather than branching on tool names. New tools can
therefore add render behavior through Harness's existing presenter extension
point without changing the terminal controller.

Applied diff line numbers are resolved asynchronously against the workspace and
cached outside the renderer. Missing, deleted, or ambiguous historical hunks
still render correctly without inventing an absolute line number.

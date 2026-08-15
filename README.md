# deepseek-harness-tui

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
- Codex-style user prompts with a bold `›` marker and no persistent speaker labels;
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

`Rewind Last Turn` is intentionally not marked complete. Harness already
provides session forking, but a safe implementation also needs an authoritative
file checkpoint/restore capability. Until that capability exists, `/rewind`
reports the missing dependency rather than approximating restoration with
`git reset` or another destructive repository-wide command.

## Local development install

The package currently targets Harness `0.1.0-rc.5`. Those package versions are
linked to the sibling checkout through the development-only `pnpm.overrides`
table in `package.json`.

```sh
cd /Users/yang/Workplace/deepseek-harness-tui
pnpm install
pnpm run check

cd /Users/yang/Workplace/deepseek-harness
pnpm dsh plugin --profile tui add ../deepseek-harness-tui
pnpm dsh --profile tui
```

After compatible Harness packages are published, remove the local link
overrides and install the package by registry name:

```sh
dsh plugin --profile tui add deepseek-harness-tui
dsh --profile tui
```

The bundle's `cordis.patch.yml` layers the required Host services and terminal
entry point over the automatically installed `dsh-base` profile.

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
| `Esc Esc` | Request last-turn rewind; currently reports the missing checkpoint provider |

The model selector uses `↑`/`↓` (or `1`–`9`) in both the model and reasoning
effort steps. `Enter` advances or applies the complete selection to the current session;
the Harness Host also saves it as the default for new sessions, matching the
current Web client behavior.

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

## Rewind completion criteria

The final single rewind action must perform one coordinated operation:

1. verify that the active turn is idle and identify the last direct user turn;
2. restore only file mutations owned by that turn, with stale-content checks;
3. fork the conversation immediately before that user message;
4. switch the TUI to the fork and refill the original prompt; and
5. leave the source session unchanged as the recovery path.

If file restoration cannot complete, the conversation must not fork. This is
why the current client does not expose a conversation-only rewind as a separate
feature.

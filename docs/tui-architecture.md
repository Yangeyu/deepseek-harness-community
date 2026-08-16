# TUI Architecture

The terminal is another client surface for the DeepSeek Harness runtime. It
does not own a second agent loop or a second durable representation of session
state.

## Boundaries

```text
Harness Host
  session log · projections · LLM · attachments · commands · tools · persistence
      │
      ├── Vision service (routing · proxy analysis · staged evidence)
      │
      │ transport-neutral ApiProxy plus narrow Command/Memory/Vision ports
      ▼
Terminal runtime
  HarnessController · semantic keymap · submission coordinator · Slash/Skill catalogs · trajectory model
      │
      │ immutable-by-convention state and semantic records
      ▼
pi-tui presentation
  transcript · config/task/skill surfaces · trajectory view · composer · dialogs
```

The Host owns durable domain facts. The terminal runtime owns connection,
paging, semantic indexing, and interaction state. Presentation code owns only
layout, colors, focus, keyboard handling, pointer handling, and scrolling.

## Source layout

```text
src/
├── application/   # composition, configuration, and top-level UI orchestration
├── input/         # semantic actions, keymap presets, and context-aware resolution
├── runtime/       # transport-neutral session, control, submission, Slash, and Skill state
├── trajectory/    # trace records, hierarchy, timing, and interaction view
├── presentation/  # pi-tui components, dialogs, diffs, layout, and theme
├── checkpoint.ts  # process-local compatibility domain awaiting Host ownership
├── text.ts        # terminal-safety boundary shared across presentation modules
└── index.ts       # stable public and Cordis plugin entry point
```

Tests mirror these directories. A module stays at the root when it is both
small and cross-cutting; directories express ownership rather than merely
reducing the number of visible files.

## Invariants

1. The session event log is the durable source of truth. Reconnect and history
   replacement must rebuild the same semantic state.
2. Whole-log domain values come from Harness projections. A TUI component must
   not independently refold token, timing, goal, or memory state when a
   projection owns it.
3. Tool cards consume `HistoryEntry.view`; the terminal does not branch on
   concrete tool names.
4. TUI-local and Host Commands plus user-invocable Skills share one typed Slash
   catalog. Commands win collisions and execute through `ctx.commands.execute`;
   exact Skills remain ordinary Host-owned prompts; unknown leading gestures
   are rejected after catalog refresh. A known Command never degrades to model
   input.
5. Paired lifecycle events produce one semantic node. This applies to
   turn/start-end, step/start-end, tool/call-result, and command/run-done.
   Command nodes remain standalone because their lifecycle is explicitly not
   wrapped by a turn, even when their events arrive during active work. A
   `turn/end` also closes unmatched streaming or tool children as failed or
   interrupted; terminal history never remains visually live. During a live
   assistant step, the first answer text chunk completes the preceding Thought
   immediately instead of waiting for the final assistant message.
6. Recorded timing is authoritative. Pending records may use the current render
   clock, but completed records never infer timestamps that are absent.
7. Stable semantic keys preserve selection across live replacement and history
   paging. UI row indexes are not identities.
8. Image bytes become durable only through the Harness attachment service.
   Proxy observations are source-attributed context, never rewritten as human
   text, and a missing Vision capability never silently drops an attachment.
9. Raw terminal sequences resolve to semantic actions before application
   behavior runs. Context owns gesture availability: idle editor input is never
   consumed by a running-turn binding, and persisted keymap choices contain no
   task or session state.
10. Kitty repeat and release events are consumed without emitting another
    semantic action. Asynchronous clipboard intake is single-flight, so one
    physical paste cannot create duplicate drafts even when a terminal emits
    more than one matching sequence.
11. Transcript Activity groups are a replayable presentation projection, not a
   session event. Only adjacent reasoning and non-diff tool nodes group
   together. Prompts, assistant text, Commands, errors, notices, and file diffs
   are hard boundaries. Returned file Diff evidence remains top-level
   regardless of execution status. Thought, tool, Diff, and Activity summaries
   consume one shared running/completed/failed/interrupted state model.
12. Memory, Vision, and TUI remain independent implementations but use the same
    lifecycle conventions: stable identity, monotonic terminal state, explicit
    recorded boundaries, explicit failure, snapshot-before-notify publication,
    and symmetric cleanup. Domain packages never import terminal lifecycle or
    renderer types. This is a behavioral convention, not a requirement for
    identical state enums: Memory activity remains a domain status signal until
    it owns a stable Job identity, while Vision exposes stable analysis facts
    for the TUI adapter.

## Transcript interaction contract

- One execution vocabulary drives Activity, Thought, tool, and Diff status.
  Renderers consume the projected status; they do not reinterpret event
  completion independently.
- One child-disclosure state controls Thought and tool details. Clicking an
  Activity title reveals its ordered children, clicking a child title toggles
  its bounded details, and `Ctrl+O` changes the default for both levels.
  Explicit pointer choices override that default until the next global toggle.
  Activity-level choices are indexed by their semantic child keys, preserving
  them when older history changes the visible adjacency group.
- Failed Activity and child nodes disclose once by default and remain manually
  collapsible. Interrupted nodes are terminal but stay compact unless the user
  opens them.
- Title rows are the only click targets. The pointer wheel first scrolls an
  expanded bounded child or Diff; when that target cannot scroll, the same
  gesture falls through to conversation scrolling.
- Diff is intentionally specialized: returned file evidence never enters an
  Activity group, remains top-level regardless of execution status, and opens
  by default. It shares status and pointer semantics, not the child layout.

## Current components

- `HarnessController` owns session switching, stream reconciliation, history
  paging, projection watermarks, pending submissions, and atomic publication of
  one resolved lifecycle snapshot with every state update.
- `TerminalCommandDirectory` merges local interaction commands with the
  effective agent-scoped `ctx.commands` descriptors. Help and autocomplete read
  the same descriptor list, while a narrow application port executes resolved
  Host commands and supports bare-invocation UI decorations.
- Session-control selectors derive separate Config rows (model, reasoning,
  Permission, Plan, keymap, and TUI display) and Task rows (Goal, Todos, and runtime)
  without retaining a second copy of Host state.
- `SkillCatalog` generation-binds effective RPC rows to one session;
  `SlashCatalog` merges them with Commands while preserving dispatch semantics.
- `SkillAuthoringCoordinator` keeps file creation, editor handoff, validation,
  and effective-catalog settlement outside presentation components.
- `TrajectoryModel` indexes lifecycle parent keys once per event snapshot and
  computes offsets, durations, parent share, sibling bottlenecks, and the global
  bottleneck in linear time.
- `runtime/lifecycle` is the only module that pairs execution facts and enforces
  transition legality. It exposes one immutable snapshot for Turn, Step,
  Thought, Tool, Command, and Vision nodes.
- `buildTrajectoryRecords` and `buildTranscriptItems` join presentation payloads
  to resolved lifecycle nodes without re-pairing execution events or importing
  each other's models.
  `TranscriptComponent` paints and interacts with those items, while
  `TrajectoryView` provides the diagnostic hierarchy. None owns persistence.
- `WorkspaceCheckpointStore` remains a process-local compatibility subsystem;
  it is not a Harness durability boundary.

## Planned evolution

Product sequencing lives in [`tui-product-roadmap.md`](tui-product-roadmap.md).
The current milestone is specified in
[`tui-v0.1.8-design.md`](tui-v0.1.8-design.md); this section records only the
architecture required to support that sequence.

### v0.1.6 implemented architecture

- Pure session-control selectors consume optional Host projections and current
  session state; `ConfigView` and `TaskView` remain independent presentation
  domains and do not create a second plan, goal, permission, or todo store.
- One typed Slash catalog merges local commands, Host commands, and
  Skill RPC rows while preserving their distinct dispatch paths.
- Local Skill file mutation and external-editor lifecycle stay behind an
  application-owned authoring port so transport-neutral runtime code remains
  filesystem- and process-free.
- Capability absence, narrow views, history reconciliation, collision rules,
  authoring safety, and terminal-editor restoration have focused test seams;
  release acceptance still includes the complete package and manual PTY gates.

### v0.1.7 implemented architecture

- Add `packages/vision` as a terminal-independent Cordis service workspace. It depends on
  Harness LLM, Attachment, Agent/Session, Settings, and Credentials contracts,
  but never on the TUI or pi-tui.
- Publish that workspace independently and also bundle it behind the TUI
  package's `./vision` subpath, preserving the launcher’s zero-configuration
  install while supporting custom profiles.
- Pass a narrow `VisionPort` into the TUI application composition root. Image
  draft state and platform clipboard adapters stay in TUI application code;
  routing, proxy execution, observation safety, and evidence provenance stay in
  the Vision workspace.
- Use explicit model modality metadata for native routing. Text-only or unknown
  routes use the configured proxy or reject without submitting partial input.
- Preserve two durable messages in proxy mode: the exact human-authored user
  message first, followed by a source-attributed Vision evidence message with
  route, attachment, timing, and completion metadata.
- Extend Transcript and Trajectory from that supported `user/message` source
  instead of inventing an out-of-repository session event or retaining a
  second UI-owned result store.
- Keep provider endpoint, protocol, catalog, and credential references in
  `dsh-llm-pi-ai`; `/config Vision` selects policy and route without duplicating
  provider configuration.
- Keep key sequences in `input/keymap.ts`, durable preference access behind a
  narrow application gateway, and selection UI in `presentation/config`.
  `TuiApplication` handles semantic actions only. Standard and Legacy are data
  presets, so future presets or per-action overrides do not require changing
  submission, Vision, or Config behavior.
- Parse launcher options in an application-owned CLI module. Repeatable startup
  images enter the same validated draft store as interactive file attachment;
  command-line intake does not create a parallel submission path.

### v0.1.8 implemented architecture

- One private `runtime/lifecycle` module rebuilds the current event window into
  immutable semantic nodes and generation-scoped Vision activity.
- Controller updates reuse the existing lifecycle snapshot unless the event
  window, Host running state, Session generation, or Vision overlay changes.
- Transcript, Trajectory, composer status, Diff, and Activity consume that one
  snapshot; copied statuses, consumer pairing Maps, and child-running fallbacks
  have been removed.
- One presentation policy owns execution glyphs, labels, aggregate precedence,
  duration formatting, and automatic failure disclosure.
- Reducer open-node indexes keep sequential long-history replay linear while
  missing parents, starts, results, and contradictory terminal facts remain
  inspectable through deduplicated, bounded diagnostics.

### Following architecture work

- Introduce an immutable terminal session snapshot containing the event window,
  semantic nodes, projection cells, and command descriptors.
- Add Session Query-backed cross-session search and parent/child lineage views.
- Add a remote Vision RPC only when Web or another out-of-process client becomes
  a real consumer; the in-process service is the `v0.1.7` boundary.
- Move workspace checkpoint policy, events, and metadata to a Host plugin while
  retaining terminal-specific preview and confirmation UI.

### Extension rule

Do not add a generic terminal plugin or slot API in anticipation of unknown
consumers. Add the smallest semantic registration point only when at least one
independent extension needs it, and keep renderer-specific component types out
of the contract.

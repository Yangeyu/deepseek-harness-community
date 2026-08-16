# TUI Architecture

The terminal is another client surface for the DeepSeek Harness runtime. It
does not own a second agent loop or a second durable representation of session
state.

## Boundaries

```text
Harness Host
  session log · projections · LLM · attachments · commands · tools · persistence
      │
      ├── private Vision service (routing · proxy analysis · durable evidence)
      │
      │ transport-neutral ApiProxy plus narrow Command/Memory/Vision ports
      ▼
Terminal runtime
  HarnessController · submission coordinator · Slash/Skill catalogs · trajectory model
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
   wrapped by a turn, even when their events arrive during active work.
6. Recorded timing is authoritative. Pending records may use the current render
   clock, but completed records never infer timestamps that are absent.
7. Stable semantic keys preserve selection across live replacement and history
   paging. UI row indexes are not identities.
8. Image bytes become durable only through the Harness attachment service.
   Proxy observations are source-attributed context, never rewritten as human
   text, and a missing Vision capability never silently drops an attachment.

## Current components

- `HarnessController` owns session switching, stream reconciliation, history
  paging, projection watermarks, and pending submissions.
- `TerminalCommandDirectory` merges local interaction commands with the
  effective agent-scoped `ctx.commands` descriptors. Help and autocomplete read
  the same descriptor list, while a narrow application port executes resolved
  Host commands and supports bare-invocation UI decorations.
- Session-control selectors derive separate Config rows (model, reasoning,
  Permission, Plan, and TUI display) and Task rows (Goal, Todos, and runtime)
  without retaining a second copy of Host state.
- `SkillCatalog` generation-binds effective RPC rows to one session;
  `SlashCatalog` merges them with Commands while preserving dispatch semantics.
- `SkillAuthoringCoordinator` keeps file creation, editor handoff, validation,
  and effective-catalog settlement outside presentation components.
- `TrajectoryModel` indexes semantic parents once per event snapshot and
  computes offsets, durations, parent share, sibling bottlenecks, and the global
  bottleneck in linear time.
- `buildTrajectoryRecords` in `trajectory/records.ts` pairs durable lifecycle
  events without importing the terminal rendering toolkit.
- `TranscriptComponent` and `TrajectoryView` render different views of the
  event window. Neither owns persistence.
- `WorkspaceCheckpointStore` remains a process-local compatibility subsystem;
  it is not a Harness durability boundary.

## Planned evolution

Product sequencing lives in [`tui-product-roadmap.md`](tui-product-roadmap.md).
The current milestone is specified in
[`tui-v0.1.7-design.md`](tui-v0.1.7-design.md); this section records only the
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

- Add `packages/vision` as a private Cordis service workspace. It depends on
  Harness LLM, Attachment, Agent/Session, Settings, and Credentials contracts,
  but never on the TUI or pi-tui.
- Bundle that workspace behind the public package's `./vision` subpath and load
  it before the terminal plugin, preserving one installable release artifact.
- Pass a narrow `VisionPort` into the TUI application composition root. Image
  draft state and platform clipboard adapters stay in TUI application code;
  routing, proxy execution, observation safety, and durable Vision events stay
  in the Vision workspace.
- Use explicit model modality metadata for native routing. Text-only or unknown
  routes use the configured proxy or reject without submitting partial input.
- Preserve three durable identities in proxy mode: a log-only Vision event for
  image evidence and timing, plugin-sourced model context for the observation,
  and the exact human-authored user message for conversation display.
- Extend Transcript and Trajectory from the same Vision event rather than
  retaining a second UI-owned result store.
- Keep provider endpoint, protocol, catalog, and credential references in
  `dsh-llm-pi-ai`; `/config Vision` selects policy and route without duplicating
  provider configuration.

### Following architecture work

- Reuse a shared lifecycle index from Transcript and Trajectory when richer
  inline trace summaries need semantic records, avoiding a second event fold
  without forcing chat rows into the Trajectory record model.
- Replace central event switches with small registered event definitions only
  when a second independent consumer exists.
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

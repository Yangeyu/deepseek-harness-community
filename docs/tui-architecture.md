# TUI Architecture

The terminal is another client surface for the DeepSeek Harness runtime. It
does not own a second agent loop or a second durable representation of session
state.

## Boundaries

```text
Harness Host
  session log · projections · command registry · tools · persistence
      │
      │ transport-neutral ApiProxy and Host command discovery
      ▼
Terminal runtime
  HarnessController · command directory · trajectory model
      │
      │ immutable-by-convention state and semantic records
      ▼
pi-tui presentation
  transcript · trajectory view · composer · dialogs
```

The Host owns durable domain facts. The terminal runtime owns connection,
paging, semantic indexing, and interaction state. Presentation code owns only
layout, colors, focus, keyboard handling, pointer handling, and scrolling.

## Source layout

```text
src/
├── application/   # composition, configuration, and top-level UI orchestration
├── runtime/       # transport-neutral session, submission, and command state
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
4. TUI-local navigation commands and Host domain commands share one discovery
   directory. Local commands may shadow Host names, while unresolved slash
   input is sent to Host so it never reaches the model.
5. Paired lifecycle events produce one semantic node. This applies to
   turn/start-end, step/start-end, tool/call-result, and command/run-done.
   Command nodes remain standalone because their lifecycle is explicitly not
   wrapped by a turn, even when their events arrive during active work.
6. Recorded timing is authoritative. Pending records may use the current render
   clock, but completed records never infer timestamps that are absent.
7. Stable semantic keys preserve selection across live replacement and history
   paging. UI row indexes are not identities.

## Current components

- `HarnessController` owns session switching, stream reconciliation, history
  paging, projection watermarks, and pending submissions.
- `TerminalCommandDirectory` merges local interaction commands with the
  effective agent-scoped `ctx.commands` descriptors. Help and autocomplete read
  the same descriptor list.
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

### Near term

- Reuse `trajectory/records.ts` from Transcript when richer inline trace
  summaries need semantic records, avoiding a second event fold.
- Replace central event switches with small registered event definitions when a
  second independent consumer exists.
- Add width, color, PTY, history-gap, and event-replacement golden tests.
- Add compile-contract tests for the minimum and latest supported Harness
  versions.

### Medium term

- Introduce an immutable terminal session snapshot containing the event window,
  semantic nodes, projection cells, and command descriptors.
- Add Session Query-backed cross-session search and parent/child lineage views.
- Move workspace checkpoint policy, events, and metadata to a Host plugin while
  retaining terminal-specific preview and confirmation UI.

### Extension rule

Do not add a generic terminal plugin or slot API in anticipation of unknown
consumers. Add the smallest semantic registration point only when at least one
independent extension needs it, and keep renderer-specific component types out
of the contract.

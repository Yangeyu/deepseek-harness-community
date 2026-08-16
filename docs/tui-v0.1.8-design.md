# TUI v0.1.8 Design: Unified Execution Lifecycle

Status: implemented in the main worktree; release gates pending

Target: the next feature release after `v0.1.7`

Harness compatibility baseline: `>=0.1.0-rc.6 <0.2.0`

## Summary

`v0.1.8` replaces the terminal's duplicated execution-state derivation with one
small, typed, replayable lifecycle core. Turn, Step, Thought, Tool, Command,
and Vision adapters translate domain facts into common lifecycle mutations.
Transcript, Trajectory, the composer, file-diff cards, and Activity groups then
consume the same immutable snapshot instead of pairing events or interpreting
completion independently.

The design borrows Cordis's contract, ownership, scope, cleanup, and diagnostic
principles. It does not represent execution nodes as Cordis plugins or Fibers.
Cordis owns process-local plugin activation; the Harness Session event log owns
durable execution facts. A terminal restart, plugin reload, history prepend, or
session resume must rebuild the same lifecycle state from those facts.

The lifecycle core remains private to the TUI package. Common behavior is kept
aligned through contracts and tests, not by extracting shared code, adding a
public service, or introducing package dependencies solely for lifecycle.
Memory, Vision, and TUI remain independent packages and implementations; they
follow the same identity, state, boundary, failure, monotonicity, publication,
and cleanup conventions without importing a shared lifecycle package.

## Decision

The terminal will use one unidirectional lifecycle chain:

```text
Session HistoryEntry[]       generation-scoped runtime activity
          │                                │
          ▼                                ▼
typed durable definitions          ephemeral overlay adapter
          │                                │
          ▼                                │
LifecycleReducer ───────────────> LifecycleSnapshot
                                           │
                                           ▼
                                  resolved lifecycle view
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    ▼                      ▼                      ▼
               Transcript             Trajectory          composer/status
                    │
                    ├── Activity is an adjacency projection
                    └── Diff is a Tool-result presentation facet
```

The core answers only lifecycle questions: identity, state, transition,
boundaries, outcome, parentage, and diagnostics. Domain adapters retain domain
meaning. Presentation code retains labels, colors, disclosure, layout, and
interaction.

## Goals

1. Give every execution node one stable semantic identity and one lifecycle
   result across Transcript, Trajectory, composer status, and future surfaces.
2. Rebuild lifecycle state deterministically from the current event window;
   live streaming and resume replay must converge on the same snapshot.
3. Replace duplicated Turn, Step, Thought, Tool, Command, and Vision pairing
   maps with typed definitions and one reducer.
4. Express legal transitions once and reject or diagnose terminal reopening,
   conflicting outcomes, missing boundaries, and broken parentage.
5. Keep recorded timing authoritative. Presentation may measure an open node
   against an injected render clock, but settled nodes never invent a missing
   timestamp.
6. Preserve stable selection, expansion, and scrolling across live event
   replacement and older-history prepends by keying interaction state to
   semantic identities rather than row indexes or incidental event sequences.
7. Separate durable lifecycle state from generation-scoped runtime activity so
   pre-admission Vision work can reconcile without becoming a fake Session
   event.
8. Centralize execution status aggregation and visual policy so Thought, Tool,
   Diff, Vision, and Activity cannot drift in glyph, timing, or failure
   disclosure behavior.
9. Leave a narrow extension seam for Agent and Job lifecycles without exposing
   a speculative renderer or plugin API.

## Non-goals

- Replacing the Harness Session event log, projections, repair logic, or
  persistence with TUI-owned state.
- Representing lifecycle nodes as Cordis plugins, services, child contexts, or
  Fibers.
- Publishing a standalone lifecycle package or a public dynamic registration
  API in `v0.1.8`.
- Converting every status-bearing concept into an execution node. Goal, Todo,
  Permission, model configuration, and session availability keep their
  existing domain contracts.
- Moving Tool result presentation, Markdown, Diff rendering, terminal colors,
  disclosure state, pointer handling, or keybindings into the lifecycle core.
- Making Activity or Diff durable event types or independent lifecycle owners.
- Changing Host event schemas or requiring a newer Harness contract for the
  initial migration.
- Adding Session Center, cross-session search, Agent trees, background Job
  control, or a generic terminal extension surface in this release.
- Premature incremental indexing. A correct linear rebuild is the first
  implementation; optimization must preserve the same public snapshot.

## Current problem

The visible lifecycle vocabulary was aligned in `v0.1.7`, but the underlying
facts are still derived in several places:

| Area | Current responsibility | Duplication or drift risk |
| --- | --- | --- |
| Transcript model | Pairs Tool calls/results, tracks streamed Thought boundaries, interprets Turn termination, and pairs Commands | Reimplements execution truth for conversation rows |
| Trajectory records | Pairs Turn, Step, Tool, and Command boundaries and maps outcomes | Uses a second status vocabulary and different keys |
| Transcript component | Maps status to glyph/tone and tracks failure-triggered disclosure | Presentation policy is coupled to one component |
| Submission tracker | Owns pre-admission Vision activity | Needs explicit reconciliation with durable Vision evidence |
| Diff cards | Carry a copied Tool execution status | Can drift from the Tool node that produced the Diff |
| Activity groups | Recompute aggregate child status and time | Can diverge from other aggregate summaries |

This structure makes a local correction easy but a global invariant hard. A
new execution type would otherwise need to reproduce pairing, state, timing,
fallback, glyph, disclosure, and replay behavior in every consumer.

## Replacement policy

This is a replacement, not a compatibility layer around the current
implementation. Compatibility applies to persisted Session data and supported
Host versions; it does not apply to duplicated TUI internals. Once the new
snapshot is connected, no production consumer may keep an old status fallback,
pairing Map, copied lifecycle clock, deprecated alias, feature flag, or shadow
comparison path.

Consumer models carry a `lifecycleKey` or an immutable resolved node reference.
They do not copy independently derived `status`, `startedAt`, or `endedAt`
fields. Consumers may index entries by `event.seq` to recover presentation
payload, but they must not pair events by Turn, Step, call, command, or analysis
identity. Semantic pairing belongs exclusively to `runtime/lifecycle`.

### Required disposition of current code

| Current implementation | Disposition at cutover |
| --- | --- |
| `TranscriptExecutionStatus` and execution uses of `TrajectoryStatus` | Delete; execution records use the lifecycle contract directly. Non-execution Trajectory records use a separately named presentation tone. |
| Transcript `reasoningStarts`, Tool result, Turn end, Command run/result Maps | Delete; resolve lifecycle and boundary provenance from the snapshot. Keep only streamed content assembly that does not infer execution state. |
| Trajectory Turn/Step/Tool/Command pairing Maps and `turnStatus`/`resultFailed` lifecycle helpers | Delete; build execution records by joining source payload to lifecycle nodes. |
| `sessionRunning` fallbacks used to mark Thought, Tool, or Activity live | Delete; Host running state cannot override a child lifecycle node. |
| Transcript `activityStatus` and copied Activity timing | Delete; use the lifecycle aggregate selector. Activity remains adjacency grouping only. |
| Diff's copied execution status | Delete; Diff retains the producing Tool lifecycle key and resolves that node. |
| Transcript-local `thinkingLabel`, `executionVisual`, and execution duration policy | Move once to `presentation/execution-style.ts`; all execution renderers consume it. |
| Separate failed-Activity/failed-child status tracking | Replace with one lifecycle-keyed disclosure state that records automatic disclosure and explicit user override. |
| Sequence-bearing execution keys and consumer-built `stepKey` variants | Delete; only typed lifecycle key helpers construct semantic execution identities. |
| Old comments and tests that describe Map layouts or superseded fallbacks | Delete or rewrite against observable lifecycle contracts; do not preserve them as historical documentation in production files. |

Message assembly, Markdown rendering, Tool result formatting, raw diagnostic
records, pointer hit-testing, scroll offsets, and queue presentation remain only
where they do not decide lifecycle identity, state, outcome, or timing. This is
a responsibility boundary, not a promise to preserve the current file shapes.

## Design principles

### Event-sourced, not runtime-owned

The Session event log remains the durable authority. The lifecycle snapshot is
a discardable semantic index over the current `HistoryEntry[]` window. It is
never written as a second session artifact and contains no state that cannot be
rebuilt or explicitly identified as ephemeral interaction state.

### Cordis-inspired ownership

The design reuses these Cordis ideas:

| Cordis principle | Lifecycle application |
| --- | --- |
| Contract before implementation | Lifecycle types and transition laws are independent of each adapter and consumer |
| One provider owns a capability | One reducer owns legal state transitions |
| Consumers depend on the contract | Transcript and Trajectory consume snapshots, not each other's view models |
| Explicit scope | Durable snapshots bind to one session event window; overlays bind to one controller generation |
| Symmetric cleanup | Session switching and cancellation discard overlays and interaction state |
| Diagnostics are inspectable | Invalid or incomplete event pairings produce bounded diagnostics rather than silent overwrites |
| Composition at one boundary | Built-in definitions are assembled statically by the terminal runtime |

The design deliberately does not reuse Cordis Fiber states. `PENDING`,
`LOADING`, `ACTIVE`, and `DISPOSED` describe plugin activation and dependency
availability, not replayable model execution.

### Target model before legacy shapes

The lifecycle contract is defined from the execution semantics the product
needs, not by taking the union of current Transcript and Trajectory types.
Current `HistoryEntry` variants are input facts handled at the module edge; they
do not determine public status names, key shapes, consumer models, or file
boundaries. Version-specific interpretation stays in typed definitions and
never enters the reducer or presentation.

If existing data cannot prove a boundary or outcome, the module represents that
fact explicitly and emits a diagnostic. It does not revive an old heuristic to
make the UI look complete. Future Host events can improve a definition without
changing consumers or introducing another lifecycle path.

### Small core, typed edges

There is exactly one lifecycle module: `runtime/lifecycle`. It is one bounded
module, not necessarily one source file and not one process-global mutable
singleton. Its internal definitions understand domain events and emit
lifecycle mutations. Consumers join the resulting nodes with the original
`HistoryEntry.view` or a typed domain source when they need titles, arguments,
results, schemas, or evidence. The module contains no provider-specific or
presentation-specific payload.

### Cross-package contract direction

The community packages use the same lifecycle conventions without sharing code
or creating package dependencies solely for lifecycle:

```text
packages/vision ── typed analysis facts ──┐
Harness events ── durable execution facts ├──> packages/tui/runtime/lifecycle
TUI runtime ── generation-scoped activity ┘              │
                                                          ▼
                                                terminal consumers

packages/memory ── background domain activity ──> composer priority only
```

- `packages/vision` owns analysis, admission, evidence, and provider failures.
  It exposes stable `analysisId`-keyed facts but does not import TUI lifecycle
  types or manufacture terminal execution nodes.
- `packages/memory` owns post-turn background learning. Its current activity is
  not part of the Session execution tree and must not be forced into Turn/Step
  lifecycle semantics merely because it appears in the composer status area.
- `packages/tui/runtime/lifecycle` is the only implementation that converts
  those facts into terminal execution nodes. Dependencies point from the TUI
  adapter to producer contracts, never from Memory or Vision back to TUI.
- All three packages follow stable identity, the common pending/running/
  completed/failed/interrupted vocabulary where applicable, monotonic
  settlement, explicit boundaries and failure, snapshot-before-notify
  publication, and symmetric cleanup. Each package may use only the subset its
  domain can prove; it must not invent identities, timestamps, or parentage to
  make the shapes look identical.
- "Common" describes behavioral invariants rather than identical public enums.
  `MemoryActivity` remains a domain status signal until Memory can identify a
  durable background Job; Vision exposes analysis facts keyed by `analysisId`;
  only the TUI adapter creates terminal execution nodes.
- This convention lets TUI adapters remain structural and small. It does not
  remove TUI's responsibility to replay Harness events or turn Vision evidence
  into terminal nodes, and Memory does not enter the Session tree until it owns
  a stable background Job identity.
- A future Web, ACP, or plugin consumer should depend on each producer's stable
  domain contract and implement its own surface adapter. It does not justify a
  speculative community lifecycle package or public registry.

### Monotonic state

Within one fold, lifecycle state moves only toward settlement. Rebuilding a
larger event window may fill a previously missing boundary, but a settled node
never becomes pending or running.

### Stable identity before row layout

Keys derive from domain pairing identities, not event sequence numbers or
render positions. Adding older history, replacing streamed rows, or changing
the visible grouping cannot change an existing node's key.

## Ownership and dependency direction

```text
Harness Session / ApiProxy
  HistoryEntry · SessionEvent · HistoryEntry.view · projection baselines
                             │
                             ▼
packages/tui/src/runtime/lifecycle
  one public contract · internal definitions/reducer/snapshot/overlay/selectors
                             │
                  immutable semantic contract
                             ▼
       transcript projection · trajectory projection · composer adapter
                             │
                             ▼
                      pi-tui presentation
```

Rules:

1. `runtime/lifecycle` may import transport-neutral Harness event and history
   types. It must not import pi-tui or presentation components.
2. Definitions may inspect event discriminants and typed source variants. They
   must not format user-facing strings or sanitize terminal text.
3. The Tool definition uses core event facts to determine lifecycle. Tool
   titles and result bodies continue to use `HistoryEntry.view` in consumer
   projection code.
4. Presentation modules receive projected execution state. They must not
   reinterpret completion from raw events.
5. The application composition root constructs one lifecycle instance through
   the module's public entry point. Built-in definitions are private
   implementation details; components neither register nor import them.
6. No new Cordis service is introduced. The existing TUI plugin owns the
   runtime instance and its generation-scoped cleanup.

## Implemented source layout

```text
packages/tui/src/
├── runtime/
│   ├── lifecycle/
│   │   ├── index.ts            # the only import boundary for other modules
│   │   ├── types.ts            # keys, boundaries, state, outcome, diagnostics
│   │   ├── keys.ts             # the only semantic identity constructors
│   │   ├── reducer.ts          # the only legal-transition implementation
│   │   ├── snapshot.ts         # immutable indexes and query surface
│   │   └── definitions.ts      # stateless built-in event interpretation
│   └── controller.ts
├── trajectory/
│   └── records.ts              # joins lifecycle nodes with diagnostic payload
└── presentation/
    ├── transcript-model.ts     # joins lifecycle nodes with conversation content
    └── execution-style.ts      # glyph, tone, label, and disclosure defaults
```

Files below `runtime/lifecycle` are implementation units of the same module,
not independently owned lifecycle modules. Only `runtime/lifecycle/index.ts`
is imported outside that directory. Tests mirror the internal definitions and
consumer projections. Files express ownership; the implementation should not
split one small reducer into ceremony or create a base-class hierarchy.

## Domain vocabulary

- **Definition** — stateless typed event interpretation that requests declare,
  start, settle, or structural child settlement through the reducer.
- **Reducer** — the single owner of transition legality and diagnostics.
- **Node** — one semantic execution identity with parentage and observed
  boundaries.
- **Snapshot** — an immutable ordered node set plus key and parent indexes for
  one event window.
- **Overlay** — generation-scoped, non-durable lifecycle state for work that
  has not yet entered the Session log.
- **Resolved view** — durable nodes combined with an eligible overlay by stable
  key. Durable facts win conflicts.
- **Execution status** — the consumer-facing projection of one node's state:
  pending, running, completed, failed, or interrupted.
- **Diagnostic** — bounded machine-readable evidence that an input window was
  incomplete, contradictory, or used a compatibility fallback.
- **Activity** — a Transcript-only adjacency grouping of Thought and ordinary
  Tool rows. It is not a lifecycle node.
- **Diff** — a specialized presentation of one Tool call/result lifecycle. It
  is not a second lifecycle node.

## Core contracts

The exact TypeScript may be refined during implementation, but the invariants
below are the contract to preserve.

```ts
type LifecycleKey = string & { readonly lifecycleKey: unique symbol }

type LifecycleKind =
  | 'turn'
  | 'step'
  | 'thought'
  | 'tool'
  | 'command'
  | 'vision'

type LifecycleOutcome = 'completed' | 'failed' | 'interrupted'

interface LifecycleBoundary {
  seq?: number
  time?: number
  source: 'event' | 'parent' | 'snapshot-tail' | 'runtime'
}

interface LifecycleError {
  code?: string
  message: string
}

type LifecycleState =
  | { phase: 'pending'; declared?: LifecycleBoundary }
  | { phase: 'running'; started: LifecycleBoundary }
  | {
      phase: 'settled'
      outcome: LifecycleOutcome
      started?: LifecycleBoundary
      ended: LifecycleBoundary
      error?: LifecycleError
    }

interface LifecycleNode {
  key: LifecycleKey
  kind: LifecycleKind
  parentKey?: LifecycleKey
  state: LifecycleState
  durability: 'durable' | 'ephemeral'
}
```

The heterogeneous snapshot should use an explicit discriminated node-data map
or typed consumer joins rather than an unbounded `metadata: unknown` bag. The
core may retain start/end entry references behind its implementation boundary,
but it must not become a generic container for rendered text or arbitrary
provider payloads.

### Snapshot query surface

```ts
interface LifecycleSnapshot {
  readonly sessionId: string
  readonly generation: number
  ordered(): readonly LifecycleNode[]
  get(key: LifecycleKey): LifecycleNode | undefined
  childrenOf(key: LifecycleKey): readonly LifecycleNode[]
  diagnostics(): readonly LifecycleDiagnostic[]
}
```

The implementation owns its maps privately and exposes no mutation method.
Callers cannot reopen or overwrite nodes.

### Definition boundary

Built-in interpretation is statically assembled in `definitions.ts`. It may
inspect read-only reducer state for guarded transitions such as “settle this
Thought only if it was opened,” but all node creation and mutation goes through
the reducer's typed `declare`, `start`, and `settle` operations. There is no
definition registry, metadata bag, base class, or public mutation algebra in
this milestone. New definition files are introduced only when the built-in
interpreter becomes difficult to navigate, not to simulate a plugin system.

## State transition matrix

| Existing state | Mutation | Result | Diagnostic |
| --- | --- | --- | --- |
| absent | declare | pending node | none |
| absent | start | running node | none |
| absent | settle | settled node with missing start | `missing-start` |
| pending | same declare | unchanged | none |
| pending | start | running | none |
| pending | settle | settled | none |
| running | same start | unchanged | none |
| running | settle | settled | none |
| settled | equivalent settle | unchanged | none |
| settled | conflicting settle | first terminal fact wins | `conflicting-outcome` |
| settled | declare or start | unchanged | `terminal-reopened` |
| any | incompatible kind or parent | unchanged | `identity-conflict` |

Definitions and reducer behavior must be deterministic for the same ordered
input. A diagnostic never silently changes the outcome chosen by an earlier
authoritative event.

### Consumer-facing status

```ts
type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
```

Mapping rules:

- pending phase → `pending`;
- running phase → `running`;
- settled outcome → the same terminal status.

A cold or partial history window must never look live merely because one
boundary is absent. A known terminal event without its start remains settled;
an unmatched non-running tail settles interrupted and carries a diagnostic.

## Stable identities and hierarchy

Built-in keys are semantic and do not contain presentation row indexes:

| Kind | Key | Parent |
| --- | --- | --- |
| Turn | `turn:<turn>` | none |
| Step | `step:<turn>:<step>` | matching Turn |
| Thought | `thought:<turn>:<step>` | matching Step |
| Tool | `tool:<callId>` | matching Step |
| Command | `command:<commandId>` | none |
| Vision | `vision:<analysisId>` | none until a durable Host relation exists |

Sequence numbers are boundary evidence, not identity. The existing practice of
including a start event sequence in some Trajectory keys must be removed so
the same node preserves selection and disclosure across event-window rebuilds.

Commands remain root-level because their Host lifecycle is explicitly
standalone even when command events arrive while a Turn is running. Vision
evidence precedes the main model Turn and similarly remains root-level in this
milestone rather than inventing a parent relation.

## Durable event definitions

### Turn

| Event | Mutation |
| --- | --- |
| `turn/start` | Start `turn:<turn>` |
| `turn/end` completed | Settle Turn completed |
| `turn/end` error | Settle Turn failed with structured error |
| `turn/end` aborted, blocked, max-tokens, or interrupted | Settle Turn interrupted |
| unknown future reason variant | Settle interrupted and record `unknown-turn-reason` |

An unknown extensible reason must not be treated as success. The original
reason remains available to Trajectory detail.

### Step

| Event | Mutation |
| --- | --- |
| `step/start` | Start `step:<turn>:<step>` below its Turn |
| `step/end` | Settle the Step completed |

`step/end` is a structural completion, not a claim that every Tool succeeded.
A Tool failure may coexist with a completed Step and a failed or completed
Turn.

### Thought

| Evidence | Mutation |
| --- | --- |
| first appended `reasoning-delta` for a Step | Start that Step's Thought |
| first non-empty appended `text-delta` | Settle Thought completed immediately |
| appended final `assistant/message` with reasoning | Ensure Thought exists and settle completed |
| `step/end` with open Thought | Settle completed from the recorded parent boundary |
| failed `turn/end` with open Thought | Settle failed from the Turn boundary |
| other terminal `turn/end` with open Thought | Settle interrupted from the Turn boundary |

Only appended assistant surface messages contribute execution lifecycle.
Compaction/model-replacement messages remain context records and cannot create
or close the visible Thought for an earlier Step.

### Tool

| Event | Mutation |
| --- | --- |
| `tool/call` | Start `tool:<callId>` below its Step |
| matching `tool/result` without failure | Settle completed |
| matching `tool/result` with `data.error` or `tool-result.isError` | Settle failed |
| `step/end` with an open Tool | Settle interrupted and diagnose `tool-result-missing` |
| failed `turn/end` with an open Tool | Settle failed from the Turn boundary |
| other terminal `turn/end` with an open Tool | Settle interrupted from the Turn boundary |

The Harness repair path normally supplies missing Tool results before Step and
Turn closure. Fallback settlement is still required for a live event window,
an older compatible Host, or an incomplete diagnostic fixture.

### Command

| Event | Mutation |
| --- | --- |
| `command/run` | Start `command:<commandId>` as a root node |
| `command/done` success | Settle completed |
| `command/done` error | Settle failed with recorded text |
| orphan `command/done` | Create a settled missing-start node and diagnose it |

Command text, authoritative `sourceEventSeq`, and rich domain presentation stay
in the Trajectory/Transcript projection; the core owns only lifecycle facts.

### Durable Vision evidence

A `user/message` whose source is `community-vision` creates one already-settled
Vision node keyed by `analysisId`. Its recorded `durationMs` is authoritative,
so the definition may derive the start boundary as `event.time - durationMs`
and records that provenance. Provider, model, attachments, usage, truncation,
finish reason, and observation remain typed Vision data outside the core.

## Parent settlement

Parent closure settles only descendants that remain open:

1. An explicit child terminal event always wins.
2. `step/end` completes an open Thought, but an unmatched Tool is interrupted
   and diagnosed.
3. A failed `turn/end` fails still-open Step children, Thought, and Tools.
4. Other terminal Turn outcomes interrupt still-open descendants.
5. Parent-derived settlement records the parent event's sequence and time with
   boundary source `parent`; it is never presented as an explicit Tool result.
6. Already-settled descendants are unchanged even if their outcome differs
   from the parent.

## Tail and incomplete-window behavior

The controller always maintains the current tail page and may prepend older
message-aligned pages. The lifecycle fold therefore receives:

```ts
interface LifecycleBuildInput {
  sessionId: string
  generation: number
  entries: readonly HistoryEntry[]
  sessionRunning: boolean
}
```

Rules:

- An unmatched open node remains running only while the active Session reports
  running.
- An unmatched node in a non-running tail becomes interrupted without an
  invented end time and emits `open-node-idle-tail`.
- A completion whose start is outside the loaded window remains terminal with
  optional start timing and emits `missing-start`; it never becomes running.
- Prepending older history rebuilds the snapshot and may fill a missing start,
  but the semantic key and terminal outcome remain stable.
- Harness crash-repair events are consumed like ordinary authoritative events;
  the TUI does not reproduce persistence repair.

## Ephemeral overlay

Pre-admission runtime work cannot become durable evidence. The controller maps
eligible runtime activity to the same stable keys while rebuilding the
generation-scoped resolved snapshot. Resolved nodes retain a
`durability: 'ephemeral' | 'durable'` discriminator; no second mutable overlay
store or public overlay class exists.

Initial ephemeral source:

- pending and running Vision analysis from `SubmissionTracker`;
- optionally a failed Vision analysis until the existing retry notice and draft
  restoration are presented.

Resolution rules:

1. Ephemeral nodes are rebuilt only from the active controller generation.
2. A durable node with the same semantic key suppresses the ephemeral node.
3. Durable state always wins a conflict.
4. Session switching, cancellation, or submission retirement discards the
   corresponding overlay node.
5. Overlay state is never included in session export or reconstructed on
   resume unless a durable event exists.
6. Trajectory uses durable nodes by default; Transcript and composer may use
   the resolved durable-plus-overlay view for live feedback.

Memory learning and unrelated application tasks do not automatically become
lifecycle nodes. They may adopt the overlay contract later only if they have a
stable identity, monotonic start/settlement, and a real consumer need.

## Consumer projections

### Transcript

The Transcript projection continues to assemble user messages, assistant
content, Tool detail, Vision evidence, notices, and errors. It must obtain every
execution status and boundary from the lifecycle view.

It no longer owns:

- Tool result pairing maps;
- Turn-end fallback maps;
- streamed Thought terminal-state inference;
- Command pairing maps;
- a private execution-status union.

### Trajectory

Trajectory continues to build diagnostic records for requests, context,
messages, events, payloads, schemas, and results. Execution records join the
shared lifecycle node instead of pairing start and completion events again.

The trajectory-only `info` classification remains valid for non-execution
records, but execution records use the shared `ExecutionStatus`. Timing and
parent metrics read the same boundaries used by Transcript.

### Diff

Diff is a Tool result presentation facet selected from `HistoryEntry.view`.
Its key may remain view-specific for scroll state, but its execution identity
and status come from the matching `tool:<callId>` node. No Diff lifecycle
definition or reducer mutation exists.

### Activity

Activity is a replayable adjacency group over Transcript Thought and ordinary
Tool items. It never enters the durable snapshot. It uses one shared aggregate
function:

```text
failed > interrupted > running > pending > completed
```

Activity disclosure is presentation state indexed by the stable lifecycle keys
of its children, not by the first visible row. Prepending older Thought or Tool
records can therefore rebuild the adjacency group without losing an explicit
expand or collapse choice.

### Composer status

The composer selects from the resolved snapshot, preferring an active Vision
node when present and otherwise aggregating active execution nodes. Pending
submission data may enrich image count or prompt text but cannot create status
or timing. The controller's Host `running` flag is only a root-level fallback
before a lifecycle boundary is visible. Elapsed time uses the lifecycle start
and the render clock; only that boundary-less fallback owns a local clock. The
fallback clock is keyed by the optimistic submission or active lifecycle root,
so consecutive work cannot inherit elapsed time from a previous Activity.

## Presentation policy

`presentation/execution-style.ts` owns the shared visual vocabulary. It is a
presentation policy consumer, not a second lifecycle module:

- status glyph and tone;
- label suffix or verb tense;
- duration formatting;
- terminal versus live emphasis;
- default disclosure policy.

The `v0.1.7` visual behavior remains the initial policy:

| Status | Glyph | Default disclosure |
| --- | --- | --- |
| pending | `◦` | compact |
| running | `◦` | compact with live context |
| completed | `•` | compact |
| failed | `×` | disclose once |
| interrupted | `!` | compact |

Glyph choice is presentation policy, not domain state. Thought, Tool, Diff,
Vision, and Activity use this one mapping. A future visual refinement changes
this one presentation policy file and its tests without changing the lifecycle
module.

Disclosure state remains keyed interaction state owned by the component:

- a transition into failed discloses once;
- an explicit user collapse overrides the default until the node leaves the
  current session view;
- rebuilding an equivalent node does not reopen it;
- `Ctrl+O` and pointer overrides stay presentation concerns.

## Timing rules

1. Event timestamps are authoritative boundaries.
2. A parent-derived close uses the recorded parent event time and marks its
   source as `parent`.
3. Vision's recorded duration is authoritative evidence for its derived start.
4. A missing start or end stays absent in the node; consumers display unknown
   duration rather than zero.
5. Only a running node may use `now - startedAt` for live elapsed time.
6. `LifecycleSnapshot` construction never calls `Date.now()`.
7. Trajectory offset, parent share, and bottleneck measurement remain a pure
   function of one snapshot plus an explicit measurement clock.

## Diagnostics

Diagnostics are bounded data, not user-facing prose owned by the reducer:

```ts
interface LifecycleDiagnostic {
  code:
    | 'missing-start'
    | 'missing-parent'
    | 'identity-conflict'
    | 'conflicting-outcome'
    | 'terminal-reopened'
    | 'tool-result-missing'
    | 'unknown-turn-reason'
    | 'open-node-idle-tail'
  key?: LifecycleKey
  seq?: number
}
```

The runtime must fail soft on an incomplete compatible history window: preserve
the raw event and usable records, emit the diagnostic, and avoid showing false
live state. A programming error in lifecycle construction still fails fast
during development.

Diagnostics may appear in Trajectory detail or debug logging when useful. They
must not duplicate a normal model/tool failure as an additional conversation
error. One fold deduplicates identical diagnostics and retains at most 100.

## Replay, replacement, and concurrency

1. The initial implementation rebuilds the complete current window in O(n).
2. Every event-window update and `sessionRunning` change produces an atomic
   lifecycle snapshot before consumers render.
   Controller updates that do not affect lifecycle inputs reuse that snapshot.
3. Older-history prepend rebuilds from the combined ordered window.
4. A successful Session replacement increments controller generation; a failed
   pre-commit open attempt leaves the active generation untouched. Optimistic
   clear keeps that generation internally until replacement commits, so a
   failed attempt can restore any in-flight submission updates without exposing
   them in the temporary blank view. Stale asynchronous work cannot publish into
   a committed new generation.
5. The controller must expose one update path for event-window and lifecycle
   replacement so `events` and semantic state cannot be observed from different
   revisions.
6. Definitions are stateless. No event pairing Map survives outside one build.
7. A future incremental implementation may reuse a prefix index only behind the
   same snapshot contract and after replay-equivalence tests prove parity.

## Readability and maintenance rules

- Prefer discriminated unions and pure functions over lifecycle base classes.
- Keep one transition table in the reducer; definitions do not mutate nodes.
- Keep the statically composed event interpreter typed and bounded; split it by
  domain only when that improves navigation, not to create registry ceremony.
- Use typed key helpers; do not hand-build semantic keys in consumers.
- Keep domain result formatting out of the lifecycle module.
- Do not add `unknown` payload bags when a typed join to `HistoryEntry` or a
  source variant is available.
- Do not retain a legacy production path after consumer migration.
- Comments explain invariants or compatibility reasons, not line-by-line code.
- Tests assert semantic contracts and cross-consumer agreement, not private Map
  layouts.

## External data compatibility

Compatibility in this section is deliberately limited to data and integration
boundaries. It never justifies retaining the old internal lifecycle path.

- Unknown Session event types do not enter lifecycle state and remain available
  to generic Trajectory event presentation.
- Unknown future Turn-end reasons settle interrupted with a diagnostic rather
  than being mistaken for success.
- Missing Command or Vision event augmentations simply omit those definitions'
  nodes; the rest of the TUI remains usable.
- A deployment without Vision still builds the same core definition set; no
  Vision node appears unless its typed evidence exists.
- No Host schema, provider, credential, attachment, or persistence migration is
  required.
- All four public packages keep synchronized versions and the declared
  pre-`0.2.0` Harness compatibility range. The launcher remains a complete
  installable artifact while Memory, Vision, and TUI can also be installed
  independently.

## Testing strategy

### Reducer unit tests

- every legal state transition in the matrix;
- idempotent duplicate declarations, starts, and equivalent settlements;
- terminal reopening and conflicting terminal outcomes;
- kind and parent identity conflicts;
- missing-start settlement and bounded diagnostics;
- descendant settlement without overwriting explicit child outcomes;
- no mutable query surface escapes the snapshot.

### Definition contract tests

- Turn reason mapping, including unknown extensible variants;
- Step structural completion;
- first reasoning chunk starts Thought exactly once;
- first answer text settles Thought before final assistant message;
- final reasoning-only message and Step fallback settle Thought;
- Tool success, structured error, `isError`, missing result, and repaired result;
- standalone Command success, error, and orphan completion;
- durable Vision evidence timing and stable analysis identity;
- model-replacement assistant messages do not create execution nodes.

### Replay and reconciliation tests

- live prefixes converge to the full replay snapshot;
- resume replay produces identical key, kind, parent, state, and boundaries;
- older-history prepend fills missing starts without changing terminal keys;
- non-running unmatched tails do not remain visually running;
- session generation rejects stale overlay updates;
- pending Vision overlay reconciles into durable evidence once and disappears;
- failed pre-admission Vision work never appears in durable replay or export.

### Cross-consumer tests

- whenever Transcript and Trajectory render the same semantic key, they report
  identical status and recorded timing from the shared node;
- Diff reads the parent Tool status;
- Activity aggregate precedence is shared;
- composer elapsed time uses the same running boundary;
- failed nodes disclose once and stay manually collapsible after rebuild;
- semantic selection survives history prepend and live replacement.

### Performance and integration tests

- linear snapshot construction over long synthetic histories;
- a 10,000-event baseline and a larger stress fixture catch accidental nested
  scans without making ordinary CI timing brittle;
- TUI package build, lint, typecheck, and all tests;
- real PTY streaming verifies Thought handoff, Tool settlement, failure
  disclosure, interruption, resume, and Trajectory parity at narrow width;
- packed-file inspection covers all four public archives and confirms no
  source-only dependency escapes a published artifact.

## Migration plan

### Slice 1 — Contract and reducer

- add lifecycle types, key helpers, mutation contracts, reducer, snapshot, and
  table-driven unit tests;
- keep the module private and toolkit-independent;
- add no production consumer or presentation changes, so the current path
  remains the sole authority while the replacement core is still incomplete.

### Slice 2 — Complete event interpretation

- implement Turn, Step, Thought, Tool, Command, and durable Vision definitions;
- implement reasoning handoff, terminal fallback, orphan completion, parent
  settlement, replay repair, and stable keys before connecting any consumer;
- use existing event fixtures only as input corpora; expected results assert the
  new contract rather than reproducing historical implementation quirks.

### Slice 3 — Runtime ownership and overlay

- make the controller build one snapshot atomically with each event-window
  replacement;
- adapt `SubmissionTracker` Vision activity into the generation-scoped overlay
  and reconcile it with durable evidence;
- expose only the lifecycle module's public contract through `TuiState`;
- keep existing consumers untouched until the atomic cutover.

### Slice 4 — Atomic consumer cutover

- migrate Transcript, Trajectory, composer status, Diff, Activity, and Vision
  status together to the same snapshot contract;
- delete consumer pairing Maps, copied lifecycle statuses and clocks,
  sequence-bearing execution keys, `sessionRunning` child fallbacks, and old
  status helpers in the same change set;
- preserve only lifecycle-blind message/content assembly, raw diagnostics,
  request/context records, metrics, and Tool presenters;
- do not merge or release this slice in a partially cut-over state.

### Slice 5 — Presentation and interaction policy

- centralize glyphs, tones, duration labels, aggregate precedence, and default
  disclosure;
- replace separate failure-tracking collections with one semantic-keyed
  disclosure state;
- preserve explicit pointer and `Ctrl+O` overrides as interaction state, not
  execution truth;
- delete superseded visual switches, stale comments, and implementation-shaped
  tests as each replacement lands.

### Slice 6 — Repository hardening

- run a negative-source audit proving forbidden legacy types, pairing helpers,
  runtime feature flags, deprecated aliases, and duplicate status mappings are
  absent;
- remove empty files, dead exports, unused fixtures, obsolete comments, and
  tests that no longer assert supported behavior;
- update architecture, roadmap, README, and changelog;
- run full package, replay, performance, PTY, and packed-artifact gates.

Slices 1–3 may build the disconnected replacement internally, but they do not
create a second production authority. Slice 4 is the only production cutover
and is atomic across all lifecycle consumers. Temporary comparisons belong in
tests only and are removed at cutover; there is no runtime feature flag, bridge,
fallback, or dual-read period.

## Acceptance criteria

- [ ] One reducer owns lifecycle transition legality.
- [ ] Turn, Step, Thought, Tool, Command, and Vision use stable typed keys and
  definitions.
- [ ] Transcript and Trajectory consume one immutable lifecycle snapshot and do
  not pair the same execution events independently.
- [ ] Consumer records retain a lifecycle key or immutable node reference; they
  do not copy independently derived execution status or timing.
- [ ] Diff derives status from its Tool node and Activity remains a presentation
  grouping.
- [ ] Live streaming and full resume replay converge on identical lifecycle
  nodes.
- [ ] Thought settles on the first answer text without waiting for the final
  assistant message.
- [ ] A Turn boundary closes unmatched descendants without overwriting explicit
  child outcomes.
- [ ] A non-running or incomplete history window never leaves false live state.
- [ ] Settled timing is recorded or explicitly absent; it is never fabricated
  from render time.
- [ ] Vision overlay state is generation-scoped and reconciles once with durable
  evidence.
- [ ] Status aggregation, glyphs, duration, and failure disclosure have one
  implementation used by all execution presentations.
- [ ] Stable selection and disclosure survive live replacement and history
  prepend.
- [ ] Invalid transitions produce bounded diagnostics and do not crash a usable
  compatible history.
- [ ] No Cordis plugin/service, public renderer API, second persistence format,
  or dynamic lifecycle registry is introduced.
- [ ] Legacy production lifecycle paths, fallbacks, aliases, dirty comments,
  obsolete files, and implementation-coupled tests are removed in the atomic
  consumer cutover rather than deferred to a later compatibility phase.
- [ ] A negative-source audit finds no consumer event-pairing Maps, duplicated
  execution status types, or second execution visual mapping.
- [ ] Full checks, replay parity, long-history performance, PTY acceptance, and
  packed-file inspection pass before release.

## Deferred work

- Dynamic definition registration with disposer semantics.
- Incremental prefix indexing after profiling demonstrates a need.
- Session Center and cross-session lifecycle summaries in `v0.1.9`.
- Agent and background Job lifecycle adapters in `v0.2.0`.
- A public terminal renderer or semantic-card extension API.

## References

- [`tui-architecture.md`](tui-architecture.md)
- [`tui-product-roadmap.md`](tui-product-roadmap.md)
- [`tui-v0.1.7-design.md`](tui-v0.1.7-design.md)
- `@deepseek-ai/cordis` context, service, Fiber, effect, and diagnostic contracts
- `@deepseek-ai/dsh-session` event, replay, and interrupted-tail repair contracts
- `@deepseek-ai/dsh-commands` durable Command lifecycle augmentation
- `packages/tui/src/presentation/transcript-model.ts`
- `packages/tui/src/trajectory/records.ts`
- `packages/tui/src/runtime/submission.ts`

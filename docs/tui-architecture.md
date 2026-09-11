# TUI Architecture

The terminal is another client surface for the DeepSeek Harness runtime. It
does not own a second agent loop or a second durable representation of session
state.

## Boundaries

```text
Harness Host
  session log · projections · LLM · attachments · file references · commands · tools · persistence
      │
      ├── Bailian provider (endpoint · credentials · common request policy · model capabilities)
      ├── Vision fallback (route policy · proxy analysis · evidence admission)
      ├── Web service (official registry · community provider adapters)
      │
      │ in-process Session Controller and Cordis lifecycle events
      ▼
Infrastructure adapters
  consumer-owned Host ports · terminal decoding · clipboard · filesystem · workspace observation
      │
      │ explicit contracts; no presentation policy
      ▼
Statically composed TUI
  runtime kernel      Application/Session scopes · dispatch/effects · execution projection
  feature modules     composer · interaction · rewind · transcript · trajectory · config/task/skills/session
  presentation shell semantic input · SurfaceHost · viewport/focus · status · pi-tui rendering
      │
      │ one coalesced TerminalSnapshot commit
      ▼
RenderScheduler → pi-tui
```

The executable has a separate pre-Host boundary:

```text
argv → shared CLI contract → help/version/completion/doctor
                           → profile setup → TUI or one-shot session query
                           → Harness delegation → exec/config/plugin
```

The Host owns durable domain facts. The terminal runtime owns application and
Session lifetimes, connection state, paging, semantic indexing, effect
cancellation, and snapshot publication. Feature modules own their local process
state and workflows. Presentation code owns layout, colors, focus, semantic
input binding, pointer handling, and scrolling. `application/` is the static
composition root and public lifecycle facade; it is not a domain owner.

The in-process TUI has one Host path: `SessionController` and scoped Cordis
events are adapted once in `infrastructure/harness` to the ports owned by the
runtime and feature consumers. It does not instantiate the browser Remote
client, emulate an HTTP/RPC carrier, or retain the removed ApiProxy/Mux path.

## Provider authorization

The community bundle mounts `dsh-authorization` and enables the existing
`llm-pi-ai` `openai-codex` model route. The route uses request-scoped SSE;
retained WebSocket sessions require provider-owned lifecycle cleanup. The upstream
adapter owns subscription OAuth, credential refresh, serialization and stream translation. The
Host credential store remains the single durable owner of grant records.

`infrastructure/harness/authentication` declares the bundle's exposed subscription
connections and resolves their keys and methods against the Host authorization
catalog. The bundled connection is `openai-codex`; adding a provider to the
upstream catalog alone does not expose a login entry.

`modules/authentication` owns `/connect`'s connection selector and authorization
surface, and returns the attempt's result. The application routes `/connect`
directly to this feature. Login uses `ctx.authorization.begin`; browser
instructions, input and prompt withdrawal follow its interaction contract.
Account authorization is application-scoped; disposal and Esc cancel the attempt.

`modules/configuration` owns model selection through `/model`. Selection captures
the existing Session effect scope before async catalog work and rejects results
after that epoch retires. It operates independently of login. Providers own
credential resolution, validation and refresh when serving model requests.

`/usage` reads account quotas for the selected provider through `ProviderUsagePort`.
The Codex companion adapter in `infrastructure/harness/subscription-usage` owns the
usage endpoint and pi-ai grant format. It calls pi-ai's public OAuth refresh method
inside the Host's `modifyRecord` lock, shared with model requests. The TUI receives
only quota groups, window lengths, used percentages and reset timestamps. Queries
are command-scoped and on demand; retired Session results are discarded. No quota
cache or background polling is maintained. `/usage` opts into command activity via
its local definition's `activityLabel`. The command router tracks pending executions
and exposes the most recently started pending label and start time to the existing
status-bar spinner; completion removes only that execution, revealing earlier
pending work when needed. Host commands use the same activity path; local commands
without a label keep their existing interaction surfaces. Activity is not model
execution and does not imply Esc cancellation or animate transcript rows.
The adapter currently relies on the Codex backend usage protocol and the installed
pi-ai credential representation.

All model requests continue through the existing Session Controller, Harness Agent
and LLM adapter. There is no secondary executor, terminal, transcript or session
store. Adding a connection requires an explicit supported declaration alongside
the provider's Host flow and model route. Secret-input methods are not exposed by this
OAuth-only surface; such a prompt fails explicitly rather than displaying a secret.

## Source layout

```text
src/
├── application/      # static composition, startup/exit, command routing, facade, TerminalSnapshot
├── runtime/          # lifecycle kernel, Session runtime, execution projection, dispatch, render scheduling
├── modules/          # vertical feature owners: composer, interaction, rewind, transcript, trajectory, etc.
├── presentation/
│   ├── primitives/   # reusable toolkit-neutral presentation contracts and widgets
│   └── shell/        # semantic input, SurfaceHost, viewport, focus, status, main screen
├── infrastructure/   # Harness, terminal, clipboard, filesystem, and workspace adapters
├── bailian.ts        # declared package subpath entry point
├── memory.ts         # declared package subpath entry point
├── vision.ts         # declared package subpath entry point
├── web.ts            # declared package subpath entry point
└── index.ts          # stable public and Cordis plugin entry point
```

Tests mirror these directories. Root files are restricted to declared package
entry points. Directories express ownership rather than merely reducing the
number of visible files; shared behavior moves to `runtime` or presentation
primitives only when it has a genuinely cross-feature contract.

The dependency direction is enforced by tests:

```text
application (composition only)
  ├── runtime kernel
  ├── feature modules ──> runtime contracts + presentation primitives
  ├── presentation shell ──> read-only runtime/module selectors
  └── infrastructure adapters ──> consumer-owned ports

runtime ──X──> modules / presentation / infrastructure / application
modules ──X──> application / concrete infrastructure / presentation shell
```

Infrastructure points inward because it implements ports declared by the
consumer. Feature-specific views stay with their vertical module; only generic
terminal widgets and shell mechanics live under `presentation`. Build, lint,
package, profile, and release configuration stays outside `src`; the
`modules/configuration` directory is product behavior for the TUI's `/config`
feature, not repository tooling configuration.

## Distribution and release boundary

The root `@vascent/dsh-tui` package is the only published artifact. All
component workspaces are private implementation units and deliberately declare
no versions or registry metadata. The TUI build generates a runtime manifest in
`packages/tui/dist` with the root release version, relative entry points, and the
Bundle patch. Development and installed launchers both link this versioned
directory into the profile. The source manifest is not shipped. The profile's
local link reuses the already installed distribution and performs no second
registry install. Active Loader packages therefore have the name and version
required by DeepSeek's request-extension inventory. The
root's DeepSeek dependencies are limited to external references in the built
launcher and bundle, services named by `cordis.patch.yml`, and host packages
required by the coordinated runtime graph. Workspace development dependencies
never become public dependencies by default.

Profile setup has one idempotent responsibility: ensure that the canonical
`@vascent/deepseek-harness-tui` Bundle resolves to the current installation.
Historical package identities and version-specific migrations do not execute
in the launcher. A profile from before the canonical identity must be cleaned
or recreated once instead of making every future startup carry that history.

`pnpm-workspace.yaml#catalogs.dsh` is the single selected runtime train. One
anchored scalar supplies every DSH catalog entry, and all workspace manifests
refer to `catalog:dsh`; changing that scalar followed by ordinary
`pnpm install` is the complete upgrade mechanism. The component workspaces are
private parts of one distribution, so they intentionally bind to the same
exact runtime rather than maintaining separately published compatibility
ranges. `pnpm pack` resolves the catalog protocol in the public root manifest.
Official base services that resolve from the profile root remain explicit host
dependencies even when the community patch does not configure them.

The root package depends on the official `@deepseek-ai/dsh` executable; that
upstream CLI currently includes its Web bundle and therefore its React peer
graph. React is not a TUI dependency. The workspace pins only the transitive
ReactDOM compatibility choice needed by pnpm's auto-peer resolution, while the
public dependency boundary remains limited to the single distribution's
runtime closure.

## Upstream DSH alignment and community extension ownership

The selected upstream train is `@deepseek-ai/dsh@0.1.5-rc.1`, corresponding to
the official `dsh-v0.1.5-rc.1` tag. The workspace catalog selects one exact version
for every direct DSH dependency; the lockfile resolves the matching peer graph.

Session V3 keeps `system/message` on the model-visible surface and stores each
Assistant attempt as one `assistant/message` or `assistant/attempt` settlement
with its compact timed stream. The TUI opts into Controller `assistant-stream`
frames for live output. `SessionRuntime` owns that process-local presentation for
one Session epoch, uses the upstream `BlockAssembler`, restores the follow
opening baseline, and retires the presentation at settlement or abandonment.
These frames never enter the durable event window or advance its sequence cursor.
Thought timing on replay comes from the settlement's compact stream.
`AssistantStream` owns matching and retiring live attempts on durable settlement
and terminal frames. Model request boundaries are inclusive cuts of durable
request inputs, folded once for both live inspection and replay. Transcript
caches its durable history projection separately from live output and pending
work; text deltas and animation ticks reuse that history projection.

The Controller requires the official Connection registry and file-upload service.
The community bundle mounts both; without a Web server the Connection registry
provides no HTTP listener. The TUI continues to call the Controller in-process.

| Community component | Responsibility |
|---|---|
| TUI | Session follow owns durable history and live Assistant presentation; control owns queue/projection baselines; `api-session/status` owns run state. |
| Bailian | Provider capabilities and DashScope request/response translation. |
| Memory | Durable Markdown facts, direct Session reads, and persona-prefix registration for its learning Agent. |
| Vision | Native/proxy routing and attributed evidence; official Attachment services own image storage. |
| Web | Tavily adapters and settings-backed provider selection; official Web tools own search/fetch contracts. |

Upstream owns migration of older sessions to V3. Opening an existing session with
this runtime can migrate it; the older runtime cannot read the migrated format.
Upgrade validation uses an isolated `DSH_HOME`. Development remains build-and-run
with manual restart via `npm run dev`.

The archive includes only executable JavaScript, public declarations, the
Bundle manifest and patch, launcher examples, and user documentation. Source
maps, workspace sources, developer instructions, and private-package release
documents are excluded and are not generated by release builds.

The root `package.json#version` is the sole public distribution version. It is
changed and reviewed as an ordinary source commit before release; the workflow
accepts no bump input and never writes a generated release commit back to
`main`. Git history and GitHub Releases are the release history, so private
workspaces carry neither copied versions nor independent changelogs.

Linux and macOS CI own source acceptance through `pnpm check`. A manually
dispatched Release requires that CI to have succeeded for the exact
`github.sha`, then builds one candidate archive from that commit. The
`release:candidate` boundary inspects the package contents, installs the
archive into an isolated global npm prefix, verifies `dscode --version`, starts
the installed TUI in a real 80x24 PTY, and writes one receipt containing the
source SHA, package and runtime identities, toolchain versions, artifact
SHA-256, and size. It does not repeat lint, typecheck, or unit tests.

The retained tarball and receipt cross the release jobs as one immutable
artifact. Separate jobs use only their required permissions: candidate
acceptance is read-only, the tag job writes the Git ref, the npm job receives
OIDC, and the GitHub Release job writes release assets. Tag creation,
npm publication, and GitHub asset creation can be retried only when existing
external state resolves to the same source or digest. A release therefore
maintains the identity `github.sha = peeled tag SHA = receipt source SHA`, while
npm and GitHub receive byte-identical archives. Release jobs do not use a
dependency cache or rebuild the candidate after acceptance. npm read-side
visibility is an explicit external consistency boundary: after a publish
attempt, the workflow waits at most 60 seconds for that exact version to become
readable, then compares the registry tarball with the accepted candidate.

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
5. Durable user prompts and paired lifecycle events produce one semantic node.
   This applies to `user/message(source=user)`, turn/start-end, step/start-end,
   tool/call-result, and command/run-done. A Prompt is identified by its durable
   message id and belongs to its open Turn.
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
   The official backend owns source admission and provider-independent
   normalization; the community bundle does not replace that row. Provider
   adapters request a deterministic model-specific image version through
   `readImageRequest`, and durable references preserve optional pre-normalized
   dimensions across Vision evidence and Rewind persistence.
   A stable inline `[Image #N]` reference is inserted at the Composer cursor and
   edited as one atomic unit. Editor and Transcript presentation style that same
   reference through one `imageReference` theme role; they never create a second
   display-only marker. The Prompt compiler requires exactly one reference
   per draft and is the only authority for image order; live submission never
   appends missing references or pairs images by count. Native providers retain
   compiled content-block order, while the Vision proxy places each binary image
   immediately after the same explicit reference. Durable replay and Rewind
   require that exact reference contract and never synthesize a position from
   attachment count. Submissions decode the raw
   Editor submit path instead of reading presentation state, so a reference is
   never durable in its encoded separator form. Two contract edges follow from
   the one-reference-per-draft rule: a submission that races still-loading
   clipboard bytes lets the image intentionally not attach, and a detached
   draft re-binds if its live reference reappears in Composer text.
   Native and proxy routes produce the same human Prompt lifecycle. Proxy
   observations are source-attributed children of that Prompt, never rewritten
   as human text. Native image blocks and proxy evidence enrich the same Prompt
   with immutable attachment references, and a missing Vision capability never
   silently drops an attachment.
   The TUI resolves one immutable image route per submission. An image-capable
   `auto` route is handed directly to Host admission; a text-only or forced
   proxy route carries its resolved provider, model, token limit, and evidence
   limit through storage, inference, and admission without another settings or
   model-catalog lookup. Local drafts retain only source bytes, a declared media
   type, and the inline reference; byte validation, dimensions, normalization,
   and provider projection remain official Attachment/Host responsibilities.
   Model selection does not load and scan historical events to preflight image
   compatibility; the official Host request boundary is authoritative when a
   selected model cannot consume image-bearing history.
9. Raw terminal sequences resolve to semantic actions before application
   behavior runs. One fixed binding table owns those gestures and context owns
   their availability: idle editor input is never consumed by a running-turn
   binding, and raw mouse button bits never reach interaction policy.
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
12. Bailian, Memory, Vision, Web, and TUI remain independent implementations but use the same
    lifecycle conventions: stable identity, monotonic terminal state, explicit
    recorded boundaries, explicit failure, snapshot-before-notify publication,
    and symmetric cleanup. Domain packages never import terminal lifecycle or
    renderer types. This is a behavioral convention, not a requirement for
    identical state enums: Memory activity remains a domain status signal until
    it owns a stable Job identity, while Vision exposes stable analysis facts
    for the TUI adapter.
13. Rewind never infers ownership from elapsed time or whole-worktree state.
    The Host adapter must correlate an authoritative filesystem observation and
    canonical mutation outcome on the same execution identity. Unattributed or
    non-reversible mutations remain outside the default restore transaction.
    A timeline's workspace root is its persistence owner, not a containment
    boundary: each accepted file mutation retains the filesystem backend's
    canonical absolute target and one transaction may span multiple local roots.
14. Command-line input resolves to one typed action before profile mutation or
    Host boot. Help, version output, completion, diagnostics, usage errors, and
    execution do not pass through interactive startup. Launcher overlays are
    consumed before app arguments, while the TUI receives one startup intent for
    session selection, controls, attachments, and the optional initial prompt.
15. Append-only streaming and structural history replacement are different
    runtime operations. Semantically inert chunks reuse the current execution
    and Trajectory projections; Transcript updates only its live tail and keeps
    stable rendered blocks. Reconnect, paging, replacement, and execution
    boundaries fall back to the canonical full projection, so optimization does
    not create a second source of truth.
16. Every long-lived terminal timer, listener, subprocess, feature effect,
    Surface, and feature instance belongs to one `LifecycleScope`. Children
    cannot outlive parents; disposal aborts first and releases registered
    resources in reverse order. Cleanup is idempotent and awaited at application
    shutdown.
17. Session binding is one prepare/commit/rollback transaction shared by new,
    clear, resume, and Rewind. Only the latest operation may commit. A successful
    Host create/resume advances the Session epoch exactly once; late work from a
    retired epoch cannot write into the visible Session.
18. Composer, Interaction, Skills, Task, Trajectory, and Transcript are fresh
    feature instances for every committed Session epoch. Stable shell Hosts swap
    that complete feature set as a unit. A clear operation may temporarily
    suspend the previous set for rollback, but no render-time Session-id check
    performs lifecycle cleanup.
19. Rewind is application/workspace-scoped, not Session-scoped. Its transaction
    intentionally spans the source Session, durable fork, replacement Session,
    and compensation. Application disposal waits for an active Rewind transaction
    before completing, and Rewind uses the same Session replacement path as every
    other navigation action.
20. Session follow connection, Host control connection, Session binding, and
    execution run state are orthogonal axes. A reconnect never fabricates an
    idle turn, and a running turn never implies that either stream is online.
    Each Session epoch owns exactly one follow loop beginning with an atomic
    history/projection snapshot; the application owns one control loop beginning
    with queue/projection baselines. Reconnecting and offline phases remain
    explicit degraded states.
21. Renderer-visible state is committed through one `TerminalSnapshot`. It is a
    coalesced, read-only composition of runtime, installed feature, and shell
    slices—not another durable store. Synchronous slice changes become visible
    together; one snapshot notification is the only path to `RenderScheduler`
    and the concrete `requestRender` call.
22. Normalized terminal gestures resolve through the fixed contextual keymap,
    then `ActionDispatcher` sends each semantic action to one statically
    registered owner. Duplicate action ownership is an error. Asynchronous
    handlers run through `ScopedEffectRunner`; aborts and retired-scope results
    are ignored, while live timeouts and failures remain visible errors.
23. `SurfaceHost` exclusively owns active-Surface stacking, placement, focus
    capture/restoration, close identity, and Surface input routing. Both
    `readable` and `workspace` placements are clipped to the available terminal
    rows. Readable documents use the host viewport; workspace pointer input is
    translated from terminal coordinates through the last rendered Surface
    geometry, then resolved by the active feature's pane and row hit map. Mouse
    wheel input cannot leak to the Transcript while a Surface is active.
24. `runtime/execution` is the execution read-model boundary; application and
    Session lifecycle code never shares its terminology or state machine.
    Append-only accepted entries update one canonical accumulator. Structural
    replacement replays the accepted window, and equivalence tests protect both
    paths.
25. The in-memory event window is intentionally not evicted yet. It therefore
    remains an unbounded retention risk for very long Sessions even though
    append-only execution folding is incremental. A bounded window requires a
    correctness-preserving Host/checkpoint contract and must not be introduced as
    an arbitrary UI cache policy.
26. A Step owns exactly one model exchange. The execution projection associates
    its request boundary and assembled append response with that Step. Trajectory
    exposes them as the Step's Request and Response detail. Reasoning and
    non-empty answer content become separately labelled Thinking and Assistant
    children; request metadata is not a parallel ledger record.

## Lifecycle kernel and state flow

The TUI is a static modular monolith. The kernel supplies ownership and
transition primitives; it does not discover modules dynamically and does not
define another persistence format.

```text
ApplicationScope
├── terminal                TerminalSnapshot · RenderScheduler · terminal lifetime
├── session-kernel
│   ├── control-connection  Session Controller queue/projection stream
│   └── workspace
│       └── SessionScope(epoch N)
│           ├── history-follow   opening snapshot and ordered event suffix
│           ├── SessionRuntime
│           └── features
│               ├── Composer          ├── Interaction       ├── Skills
│               ├── Task              ├── Trajectory        └── Transcript
├── rewind                 cross-Session transaction and compensation
├── configuration          application preference and model controls
├── memory                 application-visible Memory activity
├── session-center         root Session discovery/navigation
├── surfaces               placement, viewport, focus, close handles
├── input / commands       semantic dispatch and command routing
└── shell-status           header, footer, clocks, Git observation
```

`ApplicationMachine` is one-way: `created -> starting -> running -> stopping ->
disposed`. Its root scope is the cancellation and cleanup authority. Startup
failure enters the same awaited disposal path as normal shutdown.

`SessionManager` owns transport coordination. `SessionWorkspace` owns binding
transactions and the visible/suspended runtimes. `SessionRuntime` owns the
immutable-by-convention read model for one `(sessionId, epoch)`, including the
accepted event window, projection cells, pending submissions, model catalog,
and execution snapshot. Effective model selection is derived at read time from
the `modelSelection` projection, falling back to the catalog default; it is not
stored as another mutable runtime field. The control connection is
application-scoped, while each follow loop belongs to its Session scope, so
replacement retires the old event stream without restarting Host-wide control.

Session replacement follows one protocol:

1. `begin` records a latest-wins operation and either preserves the previous
   presentation or publishes an immediate empty presentation for `/clear`.
2. The transport performs the durable create/resume/fork operation.
3. `commit` advances the epoch, installs a fresh `SessionRuntime`, constructs
   one complete Session feature set, and retires previous scopes.
4. A pre-commit failure rolls the suspended Session and feature set back. If
   feature construction fails after the durable commit, the new Session remains
   active with an explicit error and the partially created feature scope is
   immediately disposed; stable Hosts atomically unbind the retired feature set,
   and the client does not pretend the Host commit vanished.

Before initial Session attachment, an unbound feature set accepts startup input.
Its draft transfers into the first Session. Later Session replacements transfer
plain draft text but strip image markers and attachments whose durable ownership
belongs to the previous Session.

The renderer flow is unidirectional:

```text
Host/terminal input
  -> transport event or normalized gesture
  -> SessionRuntime / semantic Action owner
  -> scoped Effect when required
  -> owner-local immutable snapshot
  -> TerminalSnapshotCoordinator (one microtask commit)
  -> RenderScheduler
  -> pi-tui render
```

Rendering performs no Host calls, Session transitions, cleanup, or durable
mutation. Stable Hosts (`ComposerHost`, `InteractionHost`, `SkillsHost`,
`TaskHost`, `TrajectoryHost`, and `TranscriptHost`) let the shell keep stable
component references while the Session-owned implementations are replaced.

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
- Tool presentation has three explicit levels: the Activity row uses callable
  identity, the child row uses the tool-owned one-line operation label, and the
  expanded child owns complete bounded Arguments and Result. Raw terminal
  commands never become Activity or child titles.
- Failed Activity, child, and Diff nodes stay compact unless the user opens
  them. Interrupted Activity and child nodes follow the same rule.
- Title rows are the only click targets. The pointer wheel scrolls an expanded
  bounded Thought first; every other target falls through to conversation
  scrolling one rendered row at a time. Mouse tracking reports presses, drags,
  releases, wheel input, and passive position. Passive movement invalidates the
  presentation only when its fold-title target changes, preserving hover
  feedback without rebuilding on movement within the same title.
- A successful disclosure click preserves the last rendered conversation top
  before the transcript changes height. This transfers viewport ownership from
  automatic tail following to the user without coupling Layout to Activity,
  Thought, tool, or Diff keys. Explicit follow actions resume tail ownership.
  A disclosure block that reaches the transcript end keeps tail ownership
  instead: freezing a viewport with no rendered rows below the block would
  leave the newly expanded content hidden below the bottom edge.
- Main-screen text selection, including active Surface content, owns rendered
  cell coordinates, grapheme-aware highlighting, and plain-text extraction.
  The application owns clipboard I/O.
  A primary press starts one gesture; dragging updates selection, while release
  either copies a non-empty range or dispatches a click to the rendered target.
  Transcript disclosure and Surface row selection therefore never run
  speculatively on button press.
- Diff is intentionally specialized: returned file evidence never enters an
  Activity group and remains top-level regardless of execution status. Small
  edits open by default; large edits start as a title and summary and expand on
  demand. Content renders inline in the conversation and never owns a nested
  viewport.

## Current implementation owners

- `TuiApplication` is a thin public lifecycle facade. `createApplication`
  statically assembles the graph, while `createSessionFeatureSet` is the only
  construction site for Session-scoped feature processes. Neither file is a
  mutable business-state owner.
- `ApplicationMachine` and `LifecycleScope` own one-way process phases,
  cancellation, child ownership, and reverse-order cleanup. `ResourceSlot`
  handles replaceable resources such as timers and process/listener handles.
- `SessionManager` owns the transport loops and narrow Session operations;
  `SessionWorkspace` owns replacement transactions; and `SessionRuntime` owns
  the read model for exactly one Session epoch. `BoundSession` exposes that
  epoch to feature processes and rejects writes after retirement.
- `TuiHostPorts` is the application composition boundary. `HarnessSessionTransport`
  maps the upstream Session Controller once into history follow, control,
  commands, paging, and model catalog operations. `HarnessFileReferenceSource`
  resolves that same Session to its Agent and delegates discovery to the
  profile's `ctx.fileReferences`; `HarnessInteractionSource` maps scoped
  Approval and Question waterfalls directly. No Remote response channel,
  second interaction state source, or TUI-owned filesystem index exists.
- `SessionFeatureCoordinator` swaps Composer, Interaction, Skills, Task,
  Trajectory, and Transcript together through stable shell Hosts. It implements
  the same prepare/activate/rollback protocol as `SessionWorkspace` rather than
  reacting to a later render.
- `TerminalSnapshotCoordinator` composes all renderer-facing slices at one
  microtask commit boundary. `RenderScheduler` coalesces those commits into the
  repository's only concrete `requestRender` call.
- `ActionDispatcher` gives each semantic input action one static owner, and
  `ScopedEffectRunner` binds asynchronous work to that owner's scope. Raw escape
  decoding is confined to `infrastructure/terminal`; contextual gesture
  resolution lives in `presentation/shell/input`.
- `TerminalCommandDirectory` merges local interaction commands with the
  effective agent-scoped `ctx.commands` descriptors. Help and autocomplete read
  the same descriptor list, while a narrow application port executes resolved
  Host commands and supports bare-invocation UI decorations.
- `ComposerAutocompleteProvider` gates `pi-tui`'s combined provider to Slash
  completion only, uses the shared `dsh-file-reference` token grammar, and maps
  candidates from its consumer-owned `FileReferenceSource` port into Editor
  rows. Bare-path and alternate `@` grammar never fall through to `pi-tui`'s
  filesystem discovery. The mounted `dsh-file-reference-local` provider alone
  owns host-filesystem traversal, ranking, bounds, caching, invalidation, and
  matching model guidance. A selection remains ordinary workspace-relative
  prompt text; neither the TUI nor the provider reads file contents into the
  durable message. Raster references use native `read_image` on image-capable
  routes, or proxy-backed `inspect_image` when the active model is text-only.
- `ComposerEditorFrame` is the presentation boundary around `pi-tui`'s Editor.
  It places autocomplete above the bottom-anchored input frame and keeps image
  references inside that frame, so changing candidate count cannot move the
  input. The repository-owned `InlineReferenceEditor` adds image-reference
  movement, deletion, and styling through the Editor's public API; application
  key routing does not special-case marker internals or modify the dependency.
  Its equal-width wrap representation stays private to the adapter; public text,
  durable Session content, and provider requests retain canonical `[Image #n]`
  references.
- `SurfaceHost` owns one stack of close-identity handles, focus capture and
  restoration, semantic Surface input, and the only active-placement mutation.
  `ComposerAnchoredLayout` implements its discriminated `readable` and
  `workspace` placements. Both placements are height-bounded; readable content
  keeps a host-managed document viewport, while a workspace owns its semantic
  panes and row hit map. In Trajectory, wheel input over Execution moves the
  ledger selection, wheel input over Detail scrolls only its detail viewport,
  and a released click activates the rendered Execution row or Detail tab.
  Workspace geometry remains independent of the narrower decision-card reading
  width.
- `VisionService` owns only image-route policy, proxy fallback inference, and
  bounded source-attributed evidence. It does not decode images, derive
  dimensions, normalize bytes, persist media, or serialize native-provider
  requests; the official Host, Attachment service, and provider adapters own
  those stages. Composer analysis requires one unique inline reference per
  image and consumes the already-resolved proxy route, so no downstream step
  re-reads live settings or model metadata.
- `inspect_image` has one stable global schema, matching the official
  `read_image` registration pattern. Execution resolves the current route
  before parsing or reading its source: native `auto` routes reject with
  guidance to use the inline image or `read_image`, while text-only `auto` and
  explicit `proxy` routes may continue. Its discriminated `file` and
  `attachment` sources are explicit provenance domains. A narrow resolver uses
  the official filesystem and Attachment services; file extensions only
  declare media type, and Attachment storage remains authoritative for byte
  validation and normalization. Both sources then enter the same
  reference-only proxy inference core and return text-only untrusted evidence.
- `VisionEvidenceAdmissionAdapter` is the stateless admission boundary for the
  Agent pre-step contract: it converts one complete proxy carrier into the exact
  human Prompt plus a source-attributed evidence message during `pre-step`.
  There is no process-local staging Map, expiry, or discard protocol. Delete
  this adapter when upstream admission can atomically accept multiple messages.
- Bailian composition resolves one configuration snapshot after each accepted
  settings change; Settings owns validation and last-good fallback.
  `BailianAdapter` binds resolved model metadata and request dispatch through
  `prepareCall`, so a live settings change cannot combine one generation's
  capabilities with another generation's endpoint or credential reference.
  Image-capable routes own a pixel/byte request policy and consume deterministic
  attachment request versions rather than replaying stored normalized bytes
  directly. Request translation emits adjacent tool results before their image
  carriers. Transport owns HTTP/SSE lifetime, demand-scoped network idle timing,
  cancellation, and failure metadata; local request preparation and consumer
  pauses are outside that timer. SSE comments and data both count as progress.
  Response translation validates wire payloads, selects `choice.index = 0`,
  and assembles tool arguments by wire index with stable IDs and names before
  successful finalization. It owns `[DONE]`; Harness owns message assembly,
  tool argument validation, dispatch, and request recovery. Wire semantics follow the
  [DashScope API reference](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions).
- `CommunityWebService` registers one stable policy provider into the official
  `ctx.web` search seam. A capability-local registry owns provider execution,
  display metadata, priority, and secret-free readiness; both `auto` routing
  and `/config web` derive from that registry. Selection is persisted live and
  resolved before each request without request-time fallback. Tavily Extract
  remains a separate provider-neutral capability, while `dsh-tool-web` retains
  the official `web_search` model contract.
- Session-control selectors derive separate Config rows (model, reasoning,
  Permission, Plan, Vision, Web status, and TUI display) and Task rows
  (Goal, Todos, and runtime) without retaining a second copy of Host state.
  A successful user-dispatched `/permission <preset>` then writes the official
  `permission.defaultPreset` setting through a narrow application port; the
  session projection remains the effective-state authority, and launcher
  overrides bypass this preference write.
- Model selection has one state path. `modelCatalog` contains only discoverable
  routes and the deployment default; the `modelSelection` Session projection is
  the only current/pending selection fact. A selection command writes only to
  the Host, and the visible TUI changes only after that projection advances.
- Opening `/model` and selecting a named model read the Host catalog again.
  The Session snapshot is display state, not a freshness policy.
  The upstream DeepSeek provider owns connection settings, credentials, model
  metadata, request preparation and transport. Its catalog comes from built-in
  defaults or explicit settings; TUI refresh does not add remote discovery.
- Each Session feature set owns a fresh `SkillCatalog`; its local request version
  rejects stale refreshes within that epoch. `SlashCatalog` merges effective
  Skill rows with Commands while preserving dispatch semantics.
- `SkillAuthoringCoordinator` keeps file creation, editor handoff, validation,
  and effective-catalog settlement outside presentation components.
- `TrajectoryModel` indexes execution parent keys once per event snapshot and
  computes offsets, durations, parent share, sibling bottlenecks, and the global
  bottleneck in linear time.
- `runtime/execution/projection` is the only module that projects accepted Prompt
  boundaries, pairs execution facts, and enforces transition legality. It
  exposes one immutable snapshot for Turn, Prompt, Step, Thought, Tool,
  Command, and Vision nodes. Its post-commit Prompt feed is replayable from the
  same Session log and contains no Rewind policy. Append-only inputs update one
  accumulator; history prepend/replacement uses the canonical replay path. That
  accumulator also records each Step's model request boundary and response event;
  complete Request detail is derived lazily from the canonical Session surface.
- Prompt projection retains both `turn-entry` and `in-turn` user admissions.
  Rewind's adapter selects only `turn-entry`, matching the Host's completed-turn
  fork contract instead of silently deduplicating steering messages in Journal.
  The Prompt feed upserts immutable snapshots so later Vision evidence
  can add attachment references without creating another Prompt or Rewind point.
  Durable Vision evidence names its owning `promptId`; projections never infer
  ownership from the nearest or latest Prompt.
- `buildTrajectoryRecords` and `buildTranscriptItems` join presentation payloads
  to resolved execution nodes without re-pairing execution events or importing
  each other's models.
  `TranscriptComponent` paints and interacts with those items, while
  `TrajectoryView` provides the diagnostic hierarchy. None owns persistence.
  A Trajectory Step presents its complete model exchange through Request and
  Response detail tabs. Its final response is also split by canonical content
  type into separately selectable Thinking and Assistant child records.
  Stable item keys retain rendered Markdown, prompt, and Diff blocks across
  viewport movement. Append-only assistant chunks update the live Transcript
  tail; Trajectory keeps its semantic record index until an execution boundary
  or durable event changes it. Async Diff line lookups scan only new events and
  publish one immutable result batch.
  Trajectory records keep a Tool's callable name separate from its operation
  title; one presentation projection then orders ledger identity, detail heading,
  and Summary consistently. One ledger-row painter owns focus for every record
  kind, and the shared focus theme preserves its background across nested ANSI
  styles and truncation resets.
- In the split Trajectory surface, Shift+J/K scroll the overflowing detail
  panel while j/k keep stepping the ledger selection.
- `modules/rewind/contracts` is independent of Cordis, Memory, Node, and pi-tui.
  The injected `RewindConversationHistory` rebuilds Prompt checkpoints from the
  active Session log. `modules/rewind/domain` owns only the bounded
  reversible-effect lineage and pure reverse planning;
  `modules/rewind/application` joins those two
  sources and owns the active timeline Repository port, restore, and conversation
  compensation; and
  `modules/rewind/adapters` is the only layer that translates Prompt nodes, Host
  filesystem events, Memory payloads, durable Harness-home files, or the local
  workspace. Presentation consumes only the `RewindPort`, point summaries, and
  immutable plans. `RewindProcess` itself is application-scoped because its
  transaction crosses Session retirement and replacement.

## Planned evolution

Product sequencing lives in [`tui-product-roadmap.md`](tui-product-roadmap.md).
This section records the implemented architecture that supports that sequence;
package versions and completed version-specific design documents remain in Git
history rather than competing with this canonical contract.

### Implemented: Configuration, Task, and User Extensions

- Pure session-control selectors consume optional Host projections and current
  session state; `ConfigView` and `TaskView` remain independent presentation
  domains and do not create a second plan, goal, permission, or todo store.
- One typed Slash catalog merges local commands, Host commands, and
  Session Controller Skill rows while preserving their distinct dispatch paths.
- Local Skill file mutation and external-editor lifecycle stay behind an
  application-owned authoring port so transport-neutral runtime code remains
  filesystem- and process-free.
- Capability absence, narrow views, history reconciliation, collision rules,
  authoring safety, and terminal-editor restoration have focused test seams;
  release acceptance still includes the complete package and manual PTY gates.

### Implemented: Visual Input and Vision Proxy

- Add `packages/vision` as a terminal-independent Cordis service workspace. It depends on
  Harness LLM, Attachment, Agent/Session, Settings, and Credentials contracts,
  but never on the TUI or pi-tui.
- Keep the Vision workspace implementation independent while exposing its
  public API through the root package's `./vision` subpath. Internal workspace
  manifests remain non-publishable so releases produce one npm artifact.
- Pass a narrow `VisionPort` into the TUI application composition root. Image
  draft state and platform clipboard adapters stay in TUI application code;
  routing, proxy execution, observation safety, and evidence provenance stay in
  the Vision workspace.
- Use explicit model modality metadata for native routing. Text-only or unknown
  routes use the configured proxy or reject without submitting partial input.
  Resolve that decision once per submission; official Host admission and
  provider adapters remain the only native image pipeline.
- Preserve two durable messages in proxy mode: the exact human-authored user
  message first, followed by a source-attributed Vision evidence message with
  route, attachment, timing, and completion metadata. A stateless `pre-step`
  adapter bridges the current single-message admission API without staging
  analysis in process memory.
- Extend Transcript and Trajectory from that supported `user/message` source
  instead of inventing an out-of-repository session event or retaining a
  second UI-owned result store.
- Keep generic compatible-provider declarations in `dsh-llm-pi-ai`. The
  first-class Bailian package directly owns its endpoint, credential, model
  capabilities, request serialization, and SSE translation; `/config Vision`
  selects routing policy without reading or writing provider configuration.
- Keep one fixed, context-aware binding table in
  `presentation/shell/input/keymap.ts`. Raw bytes are normalized by the terminal
  adapter before `InputCoordinator` dispatches semantic actions to explicit
  owners. Key sequences are neither a persisted setting nor a configuration
  surface; changing a product gesture is one source edit instead of a
  compatibility preset migration.
- Parse the public command line through one shared action contract used by the
  package launcher and direct TUI profile entry. Repeatable startup images enter
  the same validated draft store as interactive file attachment; command-line
  intake does not create a parallel submission path.

### Implemented: Unified Execution Lifecycle

- One private `runtime/execution/projection` module canonically projects the
  current event window into immutable semantic nodes and Session-epoch-scoped
  Vision activity.
- `SessionRuntime` updates one canonical accumulator for append-only events and
  reuses the existing execution snapshot while stream chunks leave execution
  semantics unchanged. Event replacement or prepend uses canonical full replay;
  Host running state, Session epoch, Vision activity, and semantic boundaries
  rematerialize from the accumulator.
- Transcript, Trajectory, composer status, Diff, and Activity consume that one
  snapshot; copied statuses, consumer pairing Maps, and child-running fallbacks
  have been removed.
- One presentation policy owns execution glyphs, labels, aggregate precedence,
  duration formatting, and disclosure overrides.
- Reducer open-node indexes keep sequential long-history replay linear while
  missing parents, starts, results, and contradictory terminal facts remain
  inspectable through deduplicated, bounded diagnostics.

### Implemented: Source-Attributed Rewind

- One `rewind` domain replaces the TUI-owned Git checkpoint subsystem; there is
  no compatibility reader, detached index, tree snapshot, or alternate restore
  path.
- `runtime/execution/projection/host` projects a first-class Prompt only from a
  committed human `user/message`; `modules/rewind/adapters/prompt` maps its
  `turn-entry` subset to Rewind points. Vision transport and evidence cannot
  create or suppress that point; evidence can only enrich its durable attachment
  references.
- `modules/rewind/adapters/host` joins `fs/observed` and `tools/result` by execution
  identity, validates the canonical text-mutation contract, and attributes it
  through stable root-call, session, and turn identities without parsing tool
  names or presentation diffs.
- `RewindJournal` retains only the Prompt identities needed to attribute
  workspace facts and opaque participant references plus a cursor over one
  active workspace effect lineage. It is not the source of visible checkpoints.
  `RewindService` reads those from `HostRewindConversationHistory`, joins effect
  metadata by stable Prompt identity, and builds `safe`,
  `mergeable`, `conflict`, or `unsupported` plans through an injected workspace
  backend; the pure planner preserves non-overlapping later edits.
- Local mutation identity comes from the observed filesystem target key rather
  than recomputing ownership from the Prompt workspace. The local adapter uses
  the Prompt workspace only to render relative in-workspace paths, preflights
  all internal and external targets before writing, and rejects symbolic or
  hard-linked targets instead of silently following them.
- The injected `RewindRepository` persists that lineage independently of UI
  state. Its local adapter stores a versioned manifest plus content-addressed
  objects under the Harness home, uses atomic writes, a cross-process lock, and
  optimistic revision checks, quarantines invalid state, applies byte budgets,
  and conditionally removes stale history if a newer snapshot cannot be
  committed.
- Workspace and explicit participants form one optional reversible stage before
  `RewindTransaction` optionally commits a conversation fork. One transaction
  path supports code-and-conversation, conversation-only, and code-only restore.
  Memory payloads remain in its adapter, and any failed later conversation phase
  compensates completed code stages.
  Composer restoration first verifies attachment references through the Host
  store, then restores text and image drafts together after the fork succeeds.
  Presentation defaults safe and mergeable code plans to code-and-conversation,
  defaults blocked or code-empty plans to conversation-only, and lists exact
  paths before confirmation.
- Rewind 恢复已提交的对话，不恢复历史时点的待执行 inbox。通用 fork 的历史前缀
  可能包含入队事件，却不包含后来的出队事件，不能直接当作 rewind 的执行语义。
  社区 Host 的 `modules/rewind/adapters/fork` 独占这个策略，composition root 将
  `HostRewindFork.fork` 注入 Session transport；TUI 只调用和切换，不持有第二份队列。
- Host rewind 通过公开 `sessionQuery.observeSession` 读取并释放观察租约，要求精确的
  已完成 `turn/end` 锚点，保留到下一次 `turn/start` 之前的对话与轮间配置事实。
  委托 Agent 不可借此转换成普通根会话；普通分支保留 cwd、父会话血缘和当前 preset，
  但不复制运行时所有权或审批能力。原会话的日志与队列保持不变。
- 创建使用官方 `agents.create({ seed, inheritedEventCount, setup })`。`setup` 最先调用
  公开 `agent.inbox.clear()`，以新分支自己的取消事件退役所有继承待执行项，再挂载
  当前 preset；新 preset 与 `agent/session-start` 注入的新上下文必须保留。官方工厂
  验证、持久化 seed 和 setup 后缀，再发布 Session/Agent。首次观察新分支时旧队列
  已清除，重新载入也不会复活；不删改历史事件，不做发布后清队列或界面隐藏补偿。
- 模型绑定不复制官方 Controller 的私有实现，也不另装一套 `installModelSelection`。
  rewind 分支仍通过官方 Controller 的 `prompt`/`selectModel` 驱动；它在第一次唤醒
  前恢复 pending selection、request header 或默认模型，并安装自己的唯一绑定。
  setup 只做组合，不驱动 Agent；任意插件绕开 Controller 提前驱动不属于此入口契约。
- 创建/setup 失败不向 TUI 返回可打开分支，已有 RewindTransaction 补偿文件阶段。
  原子保证针对继承 inbox 的初始化，不扩大为所有 Host 资源的总事务：工作区关联
  公开 API 要求分支已经存在，因此仍在发布后执行。关联失败会释放未采用的 live
  Agent 并显式报错，但不伪称已有持久分支和通知被抹去。
- 不修改 `node_modules`、不使用依赖 patch、运行时 monkey-patch 或私有子路径导入。
  使用的 Host 服务显式声明依赖，仍跟随统一 DSH catalog；未来上游提供对应 fork
  策略时只替换 Host adapter，Session kernel、TUI 与 rewind 事务不新增兼容分支。
- 回归测试使用真实 AgentLoop、Controller、Session/投影与临时 JSONL 存储，覆盖首次
  发布、关闭后冷读重放、源会话不变、新 preset 上下文保留、setup 失败不发布、模型
  选择及新提示只执行一次；query/preset 端口用可控夹具，不访问用户会话或外部模型。
- New and resumed Sessions expose checkpoints directly from their logs, whether
  or not they own the code lineage. Another session replaces effect ownership
  only on its first attributed edit. Code restore moves a durable cursor and
  retains the future segment until a new attributed Prompt branches from the
  restored point; only backward code navigation is exposed in this milestone.

### Current lifecycle-kernel foundation

- The former controller and application God Object have been removed without a
  compatibility forwarding layer. The public application is a lifecycle facade;
  static composition and Session-feature composition are separate roots.
- A hierarchical lifecycle kernel now owns Application, connection, workspace,
  Session-epoch, feature, Surface, command, and effect resources. Session new,
  clear, resume, and Rewind share one latest-wins replacement protocol.
- One complete Session feature set is constructed per committed epoch and
  swapped through stable Hosts. `/clear` has an explicit suspend/rollback path;
  stale Session effects cannot commit after retirement.
- `TerminalSnapshot` is the single renderer publication boundary, followed by
  one coalescing `RenderScheduler`. Rendering no longer performs Session cleanup
  or infers feature lifecycle from an observed Session id.
- All terminal keys and pointer sequences pass through terminal normalization,
  contextual semantic resolution, and explicit action ownership. Scoped effects
  centralize cancellation, stale-result rejection, and live error reporting.
- `SurfaceHost` unifies decision and workspace surfaces, focus restoration,
  close identity, height clipping, key paging, and mouse-wheel routing. A modal
  Surface cannot overflow the terminal or scroll the Transcript behind it.
- The execution read model now has an unambiguous `runtime/execution` name and an
  incremental append path with canonical replay equivalence. Raw event retention
  remains deliberately unbounded until a correctness-preserving checkpoint
  contract exists.
- Dependency-direction tests enforce public entry points, allowed layer
  imports, single construction and placement owners, the raw-key boundary,
  and one concrete render request site.

### Memory session policy and learning

- Memory contributes stable usage guidance through `systemPrompt.section`;
  durable snapshots carry file content. Relevant remembered preferences apply
  when compatible with current instructions; a snapshot does not replace the
  current task or grant authority to change roles or permissions.
- Memory owns session switches in `<memory-root>/sessions/<sha256-session-id>.json`.
  Each file contains the complete `useMemories` / `generateMemories` selection;
  reads use the file directly and updates serialize through the existing file
  store before atomic replacement. Missing files use deployment defaults;
  unreadable or malformed files fail explicitly. Restoring the same session id
  restores its selection. New ids, including forks, use deployment defaults.
- The selected rc1 Session append API cannot mark downstream events `ignorable`,
  and persistence refuses unknown required events. Memory policy therefore
  belongs to the community Host service's files. Session-log export alone does
  not include it, and Rewind of conversation or memory content does not change
  the user's current session switches.
- `policy()` and `setPolicy()` are asynchronous. The TUI sends a partial change
  and displays the acknowledged result or pending state. After a failed change,
  it reads the current Host policy and displays it alongside the operation error.
  If that read also fails, switches become unknown and cannot be toggled until
  the dialog is reopened with a readable policy. The TUI owns no persistence or
  optimistic replacement of the saved value.
- Each source session owns one serial learning queue and cancellation scope.
  Disabling learning cancels its waiting and active work and waits for child
  disposal before acknowledging the change. Re-enabling admits future
  candidates; canceled candidates remain canceled. Source-agent disposal and
  Memory-service shutdown retire their owned work.
- Child-disposal failures propagate to callers waiting on learning or a disable
  and publish error activity. A failed drain does not undo the already-persisted
  disabled policy; it must not be acknowledged as successful cleanup.
- A learning child's creation signal ends at factory publication. Memory owns
  cancellation while waiting for the child and disposes the handle to stop and
  drain the real Agent loop. Temporary children use the maintenance policy
  while their source attribution is registered; they create no policy files.
- Memory tools forward cancellation to the file-mutation queue. Cancellation
  prevents entry into a queued logical write or forget; an admitted mutation
  finishes and publishes its source-attributed result before child disposal
  completes. Cancellation does not undo committed memory content.

### Following architecture work

- Add Session Query-backed cross-session search and parent/child lineage views.
- Add a remote Vision RPC only when Web or another out-of-process client becomes
  a real consumer; the in-process service is the Visual Input and Vision Proxy
  boundary.
- Add backward/forward timeline navigation on top of the retained cursor only
  when its interaction and branch-discard policy are exposed as one coherent
  Session Center workflow.
- Define a correctness-preserving execution checkpoint and eviction contract
  before bounding the in-memory Session event window.

### Extension rule

Do not add a generic terminal plugin or slot API in anticipation of unknown
consumers. Add the smallest semantic registration point only when at least one
independent extension needs it, and keep renderer-specific component types out
of the contract.

# TUI v0.1.6 Design: Configuration, Task, and User Extensions

- Status: implemented and released on 2026-08-16
- Target: the next patch after `v0.1.5`
- Harness baseline: `0.1.0-rc.6`, with capability-safe behavior across the
  declared `<0.2.0` range

## Summary

Version `0.1.6` adds three related product capabilities:

1. **Configuration** gives user-adjustable model, reasoning, permission, Plan
   Mode, and terminal preferences one scoped keyboard-first entry point.
2. **Task** keeps durable Goal, current Todos, and runtime actions together
   without presenting execution state as configuration.
3. **User Extensions** makes effective Host commands and user-invocable Skills
   discoverable from one slash catalog, then adds safe local Skill creation and
   editing without inventing another prompt-command format.

The Host remains the source of truth. The terminal owns interaction state,
request phases, local authoring mechanics, and presentation only.

## Goals

- A user can distinguish configurable session/TUI values from current task
  lifecycle and progress without opening raw event details.
- A user can change permission, Plan Mode, and Goal state through canonical
  Host write paths.
- A user can discover and invoke a project or user Skill with the same `/name`
  text understood by every Harness client.
- A user can create or edit a local Markdown Skill from the TUI and see it
  appear after successful validation.
- Commands and Skills share one discovery experience while retaining different
  semantics and execution paths.
- Every feature handles capability absence, stale requests, session switching,
  and narrow terminals explicitly.

## Non-goals

- Creating executable Harness Command plugins inside the TUI.
- Saving arbitrary shell strings as slash commands.
- Editing remote, custom-provider, bundled, or preset-scoped Skill bodies.
- Replacing `$VISUAL`, `$EDITOR`, an IDE, or the system file opener with a new
  Markdown editor.
- Persisting a second copy of plan, goal, permission, todo, command, or Skill
  state.
- Displaying an approved plan document that the Host does not expose as a
  durable value. The Plan row represents collaboration mode, not a plan file.
- Subagent, Job, Session Center, plugin configuration, or workspace-wide change
  review. Those remain later roadmap milestones.

## Domain vocabulary

| Concept | Authority | Meaning in the TUI |
| --- | --- | --- |
| Permission | `permissions` projection and `/permission` Host command | Effective sandbox and approval preset |
| Plan | `plan` projection and `/plan` Host command | Active/pending planning collaboration state |
| Goal | `goal` projection and Goal RPC methods | Durable objective, phase, revision, rounds, and block reason |
| Todos | `todos` projection | Agent-owned current execution checklist; read-only to the human UI |
| Command | `ctx.commands`, dispatched by the TUI Host-command port | Deterministic human action whose result does not enter model history |
| Skill | `skill.list` plus `/name` in an ordinary prompt | Reusable model instructions loaded by the Host |

Commands and Skills may look similar in a slash menu, but they are not
interchangeable. A reusable review or release workflow is a Skill. Permission,
Plan, Goal, session, and UI operations remain Commands or structured APIs.

## Verified Harness contracts

The design relies on contracts present in `0.1.0-rc.6`:

- `SessionProjectionMap` is augmented with optional-at-composition `permissions`,
  `plan`, `goal`, and `todos` values. A missing key means the capability is not
  composed. `goal: null` and `todos: null` mean the capability exists but has no
  current value.
- `/permission <preset>` and `/plan [off|message]` are Host commands. Their
  `command/run` and `command/done` events are durable, standalone lifecycle
  records.
- The terminal's in-process composition exposes a narrow Host-command port
  backed by `ctx.commands.execute(agent, line, signal)`. Resolved Commands never
  pass through model prompting. This explicit port also avoids relying on the
  `rc.6` `session.prompt` declaration whose shipped implementation does not
  perform the documented command interception.
- Goal create/edit/pause/resume/complete/clear mutations are available through
  `IApiClient.goals` and use compare-and-set `GoalRef` revisions.
- `IApiClient.skills.list({ sessionId })` returns the effective user-invocable
  Skill catalog for the session workspace. Invocation itself is an ordinary
  `session.prompt` containing `/name`; there is no Skill invocation RPC.
- Skill RPC rows expose name, description, optional `whenToUse`, and whether the
  Skill is model-invocable. They deliberately do not expose provider, source,
  path, rank, or shadowed definitions.
- The shipped filesystem provider watches project and user Skill roots and
  invalidates discovery after frontmatter changes.

The TUI must not reach into `ctx.planMode`, `ctx.permissionPresets`, or
`ctx.goals` for convenience. Reads use projections and public APIs; writes use
the narrow Host-command port or Goal RPCs. The session controller stays
transport-neutral and never interprets command text itself.

## User experience

### Compact task status

The existing status area gains one restrained task summary assembled only from
available projections:

```text
workspace-write · Plan active · Goal 2/8 · Tasks 1/4
```

Rules:

- Omit a capability whose projection key is absent.
- Render `Plan pending` distinctly from the active state because a selection
  may be waiting for the next accepted step.
- Show Goal phase and `roundsStarted/maxGoalRounds`; show a shortened block
  reason only while blocked.
- Show Todo completion count and whether any item is in progress. Do not retain
  an older list when the authoritative projection becomes `null`.
- Do not make the normal composer taller solely to show detailed controls.

### `/config` and `/task` surfaces

`/config` is the TUI-local configuration center. Its rows show an explicit
scope so a session value is not mistaken for a persistent global setting.

```text
Config

› Model        deepseek-official/deepseek-v4-pro  Session
  Reasoning    max                                Session
  Permission   workspace-write                    Session
  Plan Mode    active                             Session
  Details      compact                            TUI
```

`/task` is the independent execution surface:

```text
Task

› Goal         active · 2/8 rounds                Session
  Tasks        1 completed · 1 in progress        Session
  Runtime      running · 1 queued                  Session
```

`/config` and `/task` do not replace or shadow canonical `/permission`, `/plan`,
or Goal write paths.

Bare `/permission` is a TUI decoration of the existing Host command: it opens
the Permission action list directly. `/permission <preset>` remains an argued
Host execution. Both paths read the same projection options and submit through
the same Host-command port; neither command text nor its result enters model
history.

Interaction:

- `j`/`k` and arrows move between rows.
- `Enter` opens the selected row's actions or details.
- `h`/`l` or left/right move between an action list and its detail when needed.
- `Esc` returns one level, then closes the surface.
- `g`/`G` move to the first or last row when the Todo list is expanded.
- Mouse support may follow the existing selector conventions but is not a
  release blocker.

Capability rows remain in a stable order. An absent capability is shown as
`Unavailable in this profile` inside the owning surface so users can diagnose
the composition, while it remains absent from the compact status.

### Permission flow

1. Read `permissions.options` and `currentValue` from the projection.
2. Let the user select only an advertised preset option; the derived `custom`
   value is current-only and is never submitted as a switch target.
3. Require a confirmation when the selected option widens to
   `danger-full-access`. The confirmation describes the advertised preset; the
   TUI does not infer hidden enforcement details.
4. Execute `/permission <value>` through the Host command path.
5. Keep the projection value authoritative. Show only request-local progress
   until a newer projection arrives; never optimistically change permission.
6. Render command failure verbatim as an error notice and retain the current
   selection.

### Plan flow

1. Read `plan.active` and `plan.pending` from the projection.
2. Enter Plan Mode through `/plan`; leave through `/plan off`.
3. If a transition is pending, show both the effective state and pending
   intent. Do not claim the transition has committed.
4. Plan review continues through the existing structured-question/approval
   channel. The Config surface does not create a parallel review protocol.

### Goal flow

The Goal section uses structured RPCs rather than parsing `/goal` output:

- No current Goal: create from a non-empty objective and optional round cap.
- Active: edit, pause, complete, or clear.
- Paused/blocked: edit, resume, complete, or clear when the Host accepts it.
- Complete: show the durable result; create replacement behavior follows Host
  validation rather than TUI assumptions.

Every mutation submits the current `GoalRef`. The UI records only a local
request phase. Success is settled when the projection reaches the returned
revision; a newer unrelated revision wins. CAS conflicts refresh the view and
explain that the Goal changed elsewhere instead of retrying blindly.

### Todo flow

Todos are a read-only execution view:

- Preserve Host order.
- Use one symbol for pending, one active marker for `in_progress`, and a compact
  completed mark.
- Display parallel `in_progress` rows without treating the projection as
  invalid.
- Never let the human editor mutate Todo state directly in `v0.1.6`; the model
  tool owns the whole-list replacement contract.

### Unified slash catalog

The editor's slash experience becomes a typed catalog:

```text
Commands
  /permission  Switch the permission preset
  /plan        Enter or leave Plan Mode

Project and user Skills
  /release     Verify and publish a release
  /review      Review the current changes
```

Resolution rules:

1. TUI-local Commands shadow Host Commands, matching the existing behavior.
2. The effective Command catalog shadows a Skill with the same name, matching
   Harness's shipped client behavior.
3. An exact Skill candidate remains ordinary prompt text; the Host performs the
   authoritative user-invocation lookup and instruction injection.
4. An exact Host Command executes through the command port and never falls back
   to `session.prompt`, even when its handler fails or disappears during a
   catalog race.
5. A syntactically valid but unknown leading slash token is rejected locally
   with a discovery hint instead of being accidentally sent to the model.
6. Ordinary text and slash tokens later in a larger prompt are not rewritten;
   the Host remains authoritative for its whitespace-bounded Skill gesture.

Candidate rows carry an explicit `command` or `skill` kind. A colliding Skill is
not offered as invocable and Skill creation warns before writing it. The
catalog never invents provider or source labels absent from the Skill RPC.

### Skill catalog and invocation

`/skills` opens a searchable, keyboard-first list:

- name, description, optional `whenToUse`, and user-only marker;
- a details view explaining whether the model may invoke it independently;
- `Enter` inserts `/name ` into the composer rather than executing an alternate
  invocation path;
- `n` starts local Skill creation;
- `e` edits only a local file resolved by the authoring capability;
- provider-managed rows remain invocable but read-only.

Catalog refresh occurs when the active session changes, when `/` or `/skills`
opens after the cache is stale, and immediately after local authoring. The
catalog source is abort-aware and the cache is generation-bound so an older
session response cannot replace the new session catalog; the `rc.6` list RPC
itself has no transport cancellation parameter, so late results are ignored.
Provider failures retain the last good catalog for the same session and display
a non-blocking stale/error marker.

### Local Skill creation and editing

The first authoring implementation supports two explicit targets:

```text
Project: <nearest-git-root>/.dsh/skills/<name>/SKILL.md
User:    <dsh-home>/skills/<name>/SKILL.md
```

Creation collects:

- target scope;
- kebab-case name;
- non-empty description;
- optional `whenToUse`;
- user/model invocation policy.

It writes the public Harness filesystem format:

```markdown
---
name: release
description: Verify and publish a release
whenToUse: Use after an intended change is complete
disable-model-invocation: false
user-invocable: true
---

# Release

Describe the workflow here.
```

Safety and consistency rules:

- Resolve and validate the destination beneath the selected root; names never
  become arbitrary paths.
- Create atomically and refuse to overwrite an existing file or bundle.
- Validate the same documented name, required fields, and invocation booleans
  before opening the editor and again after it exits.
- Suspend terminal input and raw-mode ownership while a terminal editor runs;
  restore the TUI even when the editor exits non-zero or is interrupted.
- Prefer `$VISUAL`, then `$EDITOR`; fall back to the Host file opener or show a
  copyable path when no editor is available.
- Refresh the effective Host catalog after the filesystem watcher settles. A
  valid local file that is shadowed by another provider is reported as
  `created but not effective`, not falsely shown as active.
- Editing is offered only when the local authoring adapter can resolve an exact
  effective file. `v0.1.6` does not delete Skills.

## Architecture

The implementation extends the current layer-based layout instead of adding a
second feature framework:

```text
src/
├── runtime/
│   ├── session-controls.ts # pure scoped Config and Task read models
│   ├── skill-catalog.ts  # generation-bound per-session ApiProxy catalog cache
│   └── slash-catalog.ts  # command/skill merge and resolution rules
├── application/
│   ├── skill-authoring.ts # local authoring port and filesystem adapter
│   ├── skill-authoring-coordinator.ts # file/editor/validation/catalog transaction
│   └── external-editor.ts # suspend/spawn/restore process boundary
└── presentation/
    ├── config/
    │   └── config-view.ts # model, policy, and terminal settings
    ├── task/
    │   └── task-view.ts   # Goal, Todo, and runtime lifecycle
    ├── skills.ts         # catalog and details
    └── skill-authoring.ts # local creation wizard
```

Tests mirror the same ownership. A file becomes a directory only after it gains
multiple independently meaningful modules.

### Runtime contracts

```ts
interface ConfigurationSnapshot {
  models: SessionModels | undefined
  permissions?: SessionProjectionMap['permissions']
  plan?: SessionProjectionMap['plan']
  detailsExpanded: boolean
}

interface TaskSnapshot {
  goal?: SessionProjectionMap['goal']
  todos?: SessionProjectionMap['todos']
  running: boolean
  queued: number
}

type SlashCandidate =
  | { kind: 'command'; name: string; description: string; argumentHint?: string }
  | { kind: 'skill'; name: string; description: string; whenToUse?: string; modelInvocable: boolean }

interface SkillCatalogPort {
  list(sessionId: string, signal: AbortSignal): Promise<readonly SkillCatalogEntry[]>
}

interface SkillAuthoringPort {
  targets(cwd: string): Promise<readonly SkillAuthoringTarget[]>
  create(request: CreateLocalSkillRequest): Promise<LocalSkillDocument>
  resolveEditable(cwd: string, name: string): Promise<LocalSkillDocument | undefined>
  validate(document: LocalSkillDocument): Promise<SkillValidationResult>
}
```

These are TUI-owned narrow ports, not copies of the Host services. Host types
remain embedded in the transport adapter and projection boundary; presentation
components consume detached, renderer-ready values.

### Dependency direction

```text
presentation -> runtime view models and application callbacks
application  -> runtime ports + local filesystem/process adapters
runtime      -> ApiProxy and client-domain types
```

- Runtime modules never import pi-tui, Node filesystem, or process spawning.
- Presentation modules never call ApiProxy, Cordis services, or `node:fs`.
- Local authoring never mutates Host task state.
- `TuiApplication` composes the capabilities but does not own their domain
  algorithms.

### End-to-end data flow

```text
history baseline + projection frames
                 ↓ higher-seq-wins reconciliation
              TuiState
                 ↓ pure selectors
  ConfigurationSnapshot / TaskSnapshot / SlashCatalog
                 ↓
       presentation and user selection
                 ↓
  Host command | Goal RPC | ordinary Skill prompt
                 ↓
        durable event + newer projection
                 └─────────────── back to TuiState
```

Local Skill authoring is intentionally adjacent rather than inserted into that
domain loop:

```text
/skills -> SkillAuthoringPort -> atomic local file -> external editor
                                                ↓
                                    filesystem provider watcher
                                                ↓
                                      skill.list refresh
```

The UI never treats a successful file write as proof that the Skill is the
effective catalog winner.

### State and concurrency

- Projection values remain part of `TuiState`; `ConfigurationSnapshot` and
  `TaskSnapshot` are pure read models, not second stores.
- Local UI request state uses operation ids and the controller generation. A
  session switch invalidates every in-flight Task or Skill operation.
- One mutation per domain may be active at a time. Permission, Plan, and Goal
  operations may run independently but duplicate submissions are blocked.
- Skill catalog fetches are single-flight per session and abort on replacement.
- Editor suspension is exclusive; approval, question, rewind, or another modal
  cannot open until terminal ownership returns.

### Compatibility behavior

| Condition | Behavior |
| --- | --- |
| Projection key absent | Hide compact chip; show unavailable row in `/config` or `/task` |
| Goal RPC rejected or unavailable | Keep read-only Goal state and explain the failure |
| Skill RPC unavailable | Commands continue; `/skills` reports unavailable |
| Skill authoring unavailable | Catalog and invocation continue read-only |
| Catalog fetch stale/fails | Retain same-session last good rows with stale marker |
| Command/Skill name collision | Command wins; creation warns and does not claim invocability |
| Editor fails | Restore terminal, preserve file, show validation/editor result |
| Harness adds fields | Ignore unknown optional fields at the presentation boundary |

### Readability and maintenance rules

- Prefer discriminated unions (`command | skill`, explicit operation phases)
  over coupled boolean flags.
- Keep pure projection-to-view selectors separate from asynchronous API and
  filesystem effects.
- Name methods after domain actions (`dispatchHost`, `pauseGoal`,
  `refreshSkills`) rather than generic `handle` or `update` helpers.
- Keep one authoritative path for each write. A presentation shortcut delegates
  to the same action; it does not duplicate validation or mutation logic.
- Comments explain upstream contracts, races, capability absence, and safety
  boundaries. They do not narrate obvious control flow.
- Do not split files by line-count target. Split when a port, pure model,
  process boundary, or independent view has its own tests and lifecycle.
- Public exports remain narrow. Implementation-only authoring and presentation
  types stay internal until an independent consumer needs them.
- Tests describe observable domain behavior and failure recovery rather than
  private method order.

## Testing strategy

### Pure unit tests

- Every combination of absent, empty, active, pending, blocked, complete, and
  custom projection values.
- Goal CAS revision settlement and stale-session invalidation.
- Command/Skill merging, sorting, grouping, aliases, and collision precedence.
- Exact Skill invocation remains unchanged prompt text.
- Bare `/permission` opens the picker; argued Permission and other known Host
  Commands execute without invoking the session prompt path.
- Unknown leading slash rejection does not affect ordinary prompts.
- Skill target resolution, traversal rejection, atomic collision handling,
  frontmatter validation, and invocation-policy combinations.

### Controller and integration tests

- Permission and Plan actions travel through Host commands and settle from
  command/projection events rather than optimistic state.
- Goal mutations use the latest ref and handle a concurrent revision.
- History baseline plus newer projection frames preserve higher-seq-wins.
- Session switching aborts Task actions and Skill discovery.
- A created Skill becomes discoverable after refresh; shadowed and malformed
  entries are reported honestly.
- External editor exit, signal interruption, and non-zero status always restore
  terminal ownership.

### Presentation and terminal tests

- `j`/`k`, arrows, Enter, Esc, `g`/`G`, and narrow/wide layouts.
- Widths 80, 120, and 160 with color on/off.
- Long objectives, descriptions, block reasons, and Todo content wrap without
  hiding state or controls.
- Permission widening requires confirmation.
- Empty, unavailable, loading, stale, and error states remain visually distinct.

### Compatibility tests

- Compile against the minimum declared Harness surface and the release target.
- Verify optional projection keys do not become mandatory through imports.
- Pack the root distribution and launch the composed `tui-dev` profile with a
  project Skill, a user-only Skill, and a command-name collision.

## Acceptance criteria

1. Resume and history replacement reconstruct the same Config and Task state.
2. Permission, Plan, Goal, and Todos never derive from only the visible event
   page when their projections are composed.
3. `/config` and `/task` are fully usable with keyboard navigation at 80
   columns.
4. Permission widening is confirmed and never displayed before the Host commits
   it.
5. Plan pending state is distinguishable from effective Plan Mode.
6. Goal mutations are CAS-safe and a concurrent revision is not overwritten.
7. Commands and Skills appear in one slash catalog with Command precedence.
8. Selecting a Skill sends the canonical `/name` prompt unchanged.
9. Unknown leading slash input cannot accidentally become a model prompt.
10. A locally created valid Skill appears after refresh or reports why it is
    not effective.
11. An editor failure cannot leave the terminal in raw, mouse-capture, or
    input-detached state.
12. Profiles without one or more capabilities retain the existing conversation,
    command, memory, rewind, and trajectory behavior.

## Delivery slices

1. **Contracts and safety net:** client type augmentations, pure Config/Task
   models, Slash catalog model, fixtures, and capability-absence tests.
2. **Scoped visibility:** compact status plus separate `/config` and `/task`
   surfaces.
3. **Domain mutations:** Permission and Plan command actions in Config, then
   structured Goal mutations, Todo details, and runtime cancellation in Task.
4. **Skill discovery:** ApiProxy catalog cache, grouped autocomplete, invocation
   adjudication, and `/skills` read-only view.
5. **Skill authoring:** local targets, atomic scaffold, validation, external
   editor lifecycle, and refresh.
6. **Release hardening:** PTY/golden tests, documentation, full check, pack dry
   run, and manual acceptance in the isolated development profile.

Each slice should be independently reviewable and keep the package buildable.
Do not begin the next slice while the previous slice's domain and failure-path
tests are incomplete.

## Future extension points

- Session Center can reuse the same capability/operation pattern for titles,
  search, lineage, and archive actions.
- Agent and Job surfaces can reuse the grouped, keyboard-first inspect/action
  shell without sharing Config or Task domain models.
- A future provider-neutral Skill authoring RPC can replace the local adapter
  behind `SkillAuthoringPort` without changing presentation.
- Real custom Commands remain Cordis plugins. If demand appears, a separate
  developer command can scaffold a plugin package; it must not turn Skill files
  into executable shell aliases.
- Config, Task, and Skill state may later join an immutable terminal session snapshot,
  but `v0.1.6` should first prove the consumer boundaries with current
  projections and ApiProxy contracts.

## References

- [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [Human Commands](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/commands.md)
- [Plan Mode](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/plan.md)
- [Same-session Goals](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/goal.md)
- [Permission Presets](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/permission-presets.md)
- [Skills](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md)
- [Web Skill slash behavior](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-skill/README.md)

# TUI v0.1.9: Source-Attributed Rewind

## Outcome

Rewind restores only workspace mutations that the Host can attribute to the
active Agent execution. It never treats “changed during a turn” as ownership.
The same confirmation coordinates workspace, Memory, and conversation rollback
without copying Rewind policy into the session log or presentation layer.

## Ownership

```text
Host execution events
  fs/observed + tools/result + tool/call
                  │ exact execution and source identities
                  ▼
rewind/adapters/host
  validate canonical text-mutation outcome
                  │ WorkspaceMutationInput
                  ▼
RewindService ───────── MemoryRewindParticipant
  application policy      opaque payloads · settle · restore
        │
        ├── RewindJournal
        │     active timeline · cursor · mutation order · effect references
        ├── RewindRepository ─── FileRewindRepository
        │     opaque snapshot      versioned manifests · content objects
        └── LocalWorkspaceRewind
              path safety · pure planner · guarded file transaction
                  │ RewindPointSummary / immutable RewindPlan
                  ▼
RewindTransaction
  reversible participants -> conversation commit -> compensation
                  │
                  ▼
TUI application and dialogs
  selection · exact paths · status · confirmation only
```

- The Host adapter owns event vocabulary and source correlation.
- Pure contracts and domain modules import no Cordis, Memory, Node, or pi-tui
  types.
- The Rewind service owns history, restore classification, participant order,
  and reversible compensation through injected ports.
- The Repository port owns no domain decisions. Its file adapter supplies
  atomic, bounded, integrity-checked storage below the Harness home.
- The application transaction owns the final conversation commit boundary.
- Presentation owns no mutation detection or restore policy.

## Accepted mutation contract

A workspace mutation is accepted only when all of these facts agree:

1. `fs/observed` reports a present target for an execution object.
2. `tools/result` reports success for that exact execution object.
3. The canonical result has the strict filesystem edit shape
   `{ path, before, after }` or write shape
   `{ path, operation, before, after }`.
4. The result path equals the observed target path.
5. The root model call exists in the Agent session log and supplies the turn.
6. The target is a local path inside the turn's workspace root.

Tool names, arguments, rendered Diff cards, Git status, and elapsed execution
windows are not ownership evidence. An update with a missing `before` value is
recorded as unsupported. A mutation that does not publish this contract is
excluded rather than inferred.

The observation event also assigns mutation order before result finalization.
This preserves correct reverse order when parallel calls finish their result
pipelines in a different order from their filesystem commits.

## Restore planning

The selected boundary includes its turn and every later retained turn.
Mutations are grouped by path and reversed newest-first against the current
file content.

| State | Meaning | Restore |
| --- | --- | --- |
| `safe` | Current content is the exact recorded after-state | Enabled |
| `mergeable` | Every reverse patch applies with exact context while preserving later non-overlapping edits | Enabled |
| `conflict` | A file is missing, non-text, changed after preview, or overlaps an AI edit | Disabled |
| `unsupported` | The provider omitted the before-state or the target is outside the local workspace | Disabled |

AI-created files are removed only when their current content still equals the
recorded after-state. A changed created file is a conflict because deleting it
would discard unowned work.

## Transaction

1. Wait for already-scheduled Memory learning for the source session to settle,
   then prepare one stable set of attributed workspace and Memory mutations.
2. Preflight all attributed workspace files against the prepared plan.
3. Apply workspace targets atomically per file; compensate already-applied
   files if any workspace write fails.
4. Revert Memory mutations newest-first using Memory's stale guards.
5. Fork or recreate the conversation before the selected turn.
6. If Memory or conversation fails, reapply Memory and compensate workspace.
7. Move the timeline cursor before the selected point, assign the forked
   session as owner, retain the future segment, and refill the prompt.

No step changes the Git index, executes `git reset`, or scans unrelated files.
Workspace mutation content is bounded per mutation and per session; an edit
that exceeds either byte budget is explicitly `unsupported` rather than being
retained without limit.

## Durable timeline

Rewind persists one active editing lineage per canonical workspace under
`$DSH_HOME/rewind/v1`. A versioned manifest contains identities, ordering,
cursor state, and content hashes; workspace states and opaque participant
payloads live in SHA-256-addressed objects. Writes are atomic and serialized by
a cross-process lock. Each save also compares the revision loaded by its
process, so a stale TUI cannot overwrite or delete a newer process's lineage.
Invalid manifests are quarantined instead of repaired by guessing, and a failed
newer save conditionally invalidates its older revision so a restart cannot
expose that stale history as current.

The default limits are 20 points, 16 MiB per content object, 64 MiB per
timeline, and 512 MiB globally. Global compaction evicts the least recently
updated workspace lineage. The manifest and objects are private Harness data,
not project files and not Git state.

Resuming the owner session activates the durable lineage before Rewind is
listed. Merely opening another session does not discard it; that session claims
the workspace lineage only when it records its first attributed workspace or
participant mutation. After Rewind, future nodes remain behind the cursor until
the forked session starts a new durable turn, at which point that future is
discarded as a new branch. Forward navigation is intentionally not presented in
this version.

The Host session log remains authoritative for conversation events. A custom
downstream Rewind event is not appended because the current session event
registry cannot safely register that event as a required or ignorable durable
type. The Repository therefore stores only Rewind-owned facts through an
injected boundary; it is not a second conversation log.

## Scope and evolution

Binary mutation support, renames, and remote filesystem identities require
explicit provider contracts before they can participate. A second real client
can move contracts, domain, application, and Repository interfaces into a
standalone workspace without moving the TUI, Host, Memory, or local-filesystem
adapters. Full backward/forward time navigation can consume the retained cursor
model without changing mutation capture or persistence ownership.

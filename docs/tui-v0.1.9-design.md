# TUI v0.1.9: Source-Attributed Rewind

## Outcome

Rewind restores only workspace mutations that the Host can attribute to the
active Agent execution. It never treats “changed during a turn” as ownership.
The same confirmation coordinates workspace, Memory, and conversation rollback
without copying Rewind policy into the session log or presentation layer.

## Ownership

```text
Session event log
  turn/start + user/message(source=user)
                  │ stable identity · text · durable attachment references
                  ▼
runtime/lifecycle/host ── PromptNode ── rewind/adapters/conversation
                  │ canonical RewindConversationHistory
                  ├─────────────────────────────────────┐
Host execution events
  fs/observed + tools/result + tool/call
                  │ exact execution and source identities
                  ▼
rewind/adapters/host
  validate canonical text-mutation outcome
                  │ WorkspaceMutationInput
                  ├─────────────────────────────────────┤
MemoryRewindParticipant ─── RewindEffectInput ──────────┤
                                                        ▼
                                                   RewindService
                                                application policy
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
  optional attachment preflight -> optional reversible effects -> optional conversation fork
                  │
                  ▼
TUI application and dialogs
  selection · exact paths · status · confirmation only
```

- The lifecycle Host projection owns the one definition of an accepted human
  prompt. Text, native-image, and proxy-image submission all become the same
  `PromptNode` only after the canonical user message is committed. That node
  owns the complete restorable input: text plus immutable attachment references.
- The conversation adapter replays `turn-entry` nodes from the active Session
  log as visible Rewind points. The Prompt adapter supplies the same projection
  to the ordered effect-attribution path. The workspace Host adapter owns only
  filesystem event vocabulary and source correlation.
- Pure contracts and domain modules import no Cordis, Memory, Node, or pi-tui
  types.
- The Rewind service joins Session-owned checkpoint history with Journal-owned
  effect metadata and owns restore classification, participant order, and
  reversible compensation through injected ports.
- The Repository port owns no domain decisions. Its file adapter supplies
  atomic, bounded, integrity-checked storage below the Harness home.
- The application transaction owns the independent code and conversation commit
  dimensions.
- Presentation owns no mutation detection or restore policy.

## Prompt boundary contract

Every Prompt originates from an appended `user/message` whose source is `user`,
inside an open turn. The lifecycle projection explicitly classifies it as the
`turn-entry` Prompt or an `in-turn` Prompt. Rewind consumes only `turn-entry`
because the Host can fork at completed-turn boundaries; listing an in-turn steer
would promise a conversation state that cannot be restored faithfully. The
durable message id is also the stable point id, its event time is the point
time, and the preceding completed turn supplies the conversation fork boundary.
Rewind does not inspect pre-step message batches or infer prompts from model
input.

A proxy-image submission therefore has one point: the admitted human message.
The Vision submission carrier creates no point, and the source-attributed
Vision evidence is a child of the Prompt lifecycle node rather than another
user checkpoint. Its durable image references enrich the same Prompt snapshot;
the evidence carries the admitted message's stable `promptId`, so association
never depends on event proximity or whichever Prompt happens to be latest, and
it cannot create a second Rewind row. A rejected preparation has no admitted
user event and creates no point. The same projection applies during replay and
session resume. Native-image blocks and proxy evidence therefore converge on
one `PromptInput { text, attachments }` contract.

Prompt points and same-turn effects enter `RewindService` through one ordered
per-session queue. This preserves causality when the post-commit Session event
observer starts durable activation while a fast tool result or Memory mutation
arrives immediately afterward. Persistence remains serialized separately and
never blocks Agent prompt admission.

## Accepted mutation contract

A workspace mutation is accepted only when all of these facts agree:

1. `fs/observed` reports a present target for an execution object.
2. `tools/result` reports success for that exact execution object.
3. The canonical result has the strict filesystem edit shape
   `{ path, before, after }` or write shape
   `{ path, operation, before, after }`.
4. The result path equals the observed target path.
5. The root model call exists in the Agent session log and supplies the turn.
6. The observed filesystem target supplies a local canonical absolute identity.
   It may be outside the turn's workspace root when that edit was authorized.
7. The display path and target identity do not cross a symbolic-link boundary,
   and the target is not hard-linked.

Tool names, arguments, rendered Diff cards, Git status, and elapsed execution
windows are not ownership evidence. An update with a missing `before` value is
recorded as unsupported. A mutation that does not publish this contract is
excluded rather than inferred.

The observation event also assigns mutation order before result finalization.
This preserves correct reverse order when parallel calls finish their result
pipelines in a different order from their filesystem commits.

## Restore planning

The selected Prompt boundary includes its turn and every later retained turn.
Mutations are grouped by path and reversed newest-first against the current
file content.

| State | Meaning | Restore |
| --- | --- | --- |
| `safe` | Current content is the exact recorded after-state | Enabled |
| `mergeable` | Every reverse patch applies with exact context while preserving later non-overlapping edits | Enabled |
| `conflict` | A file is missing, non-text, changed after preview, or overlaps an AI edit | Disabled |
| `unsupported` | The provider omitted the before-state, the target is not local, or the path is symbolic/hard-linked | Disabled |

AI-created files are removed only when their current content still equals the
recorded after-state. A changed created file is a conflict because deleting it
would discard unowned work.

## Transaction

1. For an action that restores conversation, read and verify every selected
   Prompt attachment through the Host attachment service. A missing or
   inconsistent object aborts before any mutation.
2. Wait for already-scheduled Memory learning for the source session to settle,
   then prepare one stable set of attributed workspace and Memory mutations.
3. Preflight every attributed local target across all roots against the prepared
   plan before writing any file.
4. If code restore is selected, apply workspace targets atomically per file and
   compensate already-applied files if any workspace write fails.
5. If code restore is selected, revert Memory mutations newest-first using
   Memory's stale guards.
6. If conversation restore is selected, fork or recreate the conversation
   before the selected turn.
7. If a later conversation phase fails, reapply Memory and compensate workspace.
8. Commit the selected dimensions: move the effect cursor only for code restore,
   transfer ownership only for a conversation fork, and refill Composer text
   and image drafts only from a verified conversation restore.

No step changes the Git index, executes `git reset`, or scans unrelated files.
Workspace mutation content is bounded per mutation and per session; an edit
that exceeds either byte budget is explicitly `unsupported` rather than being
retained without limit.

## Durable timeline

Rewind persists one active reversible-effect lineage per canonical workspace
under `$DSH_HOME/rewind/v2`. Visible checkpoints are rebuilt from the Host
Session log, while the versioned manifest retains only the Prompt identity and
metadata needed to join event ordering, cursor state, workspace content hashes,
and opaque participant effects. Workspace states and participant payloads live
in SHA-256-addressed objects. Writes are atomic and serialized by
a cross-process lock. Each save also compares the revision loaded by its
process, so a stale TUI cannot overwrite or delete a newer process's lineage.
Invalid manifests are quarantined instead of repaired by guessing, and a failed
newer save conditionally invalidates its older revision so a restart cannot
expose that stale history as current.

The default limits are 20 points, 16 MiB per content object, 64 MiB per
timeline, and 512 MiB globally. Global compaction evicts the least recently
updated workspace lineage. The manifest and objects are private Harness data,
not project files and not Git state.

Resuming any session lists its Prompt checkpoints from that Session immediately;
the effect owner is not a visibility gate. Merely opening another session does
not discard the durable lineage; that session claims it only when it records its
first attributed workspace or participant mutation. Code restore keeps future
effect nodes behind the cursor until the owning session admits a new attributed
`turn-entry` Prompt, at which point that future is discarded as a new branch.
Forward code navigation is intentionally not presented in this version.

The Host Session log remains authoritative for both conversation events and
visible Prompt checkpoints. A custom
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

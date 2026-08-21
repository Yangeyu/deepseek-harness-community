# TUI Product Roadmap

The community TUI should evolve from a single-session chat client into a
keyboard-first execution console for DeepSeek Harness. It should make the
Host's durable state easier to control and inspect without creating a second
agent loop, permission system, task model, or plugin format.

## Product principles

1. **Control before chrome.** Add capabilities that improve task intent,
   safety, recovery, review, and reuse before adding decorative surfaces.
2. **Host facts remain authoritative.** Plans, goals, permissions, todos,
   commands, jobs, subagents, sessions, and skills come from Harness services,
   commands, events, or projections.
3. **Keyboard-first, progressively disclosed.** The normal conversation stays
   compact. Rich controls open only when requested and remain usable in narrow
   terminals.
4. **One concept per job.** Skills are reusable model instructions. Commands
   are deterministic human actions. The TUI must not introduce a third prompt
   macro format that overlaps both.
5. **Optional capabilities degrade cleanly.** A missing projection or RPC means
   that feature is unavailable in the active composition, not that the session
   is corrupt.
6. **Developer preview is a compatibility constraint.** Harness is still
   evolving below `0.2.0`; new integrations need narrow ports, capability
   checks, and contract tests rather than direct UI-to-plugin coupling.

## Product flow

```text
Prepare                    Execute                  Review                 Reuse
permissions · vision  ->  goal · todos · agents -> changes · trace   -> skills · sessions
```

The TUI is already strong in the middle of one session: streaming output,
visual evidence, tool and diff rendering, memory, and a unified execution
lifecycle beneath transcript and trajectory inspection. The next milestone
rebuilds Rewind around source-attributed mutations and conflict-aware recovery,
then completes the session, parallel-work, review, and reuse loops around that
execution core.

## Milestones

### v0.1.6 — Configuration, Task, and User Extensions

- Show the effective permission preset, plan state, goal lifecycle, and current
  todo progress without refolding Host-owned whole-log state.
- Add a scoped `/config` center for model, reasoning, permission, Plan Mode,
  and terminal preferences, plus a separate `/task` surface for Goal, Todo,
  and runtime actions while preserving canonical Host commands.
- Merge TUI commands, Host commands, and user-invocable skills into one grouped
  slash catalog with deterministic collision handling.
- Add `/skills` discovery plus safe local project/user skill creation and
  editing through a dedicated authoring capability.
- Keep real command authoring plugin-owned; reusable prompt workflows are
  authored as Skills.

### v0.1.7 — Visual Input and Vision Proxy

- Align composer semantics with established terminal-agent interaction:
  `Enter` steers, `Tab` queues while working, and `Alt+Enter` remains multiline.
  Resolve semantic actions through a persistent, context-aware keymap instead
  of hard-coding gestures in the application shell.
- Support repeatable `-i`/`--image` startup attachments for portable scripted,
  new-session, and resumed-session image intake.
- Add explicit image drafts from files and the system clipboard with a compact,
  keyboard-first attachment rail above the composer.
- Introduce a public, TUI-independent Vision workspace that routes explicit
  image-capable models natively and text-only models through a configured proxy.
- Use the existing generic LLM adapter for Alibaba Cloud Bailian and recommend
  `qwen3.7-plus` as the first proxy route while DeepSeek remains the primary
  coding model.
- Persist proxy image references, observations, status, usage, and duration as
  source-attributed session evidence visible in Transcript and Trajectory.
- Configure Vision under `/config`, fail closed on missing capability or
  credentials, and keep secrets and originating local paths out of events.

### v0.1.8 — Unified Execution Lifecycle

- Replace independent Transcript and Trajectory event pairing with one typed,
  replayable lifecycle snapshot for Turn, Step, Thought, Tool, Command, and
  Vision execution.
- Use stable semantic identities, monotonic transitions, recorded timing,
  parent settlement, and bounded diagnostics across live streaming, resume,
  and older-history prepend.
- Keep pre-admission runtime activity in a generation-scoped overlay that
  reconciles with durable evidence without creating fake Session events.
- Make Diff a Tool-result presentation facet and Activity an adjacency
  projection so neither owns a second lifecycle.
- Centralize execution status aggregation, glyphs, timing, and failure
  disclosure while keeping layout and interaction in presentation code.
- Cut every execution consumer over atomically, then delete the old pairing
  Maps, copied status types, timing fallbacks, duplicate visual switches, stale
  comments, and implementation-coupled tests; do not ship a dual-read bridge.
- Borrow Cordis's contract, ownership, scope, and cleanup principles without
  introducing a lifecycle plugin API, service, or second persistence format.

### v0.1.9 — Source-Attributed Rewind

- Replace TUI-owned whole-worktree checkpoint policy with one transport-neutral
  Rewind domain consumed through a narrow application port.
- Project each accepted human `user/message` into the existing TUI lifecycle as
  one stable Prompt node; use the same node for text, native-image, and
  proxy-image turns, classify turn-entry versus in-turn placement, and retain
  Vision evidence as a child contribution that enriches the Prompt's durable
  attachment references.
- Journal source-attributed workspace mutations with stable session, turn, and
  call identities, canonical per-target filesystem identities, and before/after
  snapshot references; authorized local edits remain reversible across roots.
- Plan each restore as `safe`, `mergeable`, `conflict`, or `unsupported`; only
  AI-owned mutations participate in the default restore plan.
- Verify and refill complete Prompt text and attachments around one transaction
  supporting code-and-conversation, conversation-only, and code-only restore.
- Rebuild visible checkpoints from each active Session log and persist one active
  reversible-effect lineage per canonical workspace, so new and resumed Sessions
  never depend on effect ownership to expose Rewind.
- Retain a durable cursor and future segment after restore; discard that future
  only when the forked session admits a new durable turn-entry Prompt.
- Default safe code plans to code-and-conversation, keep conversation-only
  available through code conflicts, and show exact affected paths and ownership
  before confirmation.
- Remove whole-worktree inference, tool-name parsing, duplicated checkpoint
  state, compatibility bridges, and TUI-owned Git restore code after cutover.

### v0.1.10 — Session Center

- Upgrade resume selection with durable titles, workspace and activity
  metadata, running state, and parent/child lineage.
- Add cross-session and within-session search with direct navigation to the
  matching event.
- Support rename, archive, and explicit export without hiding whether a session
  is live, persisted, blank, or unavailable.
- Preserve stable navigation across search, history paging, resume, fork, and
  rewind.
- Add explicit backward/forward timeline navigation with a clear current-node
  marker and branch-discard confirmation when a new message is sent from the
  past.

### v0.2.0 — Parallel Execution Console

- Add a parent/child Agent tree with status, depth, task label, elapsed time,
  latest activity, and durable lineage.
- Add background Job inspection, output reading, cancellation, and completion
  notification.
- Enter an inspectable child session without conflating one-shot and
  continuable subagents.
- Keep ownership and authorization in the Host; the terminal is a client of
  subagent and job capabilities.

### v0.2.x — Review and Handoff

- Add a workspace-wide `/changes` review surface with file navigation, aggregate
  line counts, full diffs, and test results.
- Produce a copyable task handoff containing changed files, validation, open
  risks, session id, and resume command.
- Export bounded conversation and trajectory diagnostics for issue reports
  without exposing secrets or uncontrolled raw payloads.

### Later — Capability Inventory and Remote Work

- Add read-only Skill and plugin inventory diagnostics before attempting
  configuration editing in the terminal.
- Standardize a remote Vision RPC only when a second out-of-process client
  needs the community Vision service.
- Support detached work, remote execution worlds, and multiple workspaces only
  through documented Harness capabilities.
- Add command-plugin scaffolding only when a concrete developer workflow needs
  deterministic non-model commands; do not execute arbitrary saved shell text
  as a shortcut format.

## Deliberate non-directions

- Do not reproduce the complete Web settings UI in a terminal.
- Do not create a TUI-specific agent, plan, goal, permission, session, or skill
  persistence format.
- Do not create a TUI-specific model adapter, credential store, or attachment
  store for Vision.
- Do not add a generic renderer/plugin API before an independent extension
  requires one.
- Do not turn every feature into a permanent pane; the conversation remains the
  primary surface.
- Do not treat file length or directory count as product progress.

## Milestone gate

A milestone is ready to release only when its user-visible state survives
resume and history replacement, its unavailable-capability behavior is
explicit, keyboard and narrow-terminal flows are tested, and the published
package remains compatible with the declared Harness range.

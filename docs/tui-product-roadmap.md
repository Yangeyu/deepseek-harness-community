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
5. **Optional capabilities degrade cleanly.** A missing projection or Host capability means
   that feature is unavailable in the active composition, not that the session
   is corrupt.
6. **Developer preview requires explicit cutovers.** Harness is still evolving
   below `0.2.0`; each selected runtime train is integrated through narrow
   ports and contract tests, and superseded paths are deleted rather than kept
   as version fallbacks.

## Product flow

```text
Prepare                    Execute                  Review                 Reuse
permissions · vision  ->  goal · todos · agents -> changes · trace   -> skills · sessions
```

The TUI is already strong in the middle of one session: streaming output,
visual evidence, tool and diff rendering, memory, a unified execution read
model, and source-attributed Rewind. Its client foundation now has explicit
Application and Session-epoch lifecycles, fresh Session feature sets, semantic
input dispatch, one Surface host, and one renderer snapshot boundary. The next
product work completes the session, parallel-work, review, and reuse loops
around that execution core; it must extend those owners rather than rebuilding
another control plane inside a feature.

## Milestones

Milestone names describe capability sequence and delivery state; they are not
npm or Git release versions. The published package version in `package.json`
and matching Git tags are the release identity.

### Delivered — Configuration, Task, and User Extensions

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

### Delivered — Visual Input and Vision Proxy

- Align composer semantics with established terminal-agent interaction:
  `Enter` steers, `Tab` queues while working, and `Alt+Enter` remains multiline.
  Resolve semantic actions through one fixed, context-aware binding table
  instead of hard-coding gestures in the application shell.
- Support repeatable `-i`/`--image` startup attachments for portable scripted,
  new-session, and resumed-session image intake.
- Add explicit image drafts from files and the system clipboard with a compact,
  keyboard-first attachment rail above the composer.
- Introduce a public, TUI-independent Vision workspace that resolves one image
  route per submission: image-capable models continue through official Host
  admission, while text-only models use a configured proxy.
- Use a first-class Bailian adapter for DashScope request/SSE semantics and
  recommend `qwen3.7-plus` as the first proxy route while DeepSeek remains the
  primary coding model.
- Persist proxy image references, observations, status, usage, and duration as
  source-attributed session evidence visible in Transcript and Trajectory.
- Configure Vision under `/config`, fail closed on missing capability or
  credentials, and keep secrets and originating local paths out of events.

### Delivered — Unified Execution Lifecycle

- Replace independent Transcript and Trajectory event pairing with one typed,
  replayable execution snapshot for Turn, Step, Thought, Tool, Command, and
  Vision execution.
- Use stable semantic identities, monotonic transitions, recorded timing,
  parent settlement, and bounded diagnostics across live streaming, resume,
  and older-history prepend.
- Keep pre-admission runtime activity in a Session-epoch-scoped overlay that
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

### Delivered — Source-Attributed Rewind

- Replace TUI-owned whole-worktree checkpoint policy with one transport-neutral
  Rewind domain consumed through a narrow application port.
- Project each accepted human `user/message` into the TUI execution read model as
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

### Current — Reliability

- Completed: persist Memory session switches, cancel and drain learning when
  disabled, and acknowledge policy changes only after the Host operation settles.
- Completed: opt-in real-model Memory acceptance for cross-process recall,
  policy controls, update/forget, background learning, and active cancellation
  through `pnpm test:memory:e2e`.
- Verify Rewind recovery with process-interruption fault injection before
  selecting any additional durable transaction mechanism.
- Establish long-session time and memory baselines with fixed histories and
  replay-equivalence checks before changing raw-event retention.
- Extend real Host and terminal acceptance beyond startup/exit to a small set
  of session resume, cancellation, and recovery workflows.

### 实施中 — 长历史渲染与 Request 检索

详细设计及验收门槛见 [TUI 长历史渲染与 Request 检索优化规划](tui-rendering-request-inspection-design.md)。`feat/tui-request-inspection` 首批 Trace 身份、缓存优化与 Request 浏览搜索已接入：正文按真实来源组织，Metadata 默认折叠；Tools 按规范顺序列名称/摘要，单个工具的 Description、Parameters schema、Other attributes 按需展开。`/` 在底部输入，保留正文；确认与 n/N 在同一目录或显式 JSON 中定位、高亮，Esc 清除搜索后再返回。选择与视口滚动分离，完整 `pnpm check` 通过；性能及真实终端门槛尚未全部验收。搜索保留字段计数并可取消地重扫单个命中，首次文本净化/冷定位仍有同步线性成本。P2 Markdown 完整窗口化受公开排版接口缺口约束，尚未实现；P3 仍为规划。首批增量已合入 main，纳入 v0.1.30 发布范围；80×24、140×24 的 Request 组件 PTY 主流程冒烟通过，不替代完整应用与性能矩阵验收。后续阶段不绑定发布版本。

- P0：Trace 各布局固定展示当前 Session ID，窄屏完整值可查看；建立性能基线，缓存当前 Request 准备结果，消除热滚动的重复序列化与排版，收敛静态 Trace 指标计算。
- P1：结构化 Request 目录、Tools 分层披露、自然换行正文、全字段原地搜索/命中跳转，以及缺历史时每次显式加载一页、Esc 停止本视图等待的流程。
- P2：消息列表和超长正文窗口化，稳定阅读锚点，有界排版缓存，删除完整历史行数组渲染路径。
- P3：相邻 Request 变化对比与跨请求查询；敏感内容导出、全 Session 查询和 Host 历史窗口/checkpoint 契约另行评估。
- 完整历史可访问，不等于始终全部驻留或每帧全部排版；本计划不以删除日志或改变 compaction 来解决渲染性能。

### Next — Session Center

The current foundation already exposes `/resume` through the shared Surface
host and shows root-session ids with working directory, durable title, and fork
lineage. That is navigation scaffolding, not completion of this milestone; the
search, management, and temporal-navigation capabilities below remain planned.

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

### Planned — Review and Handoff

- Add a workspace-wide `/changes` review surface with file navigation, aggregate
  line counts, full diffs, and test results.
- Produce a copyable task handoff containing changed files, validation, open
  risks, session id, and resume command.
- Export bounded conversation and trajectory diagnostics for issue reports
  without exposing secrets or uncontrolled raw payloads.

### Planned — Parallel Execution Console

- Add a parent/child Agent tree with status, depth, task label, elapsed time,
  latest activity, and durable lineage.
- Add background Job inspection, output reading, cancellation, and completion
  notification.
- Enter an inspectable child session without conflating one-shot and
  continuable subagents.
- Keep ownership and authorization in the Host; the terminal is a client of
  subagent and job capabilities.

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

A capability milestone is complete only when its user-visible state survives
resume and history replacement, its unavailable-capability behavior is
explicit, keyboard and narrow-terminal flows are tested, and the published
package remains compatible with the declared Harness range.

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
- Vision 是独立于 TUI 的可选代理识图服务。Host 适配层每次提交解析一次原生/代理路线；
  所有准备结果统一交给 Session 提交。原生多模态输入不依赖 Vision，文本模型才需要代理。
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
- Rewind 收敛为工作区变更与会话 fork，整删通用 participant 抽象及 Memory 参与链路；在同一事务中验证并恢复完整 Prompt 文本和附件，继续支持 code-and-conversation、conversation-only 与 code-only。
- 持久化统一为 schema 4，仅保存工作区 lineage；移除旧格式迁移、participant 识别及对应兼容测试。非当前格式走无效清单隔离路径，不兼容旧工作区回退记录，不迁移或改写长期记忆。
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

### Memory — 尽力而为，服务回答质量

- 目标是利用用户反馈和知识沉淀改善回答、减少重复纠正，不追求完整记录、高可靠存储或确定性召回。
- 保留 Markdown 短索引、按需主题详情与三个工具；快照按完整条目分配全局/项目预算，省略内容提供读取入口。本轮不迁移真实记忆，不改变文件组织。
- 长期记忆不再参与 Rewind，回退代码或会话不会改变已写入的记忆，由用户纠正、遗忘或直接编辑维护；Memory API 不提供回退或跨域事务能力，写入与遗忘仅返回是否改变文件的 boolean。批次回合分隔仅供理解上下文，不追踪持久事实的原始回合归因。
- 主 Agent 用完整上下文沉淀明确纠正与已核实的非显然经验，后台仅补漏用户支持的反馈；索引足够时不强制再读，不猜缺失上下文，不保存代码或指令副本。普通自动索引 I/O 失败警告后沿用旧快照继续；policy、abort 与显式工具读失败仍严格。
- 后台默认关闭；显式配置 `extractionProvider` + `extractionModel` 时优先使用专用 route，未配置则沿用源 Agent 当前的前台路由，并允许开启学习。Memories 对话框显示专用 route 或跟随前台的成本提示，以及空闲等待和请求边界；保留已保存的会话开关，不新增设置页或修改用户配置。
- 观察 `completed` 主回合，不收子 Agent，有效 policy 开启学习才进入等待和提取；移除关键词筛选和逐回合 Promise 队列。每源 session 仅一个内存 pending 批次，JSON 默认最多 32 KiB；单回合超限保留全部完整用户消息，用户证据也放不下则跳过，合批超限先舍弃助手上下文，用户证据仍超限才淘汰最旧整回合。持续空闲默认 5 分钟合并一次；新前台回合取消当前等待或学习，不等子 Agent 排空，已取出的批次不重放。
- 后台 `maxTokens: 900`、每批最多 3 次 canonical `llm/stream`，沿用所选 provider 默认推理设置，不新增 effort 配置；provider 内重试不计入，非总 token、HTTP 请求数或费用保证。失败与限额不自动重试，关闭或退出取消工作，重新开启不恢复旧候选。
- 更正通过现有 `memory_write` 的 `replaces: { summary, topic? }` 在一次工具调用中提交，不先删旧再等模型补写；单目录排队、逐文件原子提交，允许取消或失败时部分更新，不增加事务或回滚。
- 清理独立进程质量矩阵、随机标记精确召回、固定字段评分和报告重评分系统；保留生产功能单测与少量任务的[人工质量观察](tui-architecture.md#memory-质量观察)。前述修正前的 8 次 Qwen 请求验证了样例中的纠正复用、明确临时例外与后台替换；本次修正用真实 Agent 循环及脚本化响应验证功能，不宣称已经证明自然回答质量提高。
- 后续由实际回答中的重复错误、偏好误用或有用知识缺失驱动改进，不预设新的评测平台、文件迁移或检索数据库。

### Current — Reliability

- Completed: persist Memory session switches, cancel and drain learning when
  disabled, and acknowledge policy changes only after the Host operation settles.
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

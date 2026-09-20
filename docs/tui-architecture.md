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
only quota groups, window lengths, used percentages and reset timestamps.

`ProviderUsageProcess` 统一拥有当前 provider 的额度快照，供模型栏与 `/usage` 共用。选中 provider 时查询一次，支持额度查询的 provider 每 60 秒在后台刷新；切换 provider 或退出时取消请求和计时，旧请求结果不覆盖新状态。后台失败时隐藏额度，`/usage` 保留显式错误反馈和会话退役检查。Codex 模型栏仅展示账户级 `Codex` 分组实际返回的 5 小时、每周剩余百分比，不补造缺失窗口，不把其他模型的独立额度当成账户额度。窄终端沿用模型栏的截断规则。

`/usage` opts into command activity via
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

当前统一使用 `@deepseek-ai/dsh@0.1.5-rc.2`。工作区 catalog 是唯一版本来源，
直接 DSH 依赖共享同一精确版本，lockfile 解析对应的传递依赖与 peer 图。

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

已验收的 tarball 和 receipt 作为同一份不可变产物在发布 job 间传递。
各 job 仅使用所需权限：候选验收只读，标签 job 写入 Git ref，npm job 使用 OIDC，
GitHub Release job 写入发布资产。发布保持
`github.sha = peeled tag SHA = receipt source SHA`，npm 和 GitHub 使用同一份候选包。
只允许从 `main` 触发，并要求触发时的 `github.sha` 已通过 CI；后续 `main` 推进
不改变该次发布的源码身份，也不使已验收的候选包失效。
发布 job 不使用依赖缓存，也不在验收后重新构建候选包。

正常发布以 `npm publish`、GitHub Release 创建/上传命令的结果为准；发布前仍校验
候选包的源码身份与摘要，发布后不轮询 npm 可见性或重新下载产物。npm 接受发布与
registry 可下载是不同阶段，工作流成功不承诺包已立即可下载。

通过 Actions 的 **Re-run failed jobs** 恢复部分成功的发布时，复用原候选包。
仅当 `github.run_attempt > 1`，npm 步骤先查询一次对应版本：可见时下载并核对
SHA-256，相同则跳过重复发布，不同则失败；查询未取得有效地址时尝试 `npm publish`，
由该命令决定结果，不等待或吞掉发布错误。新触发的同版本工作流不视为恢复重跑。
标签和 GitHub Release 的恢复继续要求既有源码或产物摘要一致，不覆盖冲突状态。

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
- Activity 标题固定为 `Activity`，显示 thought/tool 数量；不追加最新工具名，
  正常状态使用同一种低强调色。失败与中断按子项计数独立展示，仅失败计数用错误色。
  仅位于内容尾部、所属执行仍在运行的活动组对整段可见摘要文字（Activity、数量和种类）
  做两秒一轮的低亮度扫光；箭头、背景和结果标记保持静态，失败计数保留错误色。
  同组工具失败、重试或 Step 切换不结束扫光；后续正文开始流式输出，或 Prompt、Diff 等
  正式内容切断该组时立即停止，不等待整个 Turn 结束；Notice、错误提示、排队与本地待提交提示
  不改变正文活动组的归属。历史组静止，具备最终耗时时显示耗时。
  `modules/transcript/model.ts` 将普通工具、Vision 预处理与持久结果统一转换为工具项，
  进入同一次 Activity 分组与活动选择。排队、本地待提交 Prompt、Notice 与临时错误提示
  统一适配为内部 `supplement` 项：保留独立显示位置，但不关闭内容活动组；分组过程直接确定
  当前候选组，不再从最终列表反向猜测或依赖提示追加时机。
  执行统一沿已知父节点判断是否结束，无父节点时使用自身状态，不设置工具种类的动画优先级。
  `modules/transcript/activity-presentation.ts` 集中拥有摘要与扫光样式；
  theme 提供调色板，view 负责排版、命中位置与动画启用；仅在活动组启用颜色时传入动画帧时间，
  摘要绘制不重复判断动画资格，process 管理动画时钟。
- `TranscriptModel.project(snapshot, showDetails)` 是会话内统一内容投影入口，返回只读的
  `items`、`activeActivityKey`、`showDetails`；与展示无关的快照更新复用同一结果对象。
  `buildTranscriptProjection` 依次归一化来源、分组、解析活性并组装投影；同文件内的
  `collectTranscriptSources` 保留 supplement 语义，`groupTranscriptActivity` 只返回可见列表与
  候选尾组，不接收展示选项或执行快照、不判断活性，也不从解包后的列表反推内容边界。
  模型拥有历史投影、工具正文解析缓存及其失效判断；view 只消费投影，拥有 Markdown、Prompt、
  Diff 渲染缓存、交互状态与命中位置，不接收原始 Session 快照。
  process 在 render 时取得当前投影，流式快照通知只更新异步文件信息，不逐事件重建内容。
- 全局详情配置的唯一写入者是 Configuration。应用装配将当前值与同步变化订阅作为只读端口传给
  TranscriptProcess，Host/Process 不保存可变副本、不转发配置赋值；新 Session 直接读取现值。
  每次真实配置变化都同步清除 view 的 Activity/子项展开覆盖和思考滚动暂停，再请求渲染。
  `setProjection` 只更新展示内容，不推断交互动作；同一帧内开关两次也不会遗漏覆盖清理。
  指针动作使用最后渲染的命中位置和当前配置默认值，不依赖上一帧的配置值。
  每个 Session epoch 创建新的 model/view/process，交互状态及配置订阅随旧 scope 退役；
  切换中仍存活的旧实例继续接收配置变化，失败回滚无需补偿同步，也不在视图中维护第二套会话判断。
- Layout 报告裁剪后的可见行范围，Transcript 仅在活动标题可见时请求 32ms 动画帧，
  Session scope 负责释放时钟；普通内容更新保留已排定的下一帧，不反复推迟时钟。动画仅更新
  缓存中的标题行，不重建内容投影、Markdown、工具详情或点击几何。关闭颜色时静态显示，
  标题悬停时由 hover 样式接管。底部状态栏的 spinner 保持独立的 160ms 节奏。
- 工具子标题使用工具提供的单行操作说明，展开后展示有界的完整 Arguments 和 Result。
  原始终端命令只出现在详情中，不进入 Activity 或子标题。
  工具正文以不可变 HistoryEntry 为键复用有界解析结果；执行快照或工具数量变化不重复
  解析历史参数与结果，来源条目被替换时重新读取。缓存不改变当前 execution 状态。
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
  `/copy` 从当前会话历史中取最近一条已完成且正文非空的 AI 回复，保留原始 Markdown；不包含思考、工具输出、压缩摘要、流式片段或被中断的回复。需要时沿现有历史分页继续查找，会话退役后停止。该命令与鼠标选区共用剪贴板适配器，没有可复制回复时显示提示。
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
- Composer 采用无边框背景卡片，框内上下各一行留白；上方状态/附件与底部信息栏直接相邻，通过背景色区分，不额外插入空行。上下辅助信息统一使用 `theme.dim` 弱化，运行指示、Ready 和警告保留强调色。首行 `› ` 提示符，空草稿显示占位文案；移除 Editor 的模拟反色块，以原生竖线光标表示插入位置，保留零宽光标标记供 IME 定位。`showHardwareCursor` 默认开启，显式关闭时隐藏原生光标；屏幕生命周期设置竖线形状，退出时恢复终端默认形状。滚动提示保留在留白行，补全仍位于输入框上方。终端启动后通过 pi-tui 的公开 OSC 11 查询获取背景色，按浅色混黑 4%、深色混白 12% 生成卡片底色；查询无结果时使用深色默认值。
- `composer/view/sparkle.ts` 集中拥有常驻星点算法、颜色混合、时钟和按需计时，`ComposerEditorFrame` 调用 `render(frame, colors)`；Composer 只提供焦点/补全显示条件并绑定释放，动画续帧直接进入 `RenderScheduler`，不重新组装业务快照。效果参照 Codex CLI `rust-v0.154.0`：150ms 续帧，稳定坐标散列，4–7 秒独立闪烁周期。输入、提交和历史会话不终止动效；失焦或补全展开时暂停，恢复显示后续播，作用域释放时取消计时。星点只绘制在卡片未带样式的空白单元格，保护正文、宽字符、占位文案、图片引用及光标。关闭颜色时不启动，不依赖模型或额外动画库；前景亮度根据终端背景推导，pi-tui 暂无公开前景色查询接口。
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
- `TrajectoryModel` 每次记录快照变化时以 O(n) 建立静态计时、父级和瓶颈索引；
  稳定快照的 measure 为 O(1)，时钟刷新只更新活动节点及受影响的 share/赢家。
  返回值是同一可变的同步 render read-model，不可当作历史帧快照持有。
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
- `buildTrajectoryRecords` and `TranscriptModel.project` join presentation payloads
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
- Trace 三种布局保留 Session 身份栏，`s`/点击查看完整 ID，Esc 返回原阅读位置。
  Ledger 焦点下 j/k 仍选择执行记录，Shift+J/K 只滚动右侧详情。Request 在 Detail
  焦点下，目录 ↑/↓、j/k 选择标题或披露项，选中离屏才滚动跟随；J/K 与滚轮只滚正文。
  展开/收起保留目标屏幕位置，JSON 中上下键滚动，Tab/左右仍切外层详情页。
  消息展开即原地读正文；Metadata 默认折叠，包含全部未作为正文展示的字段，
  包括真实 role/source、文本块 type 与工具调用 name，使用相对字段名展示。
- Tools 保持 canonical 顺序，展开根目录先显示各工具名称与短摘要；单个工具及其
  Description、Parameters schema、Other attributes 各自默认折叠，按需展开完整值。
  展示工具列表不遍历 schema；工具名称直接关联原始字段，命中高亮绘制在名称标题上。
- Request 的 `/` 输入位于底部，保留当前目录或显式 `v` JSON 的正文窗口；输入字符
  透传给 Input。结构搜索覆盖当前完整 Request 原始字段值，不受披露状态影响；JSON
  搜索覆盖完整序列化文本。确认与 n/N 循环选中一处命中，自动展开所属层级并在同一
  目录/JSON 中定位和高亮，`c` 切换大小写。Esc 先取消输入或清除查询与高亮，保留
  正文锚点；再退出 JSON 到目录或沿外层返回路径退出。`g` 跳转最新输入、checkpoint
  或原消息序号，`[`/`]` 跳目录标题。
- `message-label` 依据正式 source.kind/form 统一 Trace 与 Request 的身份标题；只有
  人类输入标为 USER，普通注入记录标为 CONTEXT，既有 Vision 执行记录保持独立。
  未声明 form 的来源显示 `Context · producer`，不使用插件名称映射表或正文关键词猜身份。
  Request 折叠标题追加有界短摘要，展开后不重复摘要；真实 role/source 保留在 Metadata
  与 JSON 中。此展示分类不改变实际请求角色、消息顺序或事件 Turn/Step 归属。
- `requestDocument(key)` 暴露规范请求的可用性、修订和真实消息来源，不是 HTTP 抓包。
  `RequestBrowser`/`RequestInspection` 只拥有当前 Step 的目录、文本窗口与可取消查询；
  同 Step 切 Tab 暂停任务并保留有效阅读锚点，切 Step/epoch/Session 或关闭时释放。
  搜索按字段分块进行，索引仅保留有命中字段的引用和计数；`match(ordinal, signal)`
  跳过已计数字段，可取消地重扫目标字段并返回单个命中，不保留全部命中位置。
  JSON 仅显式进入时完整序列化，当前冷序列化仍同步。
- `TextDocument` 共用纯文本窗口、原始 UTF-16 偏移定位和高亮绘制：每 128 视觉行
  一个稀疏 checkpoint，预读 32 行、缓冲预算 64 Ki 字符（屏幕必需行另计），仅缓存
  两个原文到安全文本的范围边界。高亮只重绘相交可见行，不建立全源逐字符映射。
  首次文本净化、新边界的前缀转换与冷定位仍同步且随前缀线性增长；宽度变化重建
  视觉索引，尚未保证精确原文锚点。源字符串与稀疏索引也并非恒定内存；这些能力
  不代表 Transcript 或巨型 Markdown 单块已经窗口化。
- `SessionManager.loadEarlierHistory` 复用每个 runtime 的单个在途页。Request 中 Enter
  显式加载一页，Esc 停止该视图等待，已飞页仍归 Session 所有；不取消模型 turn，
  不自动补载全部历史。既有 epoch/ownership 检查继续阻止旧 Session 页污染新 Session。
- `modules/rewind/contracts` is independent of Cordis, Memory, Node, and pi-tui.
  The injected `RewindConversationHistory` rebuilds Prompt checkpoints from the
  active Session log. `modules/rewind/domain` owns only the bounded
  reversible-effect lineage and pure reverse planning;
  `modules/rewind/application` joins those two
  sources and owns the active timeline Repository port, restore, and conversation
  compensation; and
  `modules/rewind/adapters` is the only layer that translates Prompt nodes, Host
  filesystem events, durable Harness-home files, or the local
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
- `RewindJournal` 仅保留工作区变更归因所需的 Prompt 身份与一条活跃工作区 effect lineage 的游标，不是可见检查点的事实源。`RewindService` 从 `HostRewindConversationHistory` 读取检查点，按稳定 Prompt 身份关联工作区 effect 元数据，通过注入的 workspace backend 构建 `safe`、`mergeable`、`conflict` 或 `unsupported` 计划；纯 planner 保留不重叠的后续编辑。不保留通用 participant 抽象或非工作区参与者引用。
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
- 持久化统一使用 schema 4，仅保存工作区 lineage；不保留旧格式迁移、participant 识别或历史兼容分支。非当前格式按既有无效清单路径告警并隔离，不转换为新格式，也不能用于恢复旧工作区变更；不读取或改写长期记忆文件。
- `RewindTransaction` 只组合可选的工作区可逆阶段与可选的 conversation fork，同一事务路径支持 code-and-conversation、conversation-only 与 code-only。后续会话阶段失败时补偿已完成的代码阶段，不包含长期记忆或其他领域。Composer 恢复先通过 Host store 验证附件引用，fork 成功后一起恢复文本和图片草稿；安全及可合并的代码计划默认 code-and-conversation，受阻或无代码计划默认 conversation-only，确认前列出精确路径。
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
  `SessionManager.rewind` 在创建分支前捕获当前有效的 provider、model 与 reasoningEffort；
  回退到开头和中间轮次统一在打开目标会话前通过官方 Controller 的 `selectModel`
  写入新会话自己的选择事件。历史请求配置保留原样，后续请求沿用回退前的选择，
  重新加载通过同一模型投影恢复。Controller 独占模型校验、持久化与运行时绑定。
  应用模型失败不打开目标会话，错误进入现有 Rewind 补偿路径；已创建的持久分支可能保留。
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

### Memory 上下文与学习质量

Memory 的核心目标是利用用户反馈和过往知识沉淀提高 LLM 回答质量、减少重复纠正。它是尽力而为的会话辅助，不追求完整记录、高可靠存储或确定性、可复现的召回，也不是代码事实的第二份权威存储。保留 `MEMORY.md` 与四个主题文件、三个 Memory 工具；不为边缘召回问题引入检索数据库或每回合模型调用。关闭、遗忘与基本隐私保护仍是实际用户功能，不因尽力而为而失效。长期记忆不参与 Rewind：回退代码或会话不会改变已写入的长期记忆，错误或过时内容通过用户纠正、遗忘或直接编辑维护。本轮不迁移真实记忆，不改变现有文件组织。

- `MEMORY.md` 作为简短索引：摘要包含可复用结论与必要的适用条件，主题详情保存理由和用户依据；优先用户纠正、稳定偏好、非显然决策及外部引用，不重复项目指令和可直接从代码获得的信息。一次性例外不成为长期默认值，当前请求优先于历史偏好。
- 快照只投影索引，不自动读取主题正文，也不改写磁盘文件。相关详情由 Agent 按需 `memory_read`，索引已提供足够上下文时不强制再读；代码相关的历史线索在应用前应核对当前文件。这些使用规则是模型指引，不是正确回答的硬保证。
- 普通自动索引 I/O 失败只发出警告，沿用上次快照继续主回合；policy 异常和 abort 仍严格传播。显式工具读取失败不伪装成空文档。
- `maxContextBytes` 仍默认 25,600 字节，最小值为 256，以容纳两个 scope 的标题、省略提示与闭合标记；按最终 UTF-8 文本计量，包括转义和所有分隔符。容量是上限，不是应填满的目标。
- 上下文先为项目保留一半可用预算，再给全局使用余量，最后项目回收空闲空间。每个 scope 按原顺序选择完整条目，跳过放不下的条目并继续考虑后面的短条；不宣称相关性排序、最新优先或最优填充。
- 只有自包含的顶层 bullet 及其缩进续行可以独立选择，不裁剪半个链接或 `memory-context` 标记。除 store 标准索引标题外，手工索引若含顶层普通说明段落、额外标题或代码围栏，在需要裁剪时保守地整份省略，避免将条件引导段落与后续规则拆开；完整文档能放下时保留全文，仅净化结束标记、首尾空白和 CRLF 换行。这不是通用 Markdown 解析器，也不保证理解任意条目之间的语义依赖。
- 部分快照明确标记被省略的 scope，并给出 `memory_read({"scope":"project"})` 或 global 的完整索引读取入口。全局内容不能消耗项目保留份额；省略内容仍留在原文件，不是遗忘操作。索引快照仍仅在变更时发布，会话开关独立持久化。
- 主 Agent 利用完整任务上下文，通过显式工具沉淀用户的明确纠正与已核实的非显然经验；后台只补漏有用户依据的反馈。两者都不猜测缺失上下文，不保存代码或项目指令副本，不把一次性例外升级成长期规则。
- 后台移除关键词筛选与逐回合 Promise 串行队列。观察 `completed` 主回合，子 Agent 回合不进入批次；只有有效 policy 开启学习才进入空闲等待与模型提取，未开启的候选被丢弃。每个源 session 在内存中仅保留一个有界 pending 批次；主 Agent 持续空闲 `idleDelayMs` 后合并提取一次，新回合重置等待。
- `extractionMaxInputBytes` 默认 32 KiB，按批次 JSON 计量，不包括整个维护提示词。单回合优先保留完整用户／助手文本，超限时只保留该回合全部完整用户消息，用户证据也放不下则跳过；合并批次超限时先将已有回合全部退为完整用户消息，仅用户证据仍超限才移除最旧整回合。不裁断用户证据、不拼装助手片段，已舍弃的助手上下文不另行缓存；缺失上下文的反馈应跳过，不为提高召回率猜测事实。
- 后台学习优先使用显式专用 route，未配置则沿用源 Agent 在该批启动时的 provider/model；未指定的字段交给 Harness 正常路由解析，不复制前台整份 Agent 配置。后台保持 `maxTokens: 900`，单批最多 3 次 canonical `llm/stream`，沿用所选 provider 的默认推理设置，不新增 effort 配置；provider 内部重试不属于该计数，因此请求额度不保证总 token、HTTP 请求数或费用上限。失败或限额后不自动重试。

service/store 的 `write` 与 `forget` 返回表示文件是否改变的 `boolean`，Memory 不提供回退或跨域事务 API。批次中的回合分隔仅供理解上下文，不建立持久事实的原始回合归因。

- 后台不占用父 Agent 的 `runMaintenance`。同一尝试的取消作用域覆盖空闲等待、学习及子 Agent 释放；新前台回合开始时取消该尝试，前台不等待旧学习排空。尚在等待的 pending 继续合批并重新等待空闲；已取出执行的批次被取消后不重放。关闭学习、源退出及服务退出仍负责取消和释放，不增加持久队列或自动重试。
- `memory_write` 支持可选 `replaces: { summary, topic? }`，一次工具调用在同一 scope 内更正旧条目；应提供旧条目的准确摘要及原有主题，普通遗忘才调用 `memory_forget`。不带 `replaces` 保持去重；带此字段可更新相同规范化摘要的详情、主题或索引链接。旧条目缺失仍可写新值，不自动扫描所有主题寻找旧内容。
- 更正只进入一次现有目录写队列，先读取并校验所需文档及最终大小，再按新主题、最终索引、不同旧主题清理的顺序逐文件原子写入；索引直接替换为最终内容，不先落盘删除再等待模型补写。同一主题的替换在该文件内完成，不再次删除新值。取消或 I/O 失败仍可能部分更新、残留旧详情或链接暂不一致，不回滚。索引按完整摘要匹配，主题仍使用简易摘要／详情格式，不引入通用 Markdown 解析器。

已知取舍：关闭学习时，仍会先扫描当前回合、构造短暂候选，再异步检查 policy 丢弃，不产生后台模型调用；它不是按事件时刻精确冻结的收集门禁。模型是否正确使用更正参数仍依赖指引，三次额度也不保证所有学习任务完成；不为此扩大预算或新增恢复机制。

功能单测覆盖索引与用户证据的基本完整性、记忆读写更正／遗忘、会话开关和后台批次等实际行为。真实 Agent 循环配合脚本化响应验证新前台回合不等待已取消学习的排空，以及两次补读后第三次请求完成 `write(replaces)`、额度不影响前台；这类离线功能验证不代表模型自然使用参数的概率或回答质量，不用提示词关键字断言代替效果评价。

### Memory 质量观察

以真实任务中的回答是否更贴合用户、少重复旧错误、能复用有用经验为判断依据，不把精确召回或固定字段命中当作回答质量。无需独立的模型评分、语料冻结、跨进程矩阵或报告重评分系统；旧评测框架及验收说明留在 git 历史中。

在本次前台优先、批次裁剪和 `replaces` 修正前，已用 `bailian/qwen3.7-plus` 在临时项目、独立 Memory 根目录和真实 Agent 循环中完成一轮小样本观察，共 8 次 canonical 请求：无记忆时建议自动重试；自然纠正保存后，新会话改为单次尝试、由用户手动重试；明确标注的本地临时例外没有改写长期规则；后台在三次请求内完成旧规则替换。观察沿用 provider 默认推理设置，前台输出预算 1200、后台 900，后台等待缩为 0；后台输入为预置的已完成回合。这验证了样例中的偏好遵循与读写链路，不覆盖真实五分钟调度，也不是与旧实现的对照，不能据此宣称本轮重构提高了整体回答质量、学习覆盖率或计费效率；本次未采集到可用的 token／计费用量。

需要观察效果时，在独立测试项目与隔离的 Memory 根目录中，用正常客户端进行少量自然交互：

- 给出一条真实、脱敏的纠正（如 session 列表保留 ID 为主标签），新会话再请求相关方案，观察是否减少同类错误、保留适用条件和理由，而不是要求复述历史原句。
- 提出一次临时例外或正式改口，观察本次回答是否服从当前需求，以及后续是否误用默认值。
- 换一个自然话题，或让已有代码线索随项目变化过时，观察是否生搬记忆、是否结合当前文件作答，不提前在题面提示答案。

必要时对同一实际任务关闭自动记忆注入进行人工比较；记录有用与误用的例子即可，不维护强制配对矩阵、总分或胜率门槛。生成/读取了记忆不等于回答更好；漏记一次也不自动成为新增机制的理由。先确认反复出现的实际问题，再决定是否值得增加代码。

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
- 当前 rc1 Session append API 不能将下游事件标记为 `ignorable`，持久化也拒绝未知 required 事件，因此 Memory policy 由社区 Host 服务文件持有，不包含在单独的 Session-log 导出中。回退代码或会话不改写长期记忆和已保存的会话开关。
- `policy()` and `setPolicy()` are asynchronous. The TUI sends a partial change
  and displays the acknowledged result or pending state. After a failed change,
  it reads the current Host policy and displays it alongside the operation error.
  If that read also fails, switches become unknown and cannot be toggled until
  the dialog is reopened with a readable policy. The TUI owns no persistence or
  optimistic replacement of the saved value.
- 部署默认 `generateMemories: false`、`idleDelayMs: 300000`，移除 `minCandidateChars`。后台可沿用源 Agent 的前台 route；同时配置 `extractionProvider` 与 `extractionModel` 时优先使用专用路由，只配置一项或提供空值仍报配置错误。不修改用户 `~/.dsh` 设置。
- `MemoryOverview.learning` 始终为 `{ route, idleDelayMs, maxRequests }`；`route` 是显式 `{ provider, model }` 或 `undefined`，后者表示每批跟随前台，不是不可用。policy 只由部署默认与已保存的会话开关决定，不以专用路由是否存在改写启用状态。现有 Memories 对话框展示专用 route 或跟随前台的成本提示，并允许学习 toggle；不新增设置页。已有开启会话在未配置专用路由时也会沿用前台，因此可能使用较昂贵的模型，三次请求限额不等于费用保证。
- 每个源 session 拥有一个 pending 批次及取消作用域，不持久化候选。关闭学习取消等待与活跃工作，等待子 Agent 释放后才确认；重新开启只接收未来回合，被取消的旧候选不恢复。源 Agent 退出与 Memory 服务退出同样取消其工作。
- Child-disposal failures propagate to callers waiting on learning or a disable
  and publish error activity. A failed drain does not undo the already-persisted
  disabled policy; it must not be acknowledged as successful cleanup.
- 学习子 Agent 的创建 signal 在 factory 发布时结束。Memory 负责等待期间的取消，并释放 handle 来停止和排空真实 Agent 循环；临时子 Agent 使用维护策略，不创建独立 policy 文件。
- Memory 工具将取消传递到文件写入队列。取消阻止尚未开始的 write 或 forget；write 还在每个文件提交前检查取消，已经进入的单文件提交不回滚。释放子 Agent 会等待在途工具结束，但前台新回合不等待这个排空过程；它不是跨文件原子更正保证。

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

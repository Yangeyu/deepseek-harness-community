# DeepSeek Harness Memory

Best-effort memory for DeepSeek Harness: retain useful user feedback and accumulated knowledge to improve future answers and reduce repeated corrections. It is not a complete history, a high-reliability knowledge store, or a guarantee of exact recall. Markdown is the source of truth for stored memories; the plugin loads bounded indexes, exposes memory tools, and learns reusable feedback in quiet maintenance sessions.

本工作区维护独立于终端的公共 API，TUI 通过该服务显示记忆与会话开关。其他 Harness 客户端从 `@vascent/dsh-tui/memory` 导入；本工作区不单独发布 npm 包。

## Storage

```text
~/.dsh/memories/
├── global/
│   ├── MEMORY.md
│   └── preferences.md
├── projects/
│   └── <project-name>-<identity>/
│       ├── MEMORY.md
│       ├── preferences.md
│       ├── conventions.md
│       ├── decisions.md
│       └── debugging.md
└── sessions/
    └── <sha256-session-id>.json
```

`MEMORY.md` is the compact cross-session index. Keep summaries short and useful for deciding when a memory applies; put rationale and supporting user evidence in topic files, read on demand through `memory_read`. Prefer reusable corrections, preferences and non-obvious decisions over conversation logs or copies of current code and project instructions. No database is authoritative or required.

Markdown 是存储事实源，支持直接编辑与文件同步。长期记忆独立于 Rewind：回退代码或会话不会改变已写入的记忆，过时或错误内容通过用户纠正、`memory_forget` 或直接编辑维护。本轮不迁移真实记忆，不改变现有文件组织。

Project identity uses the normalized Git `origin` URL when available, including the repository name used in the directory prefix, so differently named clones and linked Worktrees share one memory directory on a synchronized memory root. Repositories without an origin use their Git common directory, which also unifies linked Worktrees. Non-Git directories fall back to their canonical path.

## Behavior

- `memory_write` 保存明确记忆请求和可复用反馈。更正时同时提供新内容与 `replaces: { summary, topic? }`，指定同一 scope 的旧摘要及旧主题，不先调用 `memory_forget`；也可更正同一摘要的详情和主题。
- `memory_read` opens the index or a topic file.
- `memory_forget` removes an exact summary.
- 使用规则注册在 system prompt 中；有效全局或项目记忆变化时，会话收到持久索引快照，关闭记忆会发布明确的替代标记。当前请求优先于历史默认值，一次性例外不应成为长期偏好。
- Snapshots reserve space for both scopes and select complete index entries, not truncated strings. Omitted entries are identified with a scope-specific `memory_read` prompt; full indexes and topic files remain unchanged on disk. Structured documents that cannot safely be split are omitted as a whole when they do not fit.
- 主 Agent 利用完整任务上下文，通过显式工具沉淀用户的明确纠正与已核实的非显然经验；后台仅补漏有用户依据的反馈，不承担通用知识总结。索引已足够时不强制再读主题，不猜测缺失上下文，不保存代码或项目指令副本。
- 有显式路由时观察 `completed` 主回合，不收集子 Agent 回合；仅有效 policy 开启学习才进入等待和模型提取，关闭时丢弃候选。不再使用关键词筛选或逐回合 Promise 串行队列。每个源 session 在内存中仅保留一个有界 pending 批次，持续空闲 `idleDelayMs` 后合并提取一次；新回合重置等待，未开始的批次不持久化。学习不占父 Agent 的维护锁；新前台回合开始会取消当前尝试，前台无需等待旧学习排空，已取出的批次不重放。
- `extractionMaxInputBytes` 默认 32 KiB，按批次 JSON 计量；单回合优先保留完整用户／助手文本，超限时仅保留该回合全部完整用户消息，用户证据也放不下则跳过。合并批次超限时先舍弃全部助手上下文，只有完整用户消息仍放不下才移除最旧回合；不裁断用户证据、不拼装助手片段，也不补猜缺失上下文。
- 短生命周期学习 Agent 仅可调用三个 Memory 工具，使用显式后台路由、`maxTokens: 900`，单批最多 3 次 canonical `llm/stream` 请求，沿用所选 provider 的默认推理设置，不新增 effort 配置；provider 内部重试不包含在该计数中，因此这不是总 token、HTTP 请求数或费用保证。失败或用尽额度后不自动重试，辅助请求和写入仍留在 Harness 日志中。
- 普通自动索引 I/O 失败会发出警告并沿用旧快照，主回合继续；policy 异常与 abort 仍严格传播。显式 `memory_read` 读失败必须报错，不伪装成空文档。
- service/store 的 `write` 与 `forget` 返回是否实际改变文件的 `boolean`，不提供记忆回退 API。更正先预读和校验，再逐文件提交新主题、最终索引及不同旧主题的清理；取消或失败可留下部分更新，不保证跨文件原子性，不回滚。批次中的回合分隔只帮助理解反馈上下文，不用于持久事实的原始回合归因。
- Secret-like values are rejected before files are created.

## Configuration

Mount the package after the base bundle:

```yaml
- id: memory
  name: '@vascent/dsh-tui/memory'
  config:
    root: !!js dshHomePath('memories')
    useMemories: true
    generateMemories: false
    idleDelayMs: 300000
    maxContextBytes: 25600
    maxDocumentBytes: 262144
    maxSummaryChars: 600
    maxDetailsChars: 4000
    extractionMaxInputBytes: 32768
```

`maxContextBytes` 至少为 256 字节，默认 25,600 字节，包含 scope 标题、省略提示和闭合标记；它是上限，不是索引应填满的目标。`extractionMaxInputBytes` 限制序列化批次 JSON，而非整个维护提示词。

后台默认关闭、等待连续空闲 300,000 毫秒（5 分钟）。需要后台学习时，在 Memory 插件 config 中同时显式设置 `extractionProvider` 与 `extractionModel`，自行选择已注册且愿意承担其费用的路由，再开启 `generateMemories`。不继承主 Agent 路由，不默认选择或配置收费模型；部署示例不包含后台 provider/model，不修改用户已有的 `~/.dsh` 设置。

两项均未配置时，`MemoryOverview.learning` 为 `undefined`，有效 policy 的 `generateMemories` 为 `false`；请求 `setPolicy(..., { generateMemories: true })` 会明确报错。只配置一项或提供空值属于无效插件配置，需修正后加载。路由完整时，`learning` 提供 `provider`、`model`、`idleDelayMs` 与 `maxRequests`。现有 Memories 对话框显示后台专用路由、等待时间及单批模型请求边界；未配置时提示这两个字段并禁用学习开关，使用记忆与文档浏览仍可用，不新增设置页。

`generateMemories: false` 仅关闭后台学习，主 Agent 的显式记忆工具仍可用；`useMemories: false` 仅关闭自动索引注入。关闭学习、源 Agent 退出或 Memory 服务退出会取消未开始及活跃工作；重新开启只收集未来回合，不恢复已取消的旧候选批次。

Session clients await `ctx.memory.setPolicy(sessionId, patch)` to persist memory
switches without changing deployment defaults. `ctx.memory.policy(sessionId)`
also returns a Promise. Disabling learning resolves after queued and active
learning has been canceled and drained. Failed child cleanup rejects the call
and publishes error activity; the disabled policy remains persisted. The TUI
displays the acknowledged policy. After a failed operation it reads the current
policy and shows it alongside the error; an unreadable policy is shown as unknown.

The [context and learning quality contract](../../docs/tui-architecture.md#memory-上下文与学习质量) defines selection, evidence preservation and evaluation limits. Session policy ownership, recovery, and cancellation boundaries remain defined in
[the session policy contract](../../docs/tui-architecture.md#memory-session-policy-and-learning).

## Develop

```sh
cd ../..
pnpm install --frozen-lockfile
pnpm run check
```

测试聚焦记忆读写遗忘、有界上下文、用户证据、会话开关与后台批次等生产行为。精确措辞、固定字段或提示词关键字断言不代表回答更好；不维护独立 live 评分或回放框架。已完成一轮 Qwen 隔离小样本观察，验证了样例中的纠正复用与明确临时例外；它不是新旧实现的对照，不证明整体质量或计费效率提高。观察边界与本轮修正契约统一记录在[架构文档](../../docs/tui-architecture.md#memory-上下文与学习质量)。

For quality observations, use a test project and an isolated Memory root with
the normal client. Give real, de-identified feedback, then ask a related task in
a fresh session. Also try a temporary exception and a natural topic change.
Look for fewer repeated mistakes, useful reuse, and inappropriate application
of old preferences, without prescribing the answer in the task. Compare with
automatic memory injection disabled when helpful; observations guide improvements,
not exact-recall or pass-rate guarantees. See the
[quality guidance](../../docs/tui-architecture.md#memory-质量观察).

The workspace builds ESM runtime and declarations into ignored `dist/` output.
The release pipeline verifies and embeds that runtime in the public
`@vascent/dsh-tui` package; generated artifacts are not committed and this
workspace is not published independently.

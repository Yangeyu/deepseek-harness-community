# dscode 故障诊断

dscode（DeepSeek Harness Community 终端）环境与运行故障的诊断参考。原则：先取现场证据（`/status`、`dscode doctor --json`、报错原文），再对照症状逐条排查；不凭猜测改动 `~/.dsh` 下的结构。

## 0. 现场信息采集

1. **会话状态**：让用户运行 `/status`（session id、cwd、运行态）或读报错会话输出。
2. **环境诊断**：bash 执行 `dscode doctor --json`。检查项含义：
   - `node`：Node 版本（需 ^22.19.0 或 ≥24）
   - `dsh`：Harness 可执行文件能否解析
   - `tui-bundle`：本安装的社区 bundle 能否解析
   - `profile`：profile 是否指向本安装（见下节）
   - `terminal` / `workspace` / `clipboard`：运行环境基本能力
3. **配置**：read `settings.yaml` 相关段（schema 与语义见 `guides/docs/configuration.md`）。

## 1. 症状 → 排查

### 启动/首次使用异常、找不到 TUI 服务
- 查 profile 清单 `~/.dsh/profiles/tui/package.json`：`dsh.profile.bundles` 应包含 `@deepseek-ai/dsh-base` 与 `@vascent/deepseek-harness-tui`。
- 缺 bundle 时运行一次 `dscode` 会自愈（launcher 自动 `plugin add` 并打印 "configuring the profile"），或手动 `dscode plugin add <packages/tui 路径>`（`dscode plugin` 是 pnpm 转发）。
- `~/.dsh/profiles/node_modules/` 是安装托管的回退符号链接目录，**不要手工改动**。

### Provider / API key 请求失败
- Bailian 或 Vision 代理：`DASHSCOPE_API_KEY` 未设置 → 引导用户导出；`llm-bailian.baseURL` 是否被改动。
- DeepSeek Official：`DEEPSEEK_API_KEY`。
- Tavily：`TAVILY_API_KEY`；`searchProvider: community-tavily` 且无 key 时 readiness 失败 → 改回 `auto` 或补 key。
- 默认模型指向未注册 id：`agent-default-model.model` 必须存在于 `llm-bailian.models` 键中。

### Browser 原子工具不可用、审批拒绝或状态失效
- 找不到工具：检查有效 Cordis 配置是否启用 `id: browser`；`settings.yaml` 本身不挂载插件。入口是 `browser_open` / `browser_observe` / `browser_act` / `browser_close`，不再提供 `browser_task`。Browser 配置只有 `python`、`timeoutMs`、`idleTimeoutMs`，旧 `provider` / `model` / `maxSteps` / `maxTokens` 不兼容。
- Python 或依赖错误：核对 `browser.python` 是否指向用户已安装 `browser-harness==0.1.13` 的 Python 3.12+ 环境；默认 `python3`，自定义路径用绝对路径。插件不会自动装依赖或改用户浏览器配置。
- `daemon ... didn't come up`：读取错误给出的 daemon 日志。`DevToolsActivePort not found` 表示未发现可连接的浏览器；请用户核对预配置的 browser-harness profile、Chrome 远程调试授权或独立 CDP 地址，不要接管其他 tab。Browser 没有独立模型请求循环，不要当成 Browser 模型鉴权失败。
- 审批立即拒绝：`open` 必须 Host 审批一次，`click` / `fill` / `select` 每动作审批，截图观察也单独审批。approval `never` 明确拒绝全部 `ask`；`danger-full-access` 文件模式不是浏览器许可，其预设还联动 `never`，不能用来绕过审批。请用户用已存在的 `/config permission` 检查并调整预设，不要在 `permission.defaultPreset` 中写 `ask`。
- 等待审批时超时也会清理 tab：`timeoutMs` 包含每次调用的审批等待，默认 `300000` 毫秒、范围 `1000–1800000`。不要把被取消或超时的动作视为未发生；重新打开并观察验收，避免重复提交。
- `browserId` 或观察失效：状态仅在同一 Agent 的当前 turn 内跨工具保留，取消、超时、插件卸载、Agent 释放、turn 变为 idle 或空闲兜底 `idleTimeoutMs` 都可能清理。turn 完成后或 resume 先重新 `open`、重新观察；动作使用最新 `observationId` / `actionId`，`text` 仅用于 `fill`。
- 跨 origin 后无法观察/操作：这是单 origin 边界，DOM 和截图均不再返回；先 `close`，再对新 origin 重新 `open` 审批。它不是网络隔离，已经发生的导航、弹窗、子资源请求不保证阻止；`scroll` / `wait` 复用站点许可，但也可能触发网络请求。
- 看不到截图：`browser_observe` 的 `screenshot` 默认 `false`，显式开启需单独审批。图像模型从原生工具结果看图；文本模型用返回的真实 `attachment_ref` 调现有 `inspect_image`，再按下文 Vision 项检查配置，不伪造路径或用户 prompt。
- 页面、截图和填写内容可能含敏感信息，脱敏不完整；密码/OTP 请用户处理。工具参数（包括 `fill` 内容）进入 Host 日志，排障不要转储敏感参数或声称不落盘。
- 清理后仍有 tab：只关闭本 Agent 自有 tab，不关闭 daemon/browser 或其他 tab；强杀或后端无响应时可能残留，请用户确认归属后处理。工具执行状态不是业务成功，须重新观察确认实际结果。
- 修复插件源码后仍用 `pnpm dev` 重启；是否构建 Browser 由有效启用配置决定，不需要切换启动命令。若只有 `fetch failed`，不要无证据推断 DNS/TLS 原因，先区分主 Agent、Vision 代理和浏览器后端的错误来源。

### `web_search` / `web_extract` 不可用
- 看 `community-web.searchProvider` / `extractProvider` 当前值。`auto` 语义：有 `TAVILY_API_KEY` 走 Tavily，否则 DeepSeek Official。
- Tavily 超时：`tavilyTimeoutSeconds` 与网络状况；官方搜索是始终存在的回落。

### 图片理解不可用
- `vision.mode: disabled` → 打开为 `auto`/`proxy`。
- `proxy` 模式下 `proxyProvider` 凭证缺失（默认 `bailian` 走 `DASHSCOPE_API_KEY`）。
- 粘贴或附加在当前 Prompt 中的图片无需模型再次调用工具；原生图文线路直接由官方链路解析。
- `read_image` 用于原生图文线路读取文件；`inspect_image` 仅用于文本线路或显式 `vision.mode: proxy`。原生 `auto` 线路调用 `inspect_image` 会在读取文件或附件前明确拒绝。

### skill 不出现
- 目录（优先级序）：项目 `.dsh/skills`、项目 `.agents/skills`、`~/.dsh/skills`、`~/.agents/skills`。
- 格式：`<name>/SKILL.md` 或 `<name>.md`；frontmatter 必填 `name`（kebab-case）与 `description`；`disable-model-invocation: true` 会从模型目录隐藏。
- 新增后当前会话看不到：让用户新开会话或在受监控根目录内触发文件变更（watcher 实时性）。注意：dscode 的文档型内容在 `docs/`（知识），skill 目录只放流程型能力。

### 会话/终端行为异常
- `/trajectory` 看执行链；`/rewind` 回退；`dscode resume <session-id>` 续接。
- 版本漂移：`npm update -g @vascent/dsh-tui` 后运行一次 `dscode`，launcher 会确认当前安装的私有 Bundle 已挂载；不再迁移历史包名或旧 profile 结构。

## 2. 隔离排查

- 开发/实验：`pnpm dev`（仓库内，profile `tui-dev`），或 `DSH_TUI_PROFILE=实验名 dscode`。
- 彻底隔离：临时 `DSH_HOME=$(mktemp -d)` 起干净实例，区分"用户数据问题"与"安装问题"。
- 配置漂移：先读 `~/.dsh/profiles/tui/cordis.patch.yml` 与 `--patch` 叠加层。

## 3. 边界（不要做）

- 不手工编辑 `~/.dsh/profiles/*/node_modules` 或回退链接目录。
- 不在用户数据上做破坏性实验；疑似上游 bug 先最小复现（clean DSH_HOME）再上报。
- 凭证问题只引导用户设置环境变量，绝不触碰/转储密钥值。

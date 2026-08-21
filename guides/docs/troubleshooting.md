# dscode 故障诊断

dscode（DeepSeek Harness Community 终端）环境与运行故障的诊断参考。原则：先取现场证据（`/status`、`dscode doctor --json`、报错原文），再对照症状逐条排查；不凭猜测改动 `~/.dsh` 下的结构。

## 0. 现场信息采集

1. **会话状态**：让用户运行 `/status`（session id、cwd、运行态）或读报错会话输出。
2. **环境诊断**：bash 执行 `dscode doctor --json`。检查项含义：
   - `node`：Node 版本（需 ^22.19.0 或 ≥24）
   - `dsh`：Harness 可执行文件能否解析
   - `tui-bundle`：本安装的社区 bundle 能否解析
   - `ripgrep`：搜索二进制
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

### `web_search` / `web_extract` 不可用
- 看 `community-web.searchProvider` / `extractProvider` 当前值。`auto` 语义：有 `TAVILY_API_KEY` 走 Tavily，否则 DeepSeek Official。
- Tavily 超时：`tavilyTimeoutSeconds` 与网络状况；官方搜索是始终存在的回落。

### 图片理解不可用
- `vision.mode: disabled` → 打开为 `auto`/`proxy`。
- `proxy` 模式下 `proxyProvider` 凭证缺失（`dashscope-vision` 走 `DASHSCOPE_API_KEY`）。
- `read_image` 仅原生图文线路可用；文本线路应使用 `inspect_image`（按 `vision.mode` 路由）。

### skill 不出现
- 目录（优先级序）：项目 `.dsh/skills`、项目 `.agents/skills`、`~/.dsh/skills`、`~/.agents/skills`。
- 格式：`<name>/SKILL.md` 或 `<name>.md`；frontmatter 必填 `name`（kebab-case）与 `description`；`disable-model-invocation: true` 会从模型目录隐藏。
- 新增后当前会话看不到：让用户新开会话或在受监控根目录内触发文件变更（watcher 实时性）。注意：dscode 的文档型内容在 `docs/`（知识），skill 目录只放流程型能力。

### 会话/终端行为异常
- `/trajectory` 看执行链；`/rewind` 回退；`dscode resume <session-id>` 续接。
- 版本漂移：`npm update -g @vascent/dsh-tui` 后首启自动迁移 legacy bundle（如 `@yangeyu/deepseek-harness-tui`）；报错时才需人工 `dscode plugin remove`。

## 2. 隔离排查

- 开发/实验：`pnpm dev`（仓库内，profile `tui-dev`），或 `DSH_TUI_PROFILE=实验名 dscode`。
- 彻底隔离：临时 `DSH_HOME=$(mktemp -d)` 起干净实例，区分"用户数据问题"与"安装问题"。
- 配置漂移：先读 `~/.dsh/profiles/tui/cordis.patch.yml` 与 `--patch` 叠加层。

## 3. 边界（不要做）

- 不手工编辑 `~/.dsh/profiles/*/node_modules` 或回退链接目录。
- 不在用户数据上做破坏性实验；疑似上游 bug 先最小复现（clean DSH_HOME）再上报。
- 凭证问题只引导用户设置环境变量，绝不触碰/转储密钥值。
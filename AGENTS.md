# dscode 环境指南

> 本文件位于仓库根，会话工作在本仓库（含子目录）时由 `dsh-agent-instructions` 自动注入——每位进入本仓库的 dscode 会话第一步就会读到，无需任何配置。
> **全局生效**（在任意项目都让 dscode 读懂自己）：`cp AGENTS.md ~/.dsh/AGENTS.md`（全局安装的发布物在 `<npm prefix>/AGENTS.md`，`npm root -g` 定位）。全局副本是衍生品：仓库版随版本演进，需要时重新复制。
> 本文件是**目录 + 核心描述**：只写身份、"在哪里查"与日常 80% 需要的事实。细节一律以 `docs/` 下的文档为单一事实源——需要时用 read 工具按需加载，不要凭记忆回答细节问题。
> 运行中的配置值永远以 `~/.dsh/settings.yaml` 现场文件为准（热更新），本文件不固化任何"当前值"。

## 文档目录（何时读哪份）

| 文档 | 何时读它 | 位置 |
|---|---|---|
| `docs/dscode-configuration.md` | 涉及配置查看/修改、模型与 provider、vision 路由、web 搜索策略、API key、settings.yaml schema 细节时 | 本仓库 `docs/`；仓库外（全局副本场景）在 `<npm prefix>/docs/` |
| `docs/dscode-troubleshooting.md` | 会话报错、provider/API key 不通、vision/web 不可用、dscode doctor 输出异常、升级问题时 | 同上 |
| `docs/tui-architecture.md` | 架构、所有权边界、设计惯例问题 | 本仓库 `docs/` |
| `docs/tui-product-roadmap.md` | 里程碑与规划现状 | 本仓库 `docs/` |
| `docs/tui-v0.1.x-design.md` | 目标版本的生命周期/协议设计细节 | 本仓库 `docs/` |

找不到 `docs/` 时（工作在别的项目），配置与诊断细节按上述 npm 全局路径查找；仍找不到就声明"文档不可用"并依据 `settings.yaml` 现场值保守回答。

## 身份与构造

- dscode 是 DeepSeek Harness 的社区构建（DeepSeek Harness Community 终端客户端），会话运行在 Harness profile `tui` 上（开发隔离用 `tui-dev`，由 `pnpm dev` 使用）。
- profile 清单：`~/.dsh/profiles/tui/package.json` 的 `dsh.profile.bundles` = `@deepseek-ai/dsh-base` + `@vascent/deepseek-harness-tui`；用户级补丁层是相邻的 `cordis.patch.yml`。
- 源码仓库中社区 bundle 的补丁是 `packages/tui/cordis.patch.yml`（persona、社区 provider 挂载、TUI 端配置都在这里）。

## 目录布局（`DSH_HOME`，默认 `~/.dsh`）

| 路径 | 内容 |
|---|---|
| `profiles/<name>/` | 各 profile 的清单、`cordis.patch.yml`、node_modules |
| `settings.yaml` | 全局配置事实源（热更新），段结构见 `docs/dscode-configuration.md` |
| `memories/` | 社区 Markdown 记忆（`MEMORY.md` + 主题文件），会话中自动以 memory-context 注入 |
| `skills/` | 用户级 skill（流程型能力，非文档）；另有项目 `.dsh/skills` 与 `~/.agents/skills` |
| `sessions/` `rewind/` `attachments/` `storages/` | 会话日志、Rewind 存证、图片字节、存储后端 |

## 配置纪律

1. **当前值现取**：回答"现在是什么配置"前，先 read `settings.yaml` 对应段（细节见配置文档）；绝不把路由/模型/策略的具体值写死。
2. **细节先查文档**：涉及 schema、枚举、路由语义、症状排查时，先 read 目录表中的对应文档再动手，不要凭训练记忆。
3. **修改 = 编辑 `settings.yaml`**：热生效、无需重启；改完说明生效范围。
4. **凭证不落盘**：`settings.yaml` 只存环境变量引用名（如 `tavilyApiKeyEnv: TAVILY_API_KEY`）；密钥本体在环境变量或 `~/.dsh/.credentials.yaml`。永不写密钥值。
5. 需要交互界面时提示用户运行对应斜杠命令。

## 核心速览

- **settings.yaml 段**（细节见配置文档）：`agent-default-model:`（默认模型/provider/effort）、`llm-bailian:`（首类 Bailian provider）、`llm-pi-ai:`（聚合 provider）、`vision:`（`mode` = auto|proxy|disabled）、`community-web:`（`searchProvider` = auto|community-tavily|deepseek-official）、`community-tui:`（keymap）、`permission:`（defaultPreset）。
- **环境变量**：凭证 `DASHSCOPE_API_KEY` / `DEEPSEEK_API_KEY` / `TAVILY_API_KEY`；隔离 `DSH_HOME`、`DSH_TUI_PROFILE`、`DSH_TOOLS_MODE`、`DSH_PERMISSION_MODE`。
- **斜杠命令**：`/status` `/task` `/trajectory` `/config [section]` `/vision` `/web` `/skills` `/memories` `/rewind` `/model` `/help`。
- **CLI**：`dscode doctor [--json]`、`dscode sessions`/`resume`、`dscode exec [-C <path>]`、`dscode config show|default`、`dscode plugin <pnpm 参数>`、`--patch <file>`。
- **社区能力**：首类 Bailian（文本 `deepseek-v4-pro-0813` / 图像 `qwen3.7-plus`）；文本模型通过 `inspect_image` 走 Vision 代理；`web_search` 策略按 `community-web.searchProvider`（auto 语义：有 Tavily key 走 Tavily，否则 DeepSeek Official）；`web_extract` 走 `extractProvider`；Markdown 记忆自动注入 `<memory-context>`。
- **skill 与文档分工**：skill 只承载流程型能力（`~/.dsh/skills` 等目录）；dscode 的知识型内容全部在 `docs/`，由本目录表按需路由。

## 维护

本文件与 `docs/` 文档随版本演进同步更新——文档新增/改名时先改这个目录表，避免入口失效。
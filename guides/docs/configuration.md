# dscode 配置参考

dscode（DeepSeek Harness Community 终端）配置的单一事实源。本文件描述**schema 与语义**（枚举、默认、联动）；运行中"现在是什么值"永远以现场 `settings.yaml` 为准。

## 0. 读现场配置（所有操作的第一步）

- 路径：`$DSH_HOME/settings.yaml`（默认 `~/.dsh/settings.yaml`），热更新——编辑后无需重启进程。
- **安装引导**：dscode 首次运行会把两份带注释的参考模板放到配置根目录（只写一次、不覆盖、不生效）：`$DSH_HOME/settings.yaml.example`（本文件全部段落的示例与修改指引）与 `$DSH_HOME/cordis.patch.yml.example`（patch 层示例）。改配置时照抄对应段落到 `settings.yaml` 即可。
- 可视化界面对应 `settings.yaml` 各段：`/config [model|reasoning|permission|plan|vision|web|interface]`、`/vision`、`/web`。
- 程序化查看：`dscode config show`（launcher 转发 profile 的 dumped 配置）、`dscode config default`（默认值）。
- 凭证规则：settings 文件只存**环境变量名引用**（值形如 `tavilyApiKeyEnv: TAVILY_API_KEY`）；密钥本体在环境变量或 `~/.dsh/.credentials.yaml`。任何情况下不得把密钥值写回 settings.yaml 或其它文件。

## 1. 各段 schema 与语义

### `agent-default-model:` — 会话默认模型
- `provider` / `model` / `reasoningEffort`。会话创建时读取（`/model`、`-m` 覆盖单会话）。
- `model` 必须是已挂载 provider 注册的 id——即 `llm-bailian.models` 的键（或 `llm-pi-ai.providers.*.models`）。

### `llm-bailian:` — 首类 Bailian provider
- `baseURL`：OpenAI 兼容端点（默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`）。
- `models`：键为模型 id，值含 `contextWindow` / `maxOutputTokens` / 输入模态 / `reasoning.efforts`。凭证来自 `DASHSCOPE_API_KEY`。

### `llm-pi-ai:` — 聚合 provider
- `providers.<id>`：每个子项是一个 provider 配置（`apiKeyEnv`、`api`、`baseURL`、`models` 等）。示例 id：`dashscope-vision`（Vision 代理线路，凭证同为 `DASHSCOPE_API_KEY`）。
- 没有对应 section 时该 provider 不注册模型——这是"挂载"式注册，不是声明式开关。

### `vision:` — 图片路由
- `mode`：`auto`（按线路能力自动决定直读/代理）、`proxy`（强制经文本代理链路分析）、`disabled`（关闭）。
- `proxyProvider` / `proxyModel`：代理线路与模型（常用 `dashscope-vision` / `qwen3.7-plus`）。
- 语义：`read_image` 仅原生图文线路可用；文本模型会话应使用 `inspect_image`（按 `mode` 走代理）。`inspect_image` 的路径解析与官方 `read` 工具族共用 filesystem backend 的读 seam，不设 workspace 边界；工具只保留能力级上限（5 MiB 字节、PNG/JPEG/WebP/GIF 媒体类型）。

### `community-web:` — 搜索与网页提取
- `searchProvider`：`auto`（有 `TAVILY_API_KEY` 走 Tavily，否则回落 DeepSeek Official）、`community-tavily`（强制 Tavily，无 key 时 readiness 失败）、`deepseek-official`（强制官方）。
- `extractProvider`：页面提取 provider（默认 `community-tavily`）。
- `tavily*`：`tavilyApiKeyEnv`（凭证引用名，默认 `TAVILY_API_KEY`）、`tavilySearchEndpoint` / `tavilyExtractEndpoint`、`tavilySearchDepth`（`basic|advanced|fast|ultra-fast`）、`tavilyExtractDepth`（`basic|advanced`）、`tavilyTimeoutSeconds`（1–60）、`extractMaxOutputChars`。

### `permission:` — 权限预设
- `defaultPreset`：`read-only` | `workspace-write` | `danger-full-access`。
- 预设联动 sandbox 与审批策略：`danger-full-access` 意味着审批条永不询问（approval: never）。修改时说明安全影响；不轻易在无人值守场景改此值。

### `ui-*` 段
主题（`ui-theme`）、会话排队（`ui-conversation`）、引导状态（`ui-onboarding`）等 UI 偏好，与 agent 能力无关，仅用户明确要求时调整。

## 2. 环境变量

| 变量 | 作用 |
|---|---|
| `DASHSCOPE_API_KEY` | Bailian 与 Vision 代理线路（dashscope-vision）凭证 |
| `DEEPSEEK_API_KEY` | DeepSeek Official 与官方 web 搜索凭证 |
| `TAVILY_API_KEY` | Tavily 搜索/提取凭证（`community-web` 自动选择依据） |
| `DSH_HOME` | Harness 数据根（默认 `~/.dsh`），所有路径随之移动 |
| `DSH_TUI_PROFILE` | 覆盖 profile 名（`[A-Za-z0-9._-]`），隔离实验用 |
| `DSH_TOOLS_MODE` | 工具目录呈现模式（native/code） |
| `DSH_PERMISSION_MODE` | 启动权限模式（read-only/workspace-write/danger-full-access），决定 sandbox 与审批策略 |

## 3. 常见任务配方

- **选默认模型**：改 `agent-default-model.model` 为 `llm-bailian.models` 中存在的 id（provider/effort 同段）。
- **强制 Tavily 搜索**：`community-web.searchProvider: community-tavily`，并确认 `TAVILY_API_KEY` 已配置；否则改回 `auto` 用官方回落。
- **纯文本线路看图**：`vision.mode: proxy` + `proxyProvider`/`proxyModel` 指向有凭证的图像模型。
- **收紧权限**：`permission.defaultPreset: workspace-write`（或更低），并说明 sandbox/审批联动。

## 4. 修改方式与生效范围

- 用 edit/write 修改 `settings.yaml`：热生效，会话可感知。
- 单次覆盖用 `--patch <file>`（launcher 的 profile 叠加层）或 profile 级 `~/.dsh/profiles/tui/cordis.patch.yml`。
- 凭证改动只引导用户设置环境变量（shell profile 或 `.env`），不代写密钥。

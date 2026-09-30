# dscode 配置参考

配置由 bundle 默认值、profile patch、机器级 patch 和单次覆盖共同组成。当前值以 `dscode config show` 的合成结果及运行中的 `/config` 为准。

## 0. 查看与修改当前配置

- profile 文件：`$DSH_HOME/profiles/<name>/cordis.patch.yml`，默认 profile 为 `tui`；开发使用 `tui-dev`。
- 按优先级从低到高合成：bundle → profile patch → `$DSH_HOME/cordis.patch.yml` → `--patch <file>`。patch 是按插件条目 `id` 定位的列表，配置放在条目的 `config` 下。
- 手写 patch 的 `config` 整体替换该条目的继承配置；缺失字段使用插件 schema 默认值。请保留仍需使用的已有字段，尤其是模型表。界面设置由 Settings Forms 合并当前值后写回。
- `/config`、`/vision`、`/web` 通过上游 Settings Forms 更新插件的 Volatile Config，写回当前 profile patch；可热更新的字段立即生效。高优先级 patch 覆盖的字段不能借此改写。
- 社区 profile 关闭文件 HMR。直接编辑 patch 后重启；挂载、卸载插件等结构修改也需要重启。
- 首次运行提供 `$DSH_HOME/cordis.patch.yml.example` 参考模板；模板本身不生效。
- `dscode config show` 查看合成配置，`dscode config default` 查看 bundle 默认值。
- 凭证引用只写环境变量名（例如 `tavilyApiKeyEnv: TAVILY_API_KEY`）；密钥通过环境变量或 Harness 凭据库管理，不写入 patch。

```yaml
- id: vision
  config:
    mode: proxy
    proxyProvider: bailian
    proxyModel: qwen3.7-plus
```

### DeepSeek 模型目录

打开 `/model` 会重新读取 Host 目录，不会自动切换当前模型。
DeepSeek 的模型目录和能力由上游 provider 及 `llm-deepseek.models` 设置提供，
刷新不会请求远端 `/models`。上游默认目录随依赖版本更新；也可以通过设置显式指定模型目录。
当前运行时包含 **DeepSeek-V41-Flash**，路由是 `deepseek-official/deepseek-flash`。
更新依赖后需重启；仓库开发使用 `npm run dev`，全局安装的 `dscode` 使用其自身的依赖版本。
新版运行时会将打开的旧会话迁移到 V4；迁移后不能用旧版运行时读取该会话。

## 1. 插件 config 与语义

### `agent-default-model` — 会话默认模型
- `provider` / `model` / `reasoningEffort`。会话创建时读取（`/model`、`-m` 覆盖单会话）。
- `model` 必须是已挂载 provider 注册的 id——即 `llm-bailian.models` 的键（或 `llm-pi-ai.providers.*.models`）。

### `llm-bailian` — 首类 Bailian provider
- `baseURL`：OpenAI 兼容端点（默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`）。
- `models`：键为模型 id，值含 `contextWindow` / `maxOutputTokens` / 输入模态 / `reasoning.efforts`。凭证来自 `DASHSCOPE_API_KEY`。

### `llm-pi-ai` — 聚合 provider
- `providers.<id>`：每个子项是一个 provider 配置（`apiKeyEnv`、`api`、`baseURL`、`models` 等）。示例 id：`dashscope-vision`（Vision 代理线路，凭证同为 `DASHSCOPE_API_KEY`）。
- 条目必须先由 bundle 或 patch 挂载；修改 config 不会自行添加 provider 插件。

### `vision` — 图片路由
- `mode`：`auto`（按线路能力自动决定直读/代理）、`proxy`（强制经文本代理链路分析）、`disabled`（关闭代理；不影响原生多模态输入）。
- `proxyProvider` / `proxyModel`：代理线路与模型（Bundle 默认 `bailian` / `qwen3.7-plus`）。
- 语义：每次图片提交只解析一次线路；非强制代理时，图文模型直接进入官方 Host/Attachment/provider 链路，即使 Vision 未挂载或设为 `disabled` 也可用。文本或能力未知的模型需要可用代理，`proxy` 则显式强制代理。图片与文本共用提交、排队和中断流程，代理观察作为同条消息的独立证据保存。`read_image` 仅原生图文线路可用。`inspect_image` 虽保持稳定注册，但会先检查当前线路：原生 `auto` 线路在读取来源前拒绝，文本 `auto` 或强制代理线路才执行。文件来源与官方 `read` 工具族共用 filesystem backend；扩展名只声明媒体类型，图片字节、尺寸、标准化和部署上限由官方 Attachment 服务最终校验。

### `community-web` — 搜索与网页提取
- `searchProvider`：`auto`（有 `TAVILY_API_KEY` 走 Tavily，否则回落 DeepSeek Official）、`community-tavily`（强制 Tavily，无 key 时 readiness 失败）、`deepseek-official`（强制官方）。
- `extractProvider`：页面提取 provider（默认 `community-tavily`）。
- `tavily*`：`tavilyApiKeyEnv`（凭证引用名，默认 `TAVILY_API_KEY`）、`tavilySearchEndpoint` / `tavilyExtractEndpoint`、`tavilySearchDepth`（`basic|advanced|fast|ultra-fast`）、`tavilyExtractDepth`（`basic|advanced`）、`tavilyTimeoutSeconds`（1–60）、`extractMaxOutputChars`。

### `permission` — 权限预设
- `defaultPreset`：配置的预设，默认含 `read-only`、`workspace-write`、`danger-full-access`。进程可选目录由上游服务提供；`auto` 等运行时贡献只用于当前会话，不保存为默认。
- 预设联动 sandbox 与审批策略：`danger-full-access` 意味着审批条永不询问（approval: never）。修改时说明安全影响；不轻易在无人值守场景改此值。

### `terminal` — TUI
- `historyMessages`、`rewindHistory`、`showReasoning`、`thinkingMaxLines`、`color` 配置终端启动行为。
- 界面的 details 展开状态属于当前 TUI 实例。

## 2. 环境变量

| 变量 | 作用 |
|---|---|
| `DASHSCOPE_API_KEY` | Bailian 与 Vision 代理线路（dashscope-vision）凭证 |
| `DEEPSEEK_API_KEY` | DeepSeek Official 与官方 web 搜索凭证 |
| `TAVILY_API_KEY` | Tavily 搜索/提取凭证（`community-web` 自动选择依据） |
| `DSH_HOME` | Harness 数据根（默认 `~/.dsh`），所有路径随之移动 |
| `DSH_TUI_PROFILE` | 覆盖 profile 名（`[A-Za-z0-9._-]`），隔离实验用 |
| `DSH_TOOLS_MODE` | 工具目录呈现模式（native/ptc/both） |
| `DSH_PERMISSION_MODE` | 启动权限模式（read-only/workspace-write/danger-full-access），决定 sandbox 与审批策略 |

## 3. 常见任务配方

- **选默认模型**：改 `agent-default-model.model` 为 `llm-bailian.models` 中存在的 id（provider/effort 同段）。
- **强制 Tavily 搜索**：`community-web.searchProvider: community-tavily`，并确认 `TAVILY_API_KEY` 已配置；否则改回 `auto` 用官方回落。
- **纯文本线路看图**：`vision.mode: proxy` + `proxyProvider`/`proxyModel` 指向有凭证的图像模型。
- **收紧权限**：`permission.defaultPreset: workspace-write`（或更低），并说明 sandbox/审批联动。

## 4. 修改方式与生效范围

- 界面操作通过 Settings Forms 写当前 profile patch 并热更新 Volatile 字段。直接用 edit/write 修改 patch 后重启。
- 单次覆盖用 `--patch <file>`；持久配置放在当前 profile 的 `cordis.patch.yml`。
- 凭证改动只引导用户设置环境变量（shell profile 或 `.env`），不代写密钥。

## 5. ChatGPT 订阅模型

在 dscode 中执行 `/connect`，选择 **OpenAI Codex**，再选择浏览器登录或设备码登录。
按提示完成 ChatGPT 授权后，在 `/model` 选择 **OpenAI (ChatGPT subscription)** 下的模型。
`/model` 只选择模型；需要登录或重新授权时使用 `/connect`。Esc 取消登录不会更换模型。

```sh
# 仓库开发验证
npm run dev
```

`/connect openai-codex` 可以重新授权或更换账号。登录结果存入 Harness 的凭据库，
后续请求由已有的 `dsh-llm-pi-ai` 负责读取、刷新和使用；模型路由是
`openai-codex/<model-id>`。默认模型目录来自本次安装的 pi-ai 随包目录；打开 `/model`
刷新 Host 目录不会实时拉取 Codex 远端模型列表。仓库开发与全局 dscode 各自使用
自己的依赖版本。目录是否收录模型与账号能否调用是两件事，实际可用性以请求结果为准。
普通 OpenAI API Key 走独立的 `openai` 路由。
`/usage` 查询当前 provider 的订阅额度，显示剩余百分比和本地时区的重置时间。
目前支持 `openai-codex`，包含服务端返回的主额度和 Spark 等独立额度组；
5 小时、每周等窗口按实际返回展示，缺失的窗口不推算。这是账号额度，并非本会话 token 统计。
查询按命令触发，不会后台轮询；未登录时提示使用 `/connect openai-codex`。
`/connect` 目前只提供 Codex 订阅连接。凭据的解析、校验和刷新由 provider 在请求时处理。
这是第三方兼容接入，尚未确认 dscode 已取得 OpenAI 官方 OAuth 应用授权。

这里是 Harness 直接调用模型：Agent 循环、工具、权限、Memory、Rewind 和会话历史
仍由 Harness 管理，无需安装或启动 Codex CLI/App Server。已有 Codex CLI 登录不会
自动导入。浏览器回调不可达时可按提示粘贴回调 URL，远程终端也可选设备码登录。

## 6. Browser Use 与 Computer Use

两个实验性能力随包安装，默认关闭。单次启动可用：

```sh
DSH_BROWSER_USE=1 DSH_COMPUTER_USE=1 dscode
# 仓库开发使用相同变量启动 pnpm dev。
```

持久启用时，在当前 profile 的 `cordis.patch.yml` 添加以下条目并重启：

```yaml
- id: community-browser
  disabled: false
- id: computer-use-native
  disabled: false
```

### 操作日常 Chrome

`community-browser` 通过 Chrome DevTools MCP 的 `autoConnect` 连接当前用户的
Chrome Stable，复用已有标签页和登录状态。需要 Chrome 144 或更新版本：在
`chrome://inspect/#remote-debugging` 开启远程调试，并由用户允许 Chrome 显示的
连接请求。关闭 dscode 只断开连接，不关闭日常 Chrome。

每个活动 Session 独占该浏览器连接。另一个同时存在的 Session 没有浏览器工具；
释放占用者后，新建或恢复 Session 才重新获取连接。上游共享运行时负责串行调用、
取消、MCP 资源与退出清理。浏览器页面和登录状态属于外部 Chrome，Rewind 不回退
网页操作。配置不启动另一个浏览器，也不复制用户 profile。

### 操作桌面

`computer-use-native` 组合官方 computer-use 服务与 Cua Driver Native，随包安装
对应平台的原生依赖。macOS 需给启动 dscode 的终端应用授予辅助功能和屏幕录制权限。
可先让模型调用 `cua_driver_native__check_permissions`，指定 `prompt: false` 查看状态。
桌面是系统共享资源，多个 Session 不获得独立桌面；操作同一窗口时应顺序执行。

### 截图与模型选择

浏览器的文字/结构化页面结果可以供纯文本模型使用。截图工具结果需要当前模型直接
支持图片输入，例如已配置凭证的 `bailian/qwen3.7-plus`。默认的百炼 DeepSeek 路线
声明为纯文本；Vision 代理主要处理用户提交的图片，不会自动接管这些工具截图。
用 `/model` 选择图文模型后再进行基于截图的桌面操作。

工具调用、结果与截图附件沿上游标准执行和 V4 Session 链路进入 Transcript/Trajectory。
启用能力不会自动批准工具操作，仍由当前权限策略处理。取消不会撤销已经发生的点击、
输入或页面修改。

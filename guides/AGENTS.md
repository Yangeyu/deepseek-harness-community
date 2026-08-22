# dscode 使用指南

> 本文件为 dscode 工具用户提供配置和排查指引。
> 部署后位于 `~/.dsh/AGENTS.md`，会话在任意项目都能读取。

## 文档目录

| 文档 | 何时读它 |
|---|---|
| `~/.dsh/docs/configuration.md` | 涉及配置查看/修改、模型与 provider、vision 路由、web 搜索策略、API key、settings.yaml schema 细节时 |
| `~/.dsh/docs/troubleshooting.md` | 会话报错、provider/API key 不通、vision/web 不可用、dscode doctor 输出异常、升级问题时 |

## 目录布局（`DSH_HOME`，默认 `~/.dsh`）

| 路径 | 内容 |
|---|---|
| `profiles/<name>/` | 各 profile 的清单、`cordis.patch.yml`、node_modules |
| `settings.yaml` | 全局配置事实源（热更新），段结构见配置文档 |
| `memories/` | 社区 Markdown 记忆（`MEMORY.md` + 主题文件），会话中自动以 memory-context 注入 |
| `skills/` | 用户级 skill（流程型能力，非文档）；另有项目 `.dsh/skills` 与 `~/.agents/skills` |
| `sessions/` `rewind/` `attachments/` `storages/` | 会话日志、Rewind 存证、图片字节、存储后端 |

## 配置纪律

1. **当前值现取**：回答"现在是什么配置"前，先 read `settings.yaml` 对应段；绝不把路由/模型/策略的具体值写死。
2. **细节先查文档**：涉及 schema、枚举、路由语义、症状排查时，先 read 对应文档再动手，不要凭训练记忆。
3. **修改 = 编辑 `settings.yaml`**：热生效、无需重启；改完说明生效范围。
4. **凭证不落盘**：`settings.yaml` 只存环境变量引用名（如 `tavilyApiKeyEnv: TAVILY_API_KEY`）；密钥本体在环境变量或 `~/.dsh/.credentials.yaml`。永不写密钥值。
5. 需要交互界面时提示用户运行对应斜杠命令。

## 核心速览

- **settings.yaml 段**（细节见配置文档）：`agent-default-model:`（默认模型/provider/effort）、`llm-bailian:`（首类 Bailian provider）、`llm-pi-ai:`（聚合 provider）、`vision:`（`mode` = auto|proxy|disabled）、`community-web:`（`searchProvider` = auto|community-tavily|deepseek-official）、`permission:`（defaultPreset）。
- **环境变量**：凭证 `DASHSCOPE_API_KEY` / `DEEPSEEK_API_KEY` / `TAVILY_API_KEY`；隔离 `DSH_HOME`、`DSH_TUI_PROFILE`、`DSH_TOOLS_MODE`、`DSH_PERMISSION_MODE`。
- **斜杠命令**：`/status` `/task` `/trajectory` `/config [section]` `/vision` `/web` `/skills` `/memories` `/rewind` `/model` `/help`。
- **CLI**：`dscode doctor [--json]`、`dscode sessions`/`resume`、`dscode exec [-C <path>]`、`dscode config show|default`、`dscode plugin <pnpm 参数>`、`--patch <file>`。
- **社区能力**：首类 Bailian（文本 `deepseek-v4-pro-0813` / 图像 `qwen3.7-plus`）；文本模型通过 `inspect_image` 走 Vision 代理；`web_search` 策略按 `community-web.searchProvider`（auto 语义：有 Tavily key 走 Tavily，否则 DeepSeek Official）；`web_extract` 走 `extractProvider`；Markdown 记忆自动注入 `<memory-context>`。

## 部署

本文件及 `docs/` 应部署到 `~/.dsh/`：

```bash
cp guides/AGENTS.md ~/.dsh/AGENTS.md
mkdir -p ~/.dsh/docs
cp guides/docs/*.md ~/.dsh/docs/
```

部署后，文档路径为 `~/.dsh/docs/configuration.md` 和 `~/.dsh/docs/troubleshooting.md`。

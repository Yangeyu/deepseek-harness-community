# 项目开发指南

> 本文件位于仓库根，会话工作在本仓库（含子目录）时由 `dsh-agent-instructions` 自动注入——每位进入本仓库的 dscode 会话第一步就会读到，无需任何配置。
> 本文件为**项目开发者**服务，关注架构、设计与开发流程。
> 工具使用/配置指引见 `guides/AGENTS.md`（部署到 `~/.dsh/AGENTS.md` 供终端用户使用）。

## 项目文档目录

| 文档 | 何时读它 |
|---|---|
| `docs/tui-architecture.md` | 架构、所有权边界、设计惯例问题 |
| `docs/tui-product-roadmap.md` | 里程碑与规划现状 |
| `docs/tui-v0.1.x-design.md` | 目标版本的生命周期/协议设计细节 |

细节一律以 `docs/` 下的文档为单一事实源——需要时用 read 工具按需加载，不要凭记忆回答细节问题。

## 身份与构造

- dscode 是 DeepSeek Harness 的社区构建（DeepSeek Harness Community 终端客户端），会话运行在 Harness profile `tui` 上（开发隔离用 `tui-dev`，由 `pnpm dev` 使用）。
- profile 清单：`~/.dsh/profiles/tui/package.json` 的 `dsh.profile.bundles` = `@deepseek-ai/dsh-base` + `@vascent/deepseek-harness-tui`；用户级补丁层是相邻的 `cordis.patch.yml`。
- 源码仓库中社区 bundle 的补丁是 `packages/tui/cordis.patch.yml`（persona、社区 provider 挂载、TUI 端配置都在这里）。

## 开发与测试

- `pnpm install`：安装依赖
- `pnpm test`：运行测试
- `pnpm typecheck`：类型检查
- `pnpm dev`：开发模式（使用 tui-dev profile）
- `pnpm check`：完整检查（runtime:check + build + lint + typecheck + test）

## 维护

本文件与 `docs/` 文档随版本演进同步更新——文档新增/改名时先改这个目录表，避免入口失效。
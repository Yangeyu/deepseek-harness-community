# DSH 0.2.0-rc.2 全面接入计划

目标：完成已授权的上游升级、旧链路清理与终端可用能力接入。GPT 动态目录按用户要求暂缓。日常浏览器选择 Chrome attach，复用登录状态；不复制 profile、不切换到独立浏览器作为交付。

- [x] 核对 base 新增装配与实验性能力的实际公开契约。
- [x] 通过上游 Browser Use runtime 接入 Chrome，并装配官方 Computer Use provider；DSH 依赖归入统一 catalog，使用明确开关避免外部依赖阻断普通启动。
- [ ] 核对截图、多模态、权限、工具展示、Session 创建/恢复/退出的闭环。
- [x] 覆盖上游新增 base 能力；按实际终端入口说明已接入、限定和不适用项。
- [ ] 验证真实浏览器连接、工具执行、结果归档和释放；验证桌面工具发现、权限及实际可执行范围。
- [x] 同步用户指南、示例、0.3.0 版本及架构契约。
- [x] pnpm check、全新包安装与隔离 TUI/Host 验收。不发布，不修改日常会话。
- [ ] 完成真实操作闭环后，将有效契约并入架构并清理本计划入口。

接入边界：浏览器/桌面由上游工具和生命周期负责；社区不实现第二套驱动或依赖补丁。Browser Use 使用 Chrome DevTools MCP 的 autoConnect；社区仅声明启动参数，复用 DSH 公开 mountSessionMcp 的完整 Session 生命周期。上游现成 provider 未暴露 autoConnect，因此不同时装配该 provider；Computer Use 使用官方 Cua Driver Native provider。两种能力均通过 profile 插件行启用，运行时不做失败切换。

当前验收边界：上游迁移的完整检查、全新 npm 安装与 PTY Ready → Ctrl+C → exit 0 已通过。浏览器采用每活动会话独立 MCP 连接；真实 Host 已在日常 Chrome 完成源会话、分支和另一进程的本地页面访问、快照、点击及结果读取，源会话释放和另一进程退出后，剩余分支仍可操作。新建、分支、持久化恢复和独立取消/释放由真实 Agent、Session 持久化及 MCP 运行时的集成测试覆盖。截图进入模型请求、完整 TUI 交互与桌面输入/截图不在这次验证范围内，不能用工具目录发现或权限通过代替这些验收。

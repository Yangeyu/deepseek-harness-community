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

当前验收边界：完整检查为 801 passed、1 skipped；全新 npm 安装与 PTY Ready → Ctrl+C → exit 0 已通过。真实 Host 已发现 29 个浏览器工具、55 个桌面工具，验证桌面权限查询、浏览器 Session 独占及释放后的工具重新接管。日常 Chrome 已成功创建本地测试页，但后续快照未完成；重连时 Chrome 的 DevToolsActivePort 已不可用，因此页面点击、截图进入模型请求、连接释放后浏览器保留仍待完整实测。桌面输入与截图同样尚未实测，不能用目录发现或权限通过代替这些验收。

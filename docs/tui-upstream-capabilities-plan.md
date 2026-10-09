# DSH 0.2.0-rc.2 全面接入计划

目标：完成已授权的上游升级、旧链路清理与终端可用能力接入。GPT 动态目录按用户要求暂缓。日常浏览器选择 Chrome attach，复用登录状态；不复制 profile、不切换到独立浏览器作为交付。

- [x] 核对 base 新增装配与实验性能力的实际公开契约。
- [x] 通过上游 Browser Use runtime 默认接入 Chrome，并装配可选启用的官方 Computer Use provider；DSH 依赖归入统一 catalog。
- [ ] 核对截图、多模态、权限、工具展示、Session 创建/恢复/退出的闭环。
- [x] 覆盖上游新增 base 能力；按实际终端入口说明已接入、限定和不适用项。
- [ ] 验证真实浏览器连接、工具执行、结果归档和释放；验证桌面工具发现、权限及实际可执行范围。
- [x] 同步用户指南、示例、0.3.0 版本及架构契约。
- [x] pnpm check、全新包安装与隔离 TUI/Host 验收。不发布，不修改日常会话。
- [ ] 完成真实操作闭环后，将有效契约并入架构并清理本计划入口。

接入边界：Browser Use 复用 DSH 公开 mountSessionMcp 的 Session 生命周期及 Playwright MCP 工具；社区扩展与 Native Messaging 适配器负责后台传输、标签归属和 AI 光标，不修改依赖。任务结束解除调试 attachment，后续任务后台重连；普通操作不主动聚焦 Chrome。扩展需首次安装，目前宿主安装支持 macOS/Linux Chrome。Computer Use 使用官方 Cua Driver Native provider。Browser Use 默认启用，Computer Use 可选启用，profile 插件行可覆盖，运行时不做失败切换。

当前验收边界：上游迁移的完整检查、全新 npm 安装与 PTY Ready → Ctrl+C → exit 0 已通过。当前浏览器扩展、Native host 与打包 MCP 已通过隔离 Chrome 的访问、点击读回、截图、活动标签保持、并发归属、取消、释放/重连和用户停止验证。安装后的日常 Chrome 已完成本地测试页访问、点击读回、光标显示和真实 Session 回合结束释放；测试页清理前后终端保持前台。新建、分支、持久化恢复和独立取消/释放由真实 Agent、Session 持久化及 MCP 运行时的集成测试覆盖。完整操作过程的系统焦点连续观测、网页登录业务、截图进入模型请求、完整 TUI 交互与桌面输入/截图仍未覆盖，不能用工具目录发现或权限通过代替这些验收。

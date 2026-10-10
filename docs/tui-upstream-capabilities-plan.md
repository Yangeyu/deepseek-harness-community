# DSH 0.2.0-rc.2 全面接入计划

目标：完成已授权的上游升级、旧链路清理与终端可用能力接入。GPT 动态目录按用户要求暂缓。日常浏览器选择 Chrome attach，复用登录状态；不复制 profile、不切换到独立浏览器作为交付。

- [x] 核对 base 新增装配与实验性能力的实际公开契约。
- [x] 通过上游 Browser Use runtime 默认接入 Chrome，并装配可选启用的官方 Computer Use provider；DSH 依赖归入统一 catalog。
- [ ] 核对截图、多模态、权限、工具展示、Session 创建/恢复/退出的闭环。
- [x] 覆盖上游新增 base 能力；按实际终端入口说明已接入、限定和不适用项。
- [ ] 验证真实浏览器连接、工具执行、结果归档和释放；验证桌面工具发现、权限及实际可执行范围。
- [x] 同步用户指南、示例及架构契约。
- [x] pnpm check、全新包安装与隔离 TUI/Host 验收。
- [ ] 完成真实操作闭环后，将有效契约并入架构并清理本计划入口。

接入边界：Browser Use 复用 DSH 的 Session MCP 生命周期及 Playwright 工具；社区扩展负责后台传输、标签归属和 AI 光标。控制连接跨回合保留，断开时解除接管；普通操作保持后台。首次安装支持 macOS/Linux Chrome。Computer Use 使用官方 Cua Driver Native provider，可按 profile 启用。

已验收：上游迁移完整检查、全新包安装、PTY 启停；隔离 Chrome 的接管、输入、截图、指针同步和断开；真实 Session 的新建、分支、恢复与独立释放。日常 Chrome 已验证登录 GitHub 的只读交互、指针点击对齐、截图恢复、同源/跨源 iframe、滚动导航、跨回合常驻、原标签复用及断开清理。

标签栏接管标记已通过隔离 Chrome 的原生 favicon、导航、站点换图标、恢复及 CSP 回退验证；日常 Chrome 人工验收未做。

待验收：站点业务写操作、截图进入模型请求，以及完整 TUI 与桌面操作闭环。

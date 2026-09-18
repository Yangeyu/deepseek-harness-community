# Jev 浏览器执行层来源

- 上游：[browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)
- 固定提交：`452c1ad2dd628008f1d5608f28158d76e49e6cc0`
- 许可证：MIT；完整原文及版权声明见同目录 `LICENSE`（未修改）。
- 仅引入执行/观察层：`jev_ultrafast/browser.py` → `browser.py`，`jev_ultrafast/snapshot.js` → `snapshot.js`。
- 原始 Git blob：`browser.py` = `38e3aced572de1da2959c86b6240a6e4b13f05c4`；`snapshot.js` = `cf748375d1b824e0444429018003dc2829dfa408`；`LICENSE` = `271d8e2807d0d79aee85a231f5c9dbb007902783`。

## 本地差异及理由

`browser.py`：

1. 构造前初始化 `target`，将启动代码移入 `_start`；仅在 `Target.createTarget` RPC 与 target ID 赋值期间暂存取消信号，恢复原 handler 后重放首次信号，避免已创建但尚未记录 ID 的 tab 因取消而失联。启动中途失败（包括取消）时尝试关闭已知专属 tab；启动清理失败不再吞错。诊断不包含原始异常或页面字段。
2. `close` 在主线程临时忽略 SIGTERM/SIGINT，完成关闭后恢复，避免重复取消信号打断资源清理。只关闭自己的 target，不关闭 Chrome、其他 tab 或共享 daemon。检查 `Target.closeTarget.success`，未确认关闭时抛错，不伪报成功。
3. 删除 click/select 的局部 freshness shortcut，所有动作统一比较完整 MARKER，包含未选中 option 的 label/value。最终目标 evaluate 同步校验原 document 的 timeOrigin/URL、捕获的 guard 与当前 guard，并复用 snapshot 的 `safe`。select 赋值前再次确认目标 option 的值、可用性，以及 select 名称 + option 标签与观察到的 action.label 一致；明确的执行前变化返回 stale。
4. fill 点击后、select-all 后各检查一次原 document、批准的 node 仍是 activeElement，且安全、可编辑；点击已经发生后的变化返回 uncertain，不把后续键入发送到其他字段。空字符串 fill 在 select-all 后显式发送 Backspace，保证清空，不依赖 `Input.insertText('')` 的实现行为。

`snapshot.js`：

1. 保留原有 password/file/hidden 控件过滤；额外排除明显 credential/OTP autocomplete token，以及 name/id 中明确的 OTP、password、passcode、PIN、verification-code 标记。过滤函数保存在 Jev 私有 cache 供执行前再次检查。
2. guard 同样拒绝不安全控件；将现有 name 函数存入私有 cache，供 select 执行前复核批准标签。以上是狭窄控件过滤，不是对所有敏感页面信息的检测或脱敏保证；可见正文、标签和截图仍可能含敏感内容。

保留原有页面新鲜度、DOM 身份、可见性、命中测试、禁用/只读控件保护，以及 click/fill/select/scroll/wait 操作。没有修改已安装依赖，没有引入上游 Agent、TypeSafe/model、问题集、演示 UI 或其他文件。

## Worker 契约与能力边界

上级目录 `worker.py` 是本项目新增的 JSONL 纯执行会话：一个进程只创建一个自有 tab，接受 `open`、`observe`、`act`、`close`；所有决策和审批由宿主负责，不接受授权参数。移除原任务循环、模型决策、step/progress/history 协议。

每次成功 observe 生成新 UUID，完整 Jev page 仅私存供 act freshness。每次 act 尝试均消费观察，成功或失败后必须重新 observe；仅明确执行前失效返回 stale，可能已执行返回 uncertain，不自动重试动作。公开 actions 只含 id/kind/label/role/checked/selected/expanded，最多 250 个普通控件加 3 个 scroll/wait 辅助动作，辅助动作优先保留数量和文本预算，不输出 guard/node/value/current_value。fill 请求文本和原始异常不回显。

open 仅接受规范 HTTP(S) URL，拒绝凭证和歧义 authority，按协议、IDNA/IPv6 主机、有效端口锁定单一 origin。observe 前仅只读检查 location.origin，返回前检查快照 URL 和当前 origin；act 前检查当前 origin，再调用 Jev 原有 freshness/act guard。截图按需调用 Jev observe(screenshot=True)，截图后再次检查 freshness，编码长度上限 16 MiB；实际图片格式、尺寸和附件规则仍由宿主校验。

这不是网络隔离或导航拦截：点击可触发跨域请求、导航和页面脚本，独立 CDP 操作之间存在竞态；检查只阻止已发现的跨域页面内容输出及后续动作。创建 tab 的 RPC 如果没有返回可确认的 target ID（例如卡住后被宿主 SIGKILL），仍可能留下未知 tab，不能声称强杀后必定完成清理。快照/控件标签/截图均是非可信网页内容；过滤不能保证全面避免敏感信息或对抗恶意页面脚本。

输入每行限制 100000 字符；stdout 只输出带请求 id 的 JSON 响应，诊断写 stderr。无合法 id 的消息无法关联响应，终止并非零退出；创建或启动清理失败返回 open_failed 并非零退出；显式 close 失败返回 close_failed 并非零退出；EOF/信号也清理自有 tab，失败非零退出。SIGTERM/SIGINT 成功清理后退出码为 0（取消状态由宿主记录），只有失败才非零，便于宿主辨识清理结果。

`requirements.txt` 固定 `browser-harness==0.1.13`，真实运行入口要求 Python >=3.12。浏览器环境由用户预先配置；开发测试使用现有 Python 和 stdlib fake，不安装依赖或启动/配置 Chrome。

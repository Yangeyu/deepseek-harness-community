# TUI 长历史渲染与 Request 检索优化规划

## 1. 状态与范围

- 状态：首批 Trace 身份/性能优化与 Request 浏览搜索已接入，工作分支 `feat/tui-request-inspection`；完整检查通过，未合并或发布。性能与真实终端门槛尚未全部验收，P2 未实现。第 2 节保留实施前基线，第 8 节记录阶段状态，未勾选项仍是计划而非已交付能力。
- 基线：仓库当前 TUI 与选定的 Harness `0.1.5-rc.1` 实现；发布版本另行确定，不把能力阶段绑定到 npm 版本。
- 目标：完整历史可访问，常态滚动不随全部历史排版量增长；Trace Request 可按结构浏览、全文搜索和精确定位。
- 优先顺序：P0 渲染止痛与基线 → P1 Request 结构化导航和搜索 → P2 完整窗口化 → P3 请求对比与跨请求查询。
- 事实边界：已落地契约见 [架构文档](tui-architecture.md)，阶段状态见 [产品路线图](tui-product-roadmap.md)。本文拥有在途设计细节；交付后将稳定契约并入 architecture，删除过期设计段落，全部完成后删除本文并更新入口。

**核心原则：完整可访问 ≠ 全部驻留 ≠ 每帧全部排版。展示折叠不丢失数据，渲染缓存不替代会话存储，compaction 不替代 TUI 性能治理。**

## 2. 已核实的问题

| 路径 | 当前行为 | 问题与边界 |
|---|---|---|
| `modules/transcript/view.ts` | 稳定文本、Prompt、Diff 块有缓存；内容失效后遍历 items，拼装完整行数组 | 避免部分重复 Markdown 排版，但不是可见区渲染 |
| `presentation/shell/layout/composer-layout.ts` | 调用完整 Transcript render，构造 conversation 数组，最后 slice 可见行 | 缓存命中时仍有全历史行数组复制成本 |
| `modules/transcript/model.ts`、`view.ts` | 工具正文按原始行数裁剪；Thinking 展开后先完整 Markdown 排版，再取内部窗口 | 单条超长行、超长 Thinking 仍能造成大量处理；普通消息没有相同的正文上限 |
| `modules/trajectory/records.ts` | Step Request 按需重建，结果缓存在当前 record 闭包内 | 已有惰性，不应另造一套重建器；records 重建会更换闭包 |
| `modules/trajectory/view.ts` | Request 每次 render 都 stringify、split、全量 wrap，最后 slice | 滚动一行仍处理完整 Request，字符串中的转义换行也不利于阅读 |
| `modules/trajectory/model.ts`、`view.ts` | 左侧只绘制可见行，但每次 render 全量 measure，并求可见记录索引 | 时间戳刷新、选择移动与静态索引计算未充分分离 |
| `runtime/execution/projection/model-call.ts` | 用请求边界、header、Session Surface 重建 Request | 当前要求已加载事件从 seq 0 开始且包含请求边界；缺失时返回 unavailable |
| `runtime/session/runtime.ts` | 新事件与更早分页持续累积，不淘汰事件窗口 | 原始事件驻留仍无界；本规划前两批不解决这一点 |

`presentation/primitives/text.ts` 的 `displayUnknown()` 注释称 bounded，但实现只是完整序列化与终端文本清理，没有大小预算。不能把它当作内存或渲染保护。

当前 Request 是 Harness 规范模型请求的重建视图，不是抓取到的 provider HTTP 原始报文。界面、JSON 入口和导出说明都必须保持这个区别。

## 3. 目标与非目标

### 3.1 用户可见目标

1. 连续工作、流式输出和查看长历史时，输入与滚动保持响应。
2. Request 先展示结构目录，不要求用户穿过巨型 JSON 寻找某条消息。
3. 折叠内容仍参与搜索；命中可直接定位到内容块并显示邻近上下文。
4. 普通历史、compaction checkpoint 和保留的近期消息可区分，且不误报模型当时的输入。
5. 窄终端、分栏、详情焦点、鼠标和键盘路径具有相同的信息可达性。
6. Trace 的列表、分栏和独立详情模式都持续展示当前被查看的 Session ID，便于核对日志、恢复会话与反馈问题。

### 3.2 本轮不做

- 不删除持久日志，不直接执行 `events.slice(-N)`，不改变模型上下文或压缩策略。
- 不建立第二套 Session Surface、执行事件配对或 Request 持久化格式。
- 不把所有 Step 的完整 Request 提前重建或建立永久全文索引。
- 不优先引入 Worker、外部搜索引擎、渲染插件协议或新的用户配置项；先测量并复用现有模块。
- 不把全文正则搜索、跨会话搜索、外部编辑器集成或自动导出纳入 P1。
- 不承诺 P2 后进程总内存恒定；原始历史和语义索引仍随历史增长。

## 4. 数据正确性与生命周期契约

### 4.1 一条 Request 数据路径

继续由 `runtime/execution/projection/model-call.ts` 解释请求边界和 canonical Surface，Trajectory 只做只读展示投影。结构化视图、搜索、完整 JSON 和后续对比都消费同一份 Request，不各自扫描日志推断模型输入。

runtime 已提供 typed availability：可用、缺少历史、缺少请求记录；读取准备与历史加载失败由各自生命周期报告。view 消费该契约，不用占位字符串判断可用性。

- 缺少历史时展示“需要加载更早历史以重建此请求”，提供用户显式触发的加载操作。
- 复用现有 Session paging 和 effect scope；操作可取消、可显示已加载页数，不因切换到 Request 就隐式拉取整个会话。
- 当前重建需要从 seq 0 开始，这可能意味着加载大量历史，必须在操作前说明；加载失败保留当前位置和重试入口。
- 不得把部分消息冒充完整请求，也不得用当前请求替代历史请求。
- 所需历史到齐后重新解析并失效旧的 unavailable 结果；不能永久缓存失败占位文本。

### 4.2 身份、修订与缓存

缓存身份包含 Session epoch、Step 语义 key、请求边界及其输入修订；宽度、主题修订和展示模式只影响对应排版缓存。

“输入修订”由模型请求读取路径提供，覆盖 header、历史补载与结构性替换；不只用 Step key，也不因尾部追加了与旧请求无关的事件就重建旧请求。修订与 snapshot 契约对齐，不通过每帧全文 hash 获取。

- 首批仅保留当前检查 Request 的重建结果与排版，避免按 Step 无限制存缓存。
- 后续多项缓存同时限制条目数和估算文本容量；超大对象不因“只有一项”就绕过预算。准确预算由 P0 基线确定，发布前冻结为内部常量。
- 普通滚动不改变文档修订；宽度变化失效折行，不失效内容搜索。
- 搜索、增量排版与历史加载属于 Session/Surface 生命周期；关闭 Surface、切换 Request 或 epoch 后，旧异步结果不可发布。

### 4.3 完整性与来源

消息序号用于显示，内部定位使用 Request 身份、消息稳定身份及内容块路径。事件来源通过 canonical 投影暴露的映射获得；没有可靠映射时不猜 seq、不把重复文本当作同一条消息。

compaction checkpoint 按正式来源标记识别，不只靠正文标签字符串。它在 Request 中是有效摘要消息；被遮蔽的旧消息只在历史查看路径出现，不混回该 Request。非文本块展示类型与已有元数据，不自动读取图片字节或文件正文。

## 5. Request 阅读与查询设计

### 5.0 Trace 会话身份栏

Trace 顶部固定身份栏展示 `Session <sessionId>`；这是整个 Trace 的身份，不只属于 Request Tab。列表、分栏、独立详情以及其他 Tab 都必须可见，不随正文滚动离屏。

- ID 取自当前绑定的 Session snapshot，表示正在查看的会话，不从选中事件、父会话或请求文本推断。
- 当前没有可用 ID 时显示“Session unavailable”，不显示旧会话 ID 或虚构占位 ID。
- 宽度足够时显示完整 ID；窄屏可以保留首尾并显式省略，按 `s` 或点击身份栏打开受控只读详情，以换行方式查看完整 ID。`s` 在三种 Trace 布局均可用，搜索文本输入激活时仅作为输入字符；Esc 关闭身份详情并恢复此前焦点，不依赖鼠标悬停。
- 完整 ID 是核对值，不能把缩略值用于日志寻址、恢复命令或未来复制动作。首批要求完整值可查看；若复用现有 clipboard 能力提供复制，必须由用户显式触发并复制完整值。
- Session 切换时，身份栏、记录列表和详情在同一 TerminalSnapshot 提交中更新；异步历史加载不得恢复旧身份。
- 身份栏计入可用高度，必须与现有总览标题合并，避免增加重复标题挤占正文。若未来支持子会话检查，这里展示被查看子会话 ID，父子关系另行标明。

### 5.1 默认结构化视图

复用现有 Request Tab，在内部提供结构化查看与“完整 JSON”切换，不增加一组竞争性的顶级 Tab。Response、Input、Schema 复用正文排版能力，但不在 P1 同时扩展全部专用浏览功能。

目录先列 Config、Tools，再严格保持实际 messages 顺序；System 不从历史中抽离重排。消息标题使用序号与真实来源含义，折叠时追加短摘要，展开后不重复摘要；实际 role/source 保留在 Metadata 与 JSON 中。

- Config 默认折叠，展开直接读取字段。Tools 默认折叠，展开只列工具名称与短摘要，保持 canonical 工具顺序，不遍历 schema。
- 单个工具默认折叠；展开后提供 Description、Parameters schema、Other attributes 三类披露项（有对应字段时显示），各自默认折叠，按需展开完整值。长描述使用连续正文窗口，工具名称直接关联原始字段以支持标题内定位高亮。
- 标题与 Trace 共用 `message-label`：以正式 source.kind/form 分类；notice 优先使用生产者声明的 summary，否则取有界内容摘录。未知或未声明 form 的来源保留原始生产者名，不根据正文标签或插件名称猜身份。
- 首次进入保留完整目录，定位并展开最新的人类输入；无可靠人类来源时回退到最后一条消息。同 Step 切 Tab 保留阅读位置。
- 展开消息直接原地阅读正文，多个内容块保持原序，思考/工具调用有简短标签，工具结果递归显示实际内容。标题/正文节点与节点内视觉行游标共同维护阅读位置。
- Metadata 默认折叠，保留所有未作为正文展示的字段，包括真实 role/source、文本块 type 和工具调用 name。展开后使用相对字段名与完整可滚动值；所有原字段值均参与搜索，命中可展开 Metadata 并在对应值中高亮。
- 正文按窗口连续访问，不截断可达内容；完整行数在读到末尾前未知。`g` 跳转菜单支持最新输入、checkpoint 与原消息序号。

`v` 显式进入同一规范 Request 的完整 JSON，首次序列化与终端安全清理仍同步；此入口使用文本窗口和未知/已知行数提示，不为结构目录预先序列化全部请求。

### 5.2 当前 Request 全文搜索

提供字面文本搜索，默认大小写不敏感，`c` 切换精确大小写。查询先转义正则元字符，再使用 `giu`/`gu` 扫描原文，返回原始 UTF-16 偏移；不对全文小写副本的索引直接套用原文。

- `/` 在当前视图底部显示输入，目录或显式 JSON 正文继续可见。Enter 确认后选中第一处命中，`n/N` 循环选中下一处/上一处。
- 结构搜索覆盖整个当前 Request 原始字段值，包括 Config、工具名称/描述/schema/其他属性、消息正文和 Metadata、工具参数/结果及已有附件元数据，不受折叠状态影响，不抓取附件内容。显式 JSON 模式搜索完整序列化文本，界面标明当前范围。
- 每次选中命中时展开所属消息/Metadata 或 Tools/工具/属性组，在同一目录中定位并高亮；工具名称在工具标题上高亮。JSON 命中仍在 JSON 内定位，不建立额外阅读层。
- 原始字段偏移由 `TextDocument.locate()` 转为视觉行，`read()` 只绘制当前选中范围与可见行的交集；定位前缀与安全文本转换成本见第 8 节。当前 resize 保留节点/视觉行并夹到有效范围，尚未实现精确原文锚点。
- 扫描按 16 Ki UTF-16 文本块让出事件循环，可取消并发布字段/命中进度，结束后显示准确总数。空结果与历史不可用保持不同状态；查询超过 4096 UTF-16 单元明确报错，不静默截短。
- 索引只保留有命中字段的引用与计数。`match(ordinal, signal)` 跳过已计数字段，可取消地重扫目标字段，只返回一个命中；不存在随命中数增长的位置数组，普通滚动不重做查询扫描。

### 5.3 输入与焦点

所有按键经 shell 固定 keymap 解析，不在 Trajectory 内解码原始终端字节。

| 场景 | 当前行为 |
|---|---|
| Ledger 焦点 | 保留 j/k 选择记录、J/K 滚动右侧详情、h/l 折叠层级 |
| Detail 焦点 | 目录中 ↑/↓、j/k 选择标题、工具项或披露项，选中仍可见时不滚动，离屏才跟随；J/K、滚轮只滚内容。显式 JSON 中上下键滚动。`[`/`]` 跳目录标题，Enter/点击原地切折叠；Tab/左右仍切外层详情页 |
| Trace 身份查看 | `s` 或点击身份栏打开完整 Session ID；关闭后恢复原布局和焦点 |
| 当前 Request 内 `/` | `surface.search` 在底部打开 Input，保留当前正文与搜索范围提示 |
| 搜索输入中 | 字母作为查询文本，包括 j/k/n/N/c/v；不穿透到目录或 composer |
| 查询确认后 | n/N 原地选择下一处/上一处并循环，c 切换大小写，v 切换结构/JSON 并重查当前查询 |
| Esc | 先取消输入或清除搜索与高亮，保持正文锚点；再从 JSON 回目录或遵循外层 Detail → Ledger → Chat 返回路径 |
| 鼠标 | 只作用于所在 pane；标题/披露项点击与键盘使用同一展开路径，滚轮只滚内容 |

选中索引与视口起点分别维护；展开/收起保留所在屏幕行，不把目标强制置顶。只有可见标题与披露项具有折叠焦点，正文不参与选择与点击命中表。手动滚动使标题离屏时清除焦点，避免 Enter 操作不可见项目。跨越未读取的超长正文跳选标题时，不为底部对齐而扫描整段，可将目标放在靠近顶部的位置。gesture、固定 keymap 与语义 action 统一接入上述导航，文本输入复用现有 Surface 能力。

### 5.4 JSON 与导出边界

P1 必须能查看完整规范 JSON；导出仅在现有文件/用户交互能力可复用且权限、脱敏策略明确后开放，不作为搜索交付的前置条件。

Request 可能包含项目代码和敏感文本：不自动写临时文件、不自动复制到剪贴板、不上传搜索服务。未来导出必须由用户显式发起，说明范围、路径和敏感性；若脱敏，清楚标记“不再是字节级原始内容”。

## 6. 渲染方案

### 6.1 P0：消除重复工作，但不宣称窗口化完成

1. 将 Request 获取、序列化、终端安全清理、折行与 viewport slice 分层；同一输入/宽度的滚动复用准备结果。
2. 首批缓存限于当前文档，设置超大内容路径：超预算时显示可取消的准备状态并按块读取，不缓存整份折行结果；内部预算在基线后确定。
3. 将 Trace 静态计时、父子索引、折叠后的可见索引与时钟刷新分开。已完成记录的 duration 等静态量复用；活动节点及受影响的 share/bottleneck 仍正确更新，不能只冻结整张 metrics 表。
4. 单独记录初次重建、初次序列化、初次排版和重复滚动的成本，避免仅展示热缓存收益。

### 6.2 P2：块级窗口化与超长正文

Transcript 从“返回完整 `string[]`”切换为“语义块文档＋窗口读取”的窄契约。Shell 继续拥有主视口、composer 可用高度和焦点，Transcript 拥有内容块、disclosure 和块内排版；不让两者分别维护竞争性的绝对滚动位置。

- 块高度索引定位可见区域，已知高度更新与位置查找目标为 O(log B)，常态绘制成本与可见块/行数相关；B 为已加载块数。
- 仅排版可见区域及少量缓冲区，行缓存有界。保留轻量块目录/高度信息随 B 增长是明确权衡，不称作总内存 O(1)。
- 未测量高度使用估计，测量修正后以稳定锚点补偿；高度尚不完整时不展示伪精确全篇行数。
- 锚点使用消息 key、内容块路径和块内位置。prepend、展开/收起、宽度变化后优先保留该内容；内容被替换或移除时定位最近有效前驱并明确状态。
- 用户在尾部时继续跟随；上翻后新消息不拉回底部。Thinking 内部滚动与主视口滚动的所有权不变。
- resize 优先重排可见块，其他高度逐步更新；禁止为了重建精确总高度同步排版全部历史。
- 文本与 JSON 从逻辑行/文本块建立稀疏偏移索引；单条超长行也能分段折行，不在访问一页时先创建全行折行数组。
- Markdown 必须在完整语法语义下识别块；可复用完整解析后的块结构，但绘制窗口化。代码围栏、表格、跨块引用、流式未闭合结构是原型验收重点，不能按固定行数粗切。
- 完整解析/首次索引仍可能 O(S)，S 为正文大小；超大输入准备必须可让出、可取消。若 pi-tui 现有 Markdown API 不能支持分块绘制，先完成最小原型并评估适配方案，不悄悄换用破坏语义的简化渲染器。

Trace 正文与 Transcript 仅共享已经证实通用的“文本偏移、折行缓存、窗口读取”原语，不建立包含 Session 或 Request 语义的通用渲染框架。

### 6.3 Markdown 上游公开接口缺口

遵守项目集成约定：不修改 `node_modules`、不使用依赖 patch、不通过类型断言调用私有方法。公开契约不足时提出上游改进需求，不能为了通过 P2 门槛静默 fork 或另造 renderer。

依赖检查后，拟向上游提出的最小能力是：

1. 暴露与 `Markdown` 本身配置一致的只读文档解析结果，保留全局引用、源偏移、相邻块间距及流式未闭合结构的处理。
2. 提供基于该文档的块/行窗口排版入口；表格列宽等全局测量摘要与可见行绘制分离，且不要求先创建全篇 `string[]`。
3. 明确内容修订和宽度修订的失效范围，以及巨大单块准备的取消/让出契约；把异步外壳包在同步全量 lexer 上不满足这一要求。

在上游能力可用之前，可先验证完整独立消息的窗口读取、Shell 锚点和纯文本长正文，但这些只能记为 P2 部分进展。巨型 Markdown 单块及跨块语义等价验收保持未完成；P0/P1 不依赖该接口，不必停等。

## 7. 模块影响面与必须删除的旧路径

实现跨越以下所有权边界，按阶段交付而非一次大重构；原工作区的其他未提交改动不带入此分支：

| 所有者 | 计划职责 | 清理要求 |
|---|---|---|
| `modules/trajectory` | 文档投影、目录/查询状态、当前请求缓存、详情窗口、静态指标 | 删除 render 内完整 stringify/wrap；合并 record 闭包缓存与新缓存，不能双重长期保留 |
| `runtime/execution/projection` | canonical Request 与可用性/来源/修订信息 | 复用 Surface 重建，删除 consumer 自行猜边界的路径（如实现中出现） |
| `runtime/session`、feature effect scope | 复用历史加载与取消 | 不增加第二个分页循环、事件 store 或后台预加载全部历史的任务 |
| `modules/transcript` | 稳定块文档、增量尾部、disclosure、窗口排版 | 切换后删除完整 renderedDocument 行数组及失效的全量拼装分支 |
| `presentation/shell/layout` | 可用视口、锚点协调、屏幕坐标转换 | 删除完整 conversation 拷贝；命中测试不再依赖全部历史行的 hit map |
| `presentation/primitives`、shell input | 有实际复用需求的正文原语、搜索输入与语义动作 | 修正 `displayUnknown` 的误导性 bounded 注释；不全局硬截断该函数影响其他功能 |
| `application` / feature process | 新窄接口静态接线与生命周期 | 不增加动态渲染插件或永久新 pane |

P2 切换可以按能力分批，但每个交付点只有一条正式渲染路径；旧实现只可在测试中作为短期等价性参照，验收后删除无价值的重复用例。

## 8. 阶段计划与交付门槛

### P0 — 基线与 Request 渲染止痛

- [x] Trace 固定身份栏展示当前 Session ID，覆盖三种布局及窄屏完整值入口；`s`/点击打开、Esc 返回、焦点恢复与 keymap 冲突测试已通过，真实终端验收仍列为阶段门槛。
- [ ] 固定长历史/大请求数据集，分离冷启动、热滚动、resize 与流式尾部基线。
- [ ] 确定当前文档缓存预算与超预算行为；消除滚动时重复序列化和全量折行。
- [x] 收敛 Trace 静态指标/可见索引计算，活动 duration、父级 share、sibling/global bottleneck 更新有功能测试覆盖。
- [x] 增加 canonical Request typed availability、消息来源映射和稳定输入修订；删除旧 `modelRequest` 读取桥，补载/重放/epoch 失效有功能测试覆盖。

当前实现：只保留当前 Request 的 canonical 读取结果与有效正文文档，JSON 文本显式生成后复用。`TextDocument` 使用每 128 个视觉行一个 checkpoint、32 行预读与 64 Ki 字符缓冲预算（当前屏幕必需行另计）；完整行数在到达末尾前未知。`locate` 与窗口读取共享稀疏索引，高亮只绘制相交可见行，原文到净化文本的转换仅缓存两个范围边界，不建立全源逐字符映射。首次净化、新边界的前缀转换及远距离冷定位仍是同步线性工作；原始/净化字符串和稀疏索引随正文增长，首次 Surface 重放和 JSON 序列化仍同步。因此尚未满足超大请求的全部预算与取消目标，P0 保持未完成。Trace 计时返回值是同步 render 消费的 live read-model，下一次 measure 会更新它，不能当作历史帧快照持有。

完整 `pnpm check` 已通过；固定 ASCII 数据的历史组件性能对照见第 9.4 节。其他基线维度与真实终端验收尚未完成，组件测试通过不等于性能门槛通过。

退出门槛：三种 Trace 布局均展示正确 Session ID，窄屏完整值可达且切换无陈旧身份；热滚动不再重建/序列化完整 Request；无关尾部追加不失效已固定请求；补载历史能解除 unavailable；记录冷处理仍存在的成本。P0 是独立性能改进，不宣称已解决长会话增长。

### P1 — 结构化阅读与当前 Request 搜索

- [x] 结构目录、自然换行正文、完整 JSON 切换；缺历史时显式逐页 Enter 加载，Esc 停止本视图等待，在途共享页仍归 Session 所有。
- [x] 底部原地字面搜索、全字段范围提示、n/N 自动展开/定位/高亮；显式 JSON 同样原地搜索，Esc 清除查询后返回。
- [x] 按规范顺序展示 Tools 名称/摘要，单个工具及其描述/schema/其他属性分别披露；最新输入/checkpoint/原消息序号跳转。
- [ ] 窄屏、分栏、搜索文本输入焦点和 Session 切换验收。

P1 当前所有权与边界（勾选表示实现与功能测试通过，不等于全部性能/终端验收通过）：

- `RequestDocument` 只消费 canonical Request 与对齐 provenance：保留消息/工具顺序、System 原位置和原始参数字符串；惰性提供字段路径/原文引用。Checkpoint 使用 Harness 的 `isCompactCheckpointSource` 公开谓词，不复制上游判定。Tools 名称与属性组关联真实字段，Metadata 保留全部未在正文显示的字段。
- `searchRequest` 保留字段计数，按 ordinal 可取消地重扫并返回单个命中；`RequestInspection` 用文档/query/selection 子 scope 管理当前准备、搜索与选择任务。同修订复用，切换 Request/epoch 或关闭 scope 后旧任务不发布。先发布 preparing 再让出事件循环，不代表终端已经绘制或同步 Surface 重放可抢占。
- `RequestBrowser` 只维护当前目录与显式 JSON 窗口；底部搜索输入保留正文，命中在同一视图展开/定位/高亮。消息正文、元数据与工具属性共用 `TextDocument` 窗口读取，切 Tab 暂停 transient 任务并保留有效锚点，切 Step/epoch/Session 释放。
- 功能测试覆盖真实来源、连续阅读、Tools 惰性披露、正文/工具名称/schema/Metadata 的原地 ANSI 高亮、Unicode、JSON、键位与生命周期。只为主流程与必要性能契约保留测试；删除功能即删除对应测试，不追加已移除 UI 的“不存在”或兼容性断言。
- 已知债务：显式 JSON 序列化、正文首次净化与新命中边界的前缀转换仍同步，展开大量元数据/工具属性也有同步工作；反向进入此前未读正文尾部、深 ordinal 选择与冷定位仍需扫描。resize 尚非精确原文锚点，严格全源字节预算、Transcript 消息级窗口化、真实终端和完整性能矩阵仍未完成；`view.ts`/`request-browser.ts` 仍偏大。

退出门槛：折叠内容可搜可达；巨大正文可以按页访问；不完整历史不会显示伪完整请求；高命中密度不会产生无界结果缓存。P0+P1 是首批推荐产品交付。

### P2 — Transcript 与正文窗口化

- [ ] 完成 pi-tui Markdown 分块原型及 API 适配决策。
- [ ] 落地块高度索引、视口读取、稳定锚点和有界排版缓存。
- [ ] 消除 Transcript/layout 的完整行数组路径；单条长正文也进入窗口化路径。
- [ ] 验证流式尾部、Thinking 内滚动、Diff/Activity 展开、历史 prepend 与 resize。

退出门槛：常态滚动和尾部更新不遍历/排版全历史；宽度变化不同步重排所有历史；功能输出保持语义等价。若事件投影在新 durable 事件时仍全量重建，需单独记录成本，不把 render 优化冒充整条更新链常数复杂度。

### P3 — 请求变化对比与跨请求检索（后续规划）

- 先比较相邻的可用 Request：新增/移除/替换消息、Config 和工具 schema 变化，保留“完整请求”切换。
- compaction、系统提示改写、模型切换按实际结构比较；不以数组长度差冒充增量，也不做默认整份 JSON 文本 diff。
- 跨 Request 查询分批重建、可取消、使用有界缓存；相同历史命中聚合并列出出现的 Step，避免重复内容淹没结果。
- 明确当前已加载范围与整个 Session 的差别，不隐式拉取所有历史。全 Session 查询与 Host 查询能力对齐后另行细化。

P3 不阻塞前两批交付，完整事件窗口淘汰/checkpoint 契约另立工作项，不混入该阶段。

## 9. 验证与性能预算

### 9.1 固定基线矩阵

以下为拟议测试规模，不是已测结果。使用脱敏或生成数据，记录硬件、Node/pi-tui 版本、窗口尺寸、冷/热状态及采样方法。

| 维度 | 样本 |
|---|---|
| 历史规模 | 1k / 10k / 50k 语义块，同时记录 durable 事件数和正文总字节数 |
| Request 大小 | 100 KiB / 1 MiB / 10 MiB；覆盖大量短消息和单条巨大消息 |
| 内容形态 | CJK、emoji、ANSI/控制字符、超长单行、代码块、表格、工具 schema、compaction、重复文本 |
| 视口 | 80×24、120×40、200×60，反复窄宽切换 |
| 操作 | 首次打开、连续滚动、底部搜索、n/N 原地定位、Tools/Metadata 展开、prepend、流式尾部、切换 Step/Session、关闭后重开 |

分别测量请求重建、序列化、索引/搜索、折行、视口组装、输入到帧提交延迟、事件循环最长阻塞、分配/GC、缓存估算容量与进程内存。不能仅测组件 render 忽略 runtime 投影与 shell 帧提交。

### 9.2 拟议验收目标

- 在固定基准机上，P2 热滚动/热命中跳转输入到帧提交 p95 目标 ≤ 50 ms；历史规模扩大 10 倍、相同可见内容时，热滚动 p95 增长目标 ≤ 20%。P0 先测可达性，任何调整需记录数据与理由，不能验收时静默放宽。
- 大请求冷重建、索引和搜索允许随输入规模增长，但在 100 ms 内展示准备/扫描状态，并能接受取消；目标为不出现超过 50 ms 的单次主线程工作片段。同步 Host Surface 重放若不能达标，需显式列为后续 runtime 适配阻塞项，不能以缓存掩盖。
- 固定事件集上反复浏览许多 Step 后，排版/查询缓存保持预算内且不会随浏览次数持续增长；切换 Session 或关闭 Surface 后清理对应缓存与任务。
- 记录 CPU 时间和调用计数，证明热滚动没有完整 Request 序列化和全历史排版。CI 优先稳定的功能语义及复杂度断言，绝对耗时在固定基准环境验收，避免脆弱的单元测试时间阈值。

### 9.3 功能语义测试

- Trace 列表、分栏、独立详情和不同 Tab 始终标明被查看的 Session ID；窄屏完整值可访问，缺失 ID 与 Session 切换时不显示陈旧身份。
- 同一请求在结构化视图、搜索和完整 JSON 中内容一致；重复文本不能错误合并，compaction 后可见范围与 canonical Request 一致。
- 缺少 seq 0 历史时明确不可用；显式补载后正确重建；失败/取消/epoch 退休不覆盖当前文档。
- 隐藏正文、Config、工具名称/描述/schema、Metadata 与 Unicode 文本可原地命中；n/N 循环、高亮、Esc 清除与继续阅读形成完整流程，扫描中和无结果提示正确。
- prepend、展开、stream append 和 resize 保持阅读锚点；尾部跟随与用户上翻互不抢占。
- j/k、J/K、Tab 和 Esc 原有语义不回归；查询输入中的字母不触发导航；静态 Transcript glyph 约定不因优化引入 spinner。
- 同一内容经窗口拼合后与基准展示语义一致，覆盖 Markdown 跨块依赖和超长行；测试不绑定缓存 Map 个数或私有字段。

按功能维护现有 `tests/modules/trajectory`、`tests/modules/transcript`、`tests/runtime/execution` 与 `tests/presentation/shell`；测试服务主流程、输入输出与必要性能契约，不记录改动流水账。删除被替代逻辑的测试，不以负向断言纪念已移除功能。`pnpm check` 已通过，真实终端及 P2 等未实现阶段仍须各自完成验收。

### 9.4 首轮 P0 组件基准（阶段未验收）

环境：Apple M4 Pro / 14 逻辑核 / 48 GiB，macOS arm64，Node `v25.2.1`，pi-tui `0.84.2`、Session `0.1.5-rc.1`。生成数据版本 `rendering-generated-v1-ascii-user96-request-ascii-x`；视口 120×40；每场景预热 5 次、测量 30 次，顺序执行、不强制 GC。基线与当前各完成 39 个场景，总运行时间分别约 353.54 秒、66.83 秒。两者基于 `2653b57`，均有工作区改动，精确源码 hash 在原始输出 metadata 中，不能只用相同 HEAD 解释为同一源码。

下表是 **wall-clock p95 / 毫秒**；cold 指新组件＋首次 render，hot 指保留组件的一次导航＋render。不是进程冷启动、输入到 TerminalSnapshot/实际终端绘制的端到端指标；runtime snapshot 投影在样本计时之外。

| 场景 | 基线 | 当前 |
|---|---:|---:|
| Trace 1k 历史 cold | 2.619 | 2.658 |
| Trace 10k 历史 cold | 11.308 | 9.445 |
| Trace 50k 历史 cold | 62.826 | 63.362 |
| Trace 1k 历史 hot scroll | 2.293 | 2.477 |
| Trace 10k 历史 hot scroll | 5.309 | 1.098 |
| Trace 50k 历史 hot scroll | 26.435 | 1.021 |
| Request 10 MiB 单条 cold | 2182.000 | 27.302 |
| Request 10 MiB 单条 hot scroll | 2163.296 | 0.142 |
| Request 10 MiB 多短消息 cold | 1554.836 | 43.527 |
| Request 10 MiB 多短消息 hot scroll | 1559.797 | 0.984 |
| Transcript 50k 历史 cold（全文 render） | 1329.850 | 1381.913 |

结论：Request 热滚动和大历史 Trace 列表已明显减少重复处理；小历史没有显示一致收益，Trace 冷建仍 O(n)，Transcript 未实施 P2，不能宣称其已变快。未验证混合 Markdown、输入到帧提交、冷任务取消、内存上限、prepend/resize 性能与真实终端，因此不据此勾选全部性能门槛。

复现（从当前 worktree 根目录运行，`BASELINE_ROOT` 指向要对照的只读 checkout）：

```sh
DSH_TUI_BENCH=1 DSH_TUI_BENCH_ROOT="$BASELINE_ROOT" pnpm exec vitest run packages/tui/tests/performance/rendering.spec.ts --no-cache --maxWorkers=1
DSH_TUI_BENCH=1 pnpm exec vitest run packages/tui/tests/performance/rendering.spec.ts --no-cache --maxWorkers=1
```

默认测试不执行基准。入口 stdout 输出 metadata、逐样本 wall/CPU 时间与 checksum；原始本机工具记录为 `session-ea23ea912197/b495dec05943-job_output.txt`（基线）和 `session-ea23ea912197/a7b3922fa6fc-job_output.txt`（当前），位于本次会话的 `dsh-spill-UFEQ5Q` 临时目录，非仓库永久产物。基线运行时旧 benchmark 文案误称 serialize 排除 sanitizing；实际测量调用 `displayUnknown()`，包含 JSON 序列化与终端文本清理，当前入口已勘误，测量操作没有变化。

P1 接线后的基准入口使用 `measurementVersion=request-ready-explicit-format-v2`：cold 等待组件 ready 后显式进入 JSON，hot 不测 preparing 占位，清理在计时外；旧实现仍只 render 一次。新增格式参数 `DSH_TUI_BENCH_REQUEST_FORMAT=json|structured`，旧实现对 structured 明确报告 unsupported。本批只做 80×24、100 KiB/10 MiB 单条、预热 1 次/采样 3 次的连通性 smoke，未重跑完整矩阵；上表仅为 P0 版本历史证据，不冒充最新 P1 成绩。

## 10. 开放项与已接受的技术债

1. **完整历史加载成本**：现有 Request 重建要求从 seq 0 开始。P1 显式加载是可用性方案，不是大规模历史的最终读取协议；Host 按边界查询/checkpoint 能力需另行评估。
2. **首次解析仍可能很重**：缓存和目录只减少重复工作。Surface 重放、Markdown 解析及巨型 JSON 序列化的同步边界必须通过原型与压测确认。
3. **事件驻留与投影仍增长**：本规划优化渲染/浏览成本，不承诺释放全部旧事件或让每次 durable 更新都成为增量；后续需要 correctness-preserving Host 基线契约。
4. **来源映射有事实边界**：当前 canonical 读取契约已提供修订与对齐的消息 provenance；只有可靠映射才显示事件 seq，不能推断每个嵌套内容块都具有独立事件身份。
5. **全源缓存预算尚未验收**：现有行缓冲和两个范围边界缓存限制重复排版，不限制原始/净化字符串与稀疏索引总量。严格预算和超预算取消路径仍须 P0 实测，不通过新增大量配置把设计责任推给用户。
6. **pi-tui Markdown 适配是 P2 的原型门槛**：依赖检查确认 `pi-tui@0.84.2` 公开导出通用 `Marked`，但 `Markdown` 的公开 API 只有整串 render，内部 parser 的 LaTeX/删除线/partial fence 配置及 token/table/list 排版桥不是公开接口。直接按 token.raw 重建组件会丢全局引用、间距与表格列宽语义；外包 Promise 也不能让同步 lexer 可取消。消息级窗口化不能冒充超长单块已达标。P2 先评估公开窄 API 适配原型；若需要更换/扩展依赖或改变排版语义，另行量化并与用户对齐，不调用私有方法或静默自建渲染器。
7. **导出与跨请求搜索延后**：前者涉及敏感信息/文件生命周期，后者存在重复历史重建放大；不能为“功能齐全”提前加入默认行为。

每阶段交付须报告：改善了哪段链路、数据规模与测量结果、仍随历史增长的部分、删除了哪些旧路径以及尚未完成的验收。未达退出门槛就保持该阶段未完成。

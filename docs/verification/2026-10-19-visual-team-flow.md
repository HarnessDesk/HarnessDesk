# Visual Team 与统一 Work — 使用与验证记录

本轮把任务、Flow 配置、启动后的工作页和检查详情接成一条实际可操作的路径。流程文件、预检 token、运行记录和操作权限继续由现有 host 管理；画布继续使用 React Flow。

## 使用心得

- New Team 先写任务，再选择 Flow；每个并行 Seat 的 runtime、model、effort 和指令在相应节点配置。候选不满足条件时保留具体原因和恢复入口。目录示例支持播放、暂停、单步、返工和重置，在人工节点等待，不替人回答，也不执行模型或检查。
- 启动后落在 Work：上方是记录驱动的 Flow，下面是紧凑 Recent activity。近期活动只显示已发生的步骤、状态、必要进度和时间；Full record 才展开完整历史、重复轮次与未到达步骤。Tasks 和 Chat 仍可直接进入。
- Work 的 Open task 和人工 Flow 节点定位到确切的人工任务，在既有 Details 中回答，不必先到整个任务看板再寻找菜单。历史选择保留自己的 Run 身份；未到达步骤不生成答案或结果。
- Run、Seat、Conversation 和所选步骤的详情采用同一套紧凑行与事实栏。默认只留有用的状态、来源、进度、成果与成本；长 brief、冻结 base、revision、预算及诊断信息有明确详情入口。缺失成本明确写 Not recorded，部分用量保留 Partial，不解释成免费；不再堆一段缺失字段清单。
- Chat 的定向消息保留发送者、接收者和消息身份，相邻同源消息可成组阅读；held、refused 与可释放请求仍能辨认。长中性记录折成 Recorded note；已标记的 Agent brief 保留原折叠。长 warning 保留警告身份、可完整显示的简短摘要与 Show details，完整正文仍可读；短警告、错误、人工消息和正常回复保持可见。

## 实际走查证据

在隔离假代理 rig 中，从实际 New Team 的 Use Codex 恢复候选后启动了双 Agent Team。host 实际保留两个 Seat、两个任务卡，页面进入 Work，并显示两个待处理审批。这是实际产品启动路径的证据，代理响应仍来自脚本夹具。

审批走查使用同一条请求的来源信息与操作路径。两次 Deny 后，Chat 的待处理数从 2 到 1 再清空，原 composer 草稿仍保留；Chat 中审批、输入区和底部没有互相遮挡。当前走查帧中三个审批选项共用同一行，底部输入区完整留在窗口内。

从 Team 审批的 Open conversation 进入来源会话后，无须回答即可回到 Chat，待处理请求保持原样。共享浮动栏现在锚定主内容区域，实际 Details 的关闭按钮可点击。人工步骤从 Work 的 Open task 进入确切答案表单，Done 后实际记录变为 1 of 1 answered，Run 进入 Settled。

四类共享配置菜单已在实机逐个打开：每行使用真实图标、稳定的 Implementer 1 / 2 和一个当前值；模型子菜单保留原有选择。完整身份和次级权限信息仍在悬停与子菜单内。

另用合成预览事件检查 Agent → Agent 的定向连续消息、分组、held 和 refused 状态，在浅色、深色和 760px 窄窗口实际通过 CUA 阅读与操作。它验证真实 Channel 组件的展示和入口，不证明两个真实模型已经互相协作或完成任务。

已检查的本地截图位于 `output/orca-workflow-audit/`：

- `visual-unified-work-final-light.png`、`visual-unified-work-final-dark.png`：新 Team 的 Work、Flow、近期活动和紧凑事实栏。
- `visual-team-menu-final-light.png`、`visual-team-permissions-final-light.png`：稳定身份与单个配置值。
- `visual-team-config-final-light.png`、`visual-flow-gallery-final-light.png`：任务、角色图与纯图标目录。
- `visual-record-details-final-light.png`：浮动栏旁仍可使用的记录详情。
- `visual-chat-approval-final-light.png`：实际假代理 Team 的两个待审批项与保留的草稿。
- `visual-agent-chat-final-light.png`、`visual-agent-chat-final-dark.png`、`visual-agent-chat-narrow-dark.png`：合成 Agent 消息在两种主题与窄窗口中的状态。

公开帧只允许来自隔离假代理 rig 或 preview，发布前仍需逐张检查账号与身份。本轮已逐张检查并发布到不可变的截图提交：[de7e964a5166](https://github.com/HarnessDesk/HarnessDesk/tree/de7e964a516600a5026f396f9935294454c79027/pr-1813/visual-team-flow)。

## 已执行验证与边界

- 最新 development 合并与最后详情修复后的完整 UI Vitest：677 个文件、8,573 项通过，包含复审后补充的滚动中审批提示与记录展开回归。
- `pnpm check:push --base origin/development --fast` 已执行，退出码 0；它明确跳过的 Node 和 browser 套件不计为通过证据。
- 提交前检查中的脚本测试：440 项通过、1 项明确跳过；Agent 消息相关 host 过滤测试独立执行，21 项通过。UI 类型检查、设计文档、严格设计审计和目录覆盖检查通过；现有布局债务上限从 2,043 降为 2,040，页面度量从 18 降为 17，没有增加豁免。
- 本轮浏览器证据来自实际 CUA 交互、画面检查与 DOM 测量。没有把它写成完整 Playwright/browser 套件或 native 验证，也没有把合成消息写成真实模型协作证明。
- 已迁移统一 Team 导航相关的浏览器测试契约；语法与静态检查独立执行。未运行完整浏览器套件，不能把静态检查或 CUA 走查当成全套 E2E 通过。CI 和 native 全量验证仍待执行。

## 复审后的修复

本地额外复审在已发布的 ca24d7ae4 上指出两项交互问题：读旧消息时新审批没有就近返回入口；选中旧轮次后手动收起 Full record 会被模型刷新覆盖。分别补了独立回归，修复为固定的 Approval waiting 返回入口和按 Run/选择身份处理展开。既有审批选项、草稿、受众和显式历史定位保持原行为。长 Chat 的返回提示已在 CUA 中观察到；返回到底部、同请求刷新、下一请求、外部解决和草稿保留由回归测试覆盖。

CI Gates 的首次失败来自文档测试仍寻找已移除的 Overview 标题。同步更新设计说明与该测试，保留其对默认页面和无 Run 场景的要求，并在缺少章节时明确失败。目标测试先红后绿，4 项通过。上述修复之后重新执行完整 UI 套件、构建及提交前门禁。

## 完整队列复核与 development 同步

三组子代理逐项复核 Flow、Conversation、Work 的全部截图反馈，并做独立的只读集成复审。补充了十个实际内置 YAML 的完整示例路径测试：计时推进、人工暂停、显式继续和结束状态都使用发布的策略解析结果。

最后收紧了 Inspector 中工作目录、比较 revision、分支与冻结 base 的展示，使用现有 MiddleTruncate，完整值仍可访问。Conversation 的可选 Background tasks 卡片仅在成功读取为空或明确不支持时省略；读取中、失败重试与已有任务保持可见。可选 Trajectory 只省略已加载且确无记录的情况，Activity 的 Events 入口与所有有效、失败、进行中或未计时的步骤保持原样。

development 的 cd33160d2 已合入；随后新增、仅调整浏览器分片耗时的 24aa8d7fd 也已合入。当前 app 已重新构建并实际刷新，复查了 Work、来源会话详情与目录播放到人工暂停、显式结束的路径。新增的两张公开帧已逐张检查，发布于 [8d0c408c1b75](https://github.com/HarnessDesk/HarnessDesk/tree/8d0c408c1b755542647e1b2948e7c349c1b2815d/pr-1813/visual-team-flow)：`visual-conversation-record-refreshed-light.png` 和 `visual-flow-gallery-refreshed-light.png`。

CI 上原有三个真实图形配置用例曾接近或超过 5 秒默认测试预算；只为这些用例设置 10 秒预算，断言不变，目标 FlowStart 60 项测试通过。第一次合并后全量本地 UI 运行因过高并发出现超时并停止；最终使用 4 个 worker 完整重跑，未改变断言。

最终完整 UI 命令 `pnpm --filter @harnessdesk/ui test --maxWorkers=4`：677 个文件、8,573 项通过，退出码 0，227.58 秒。UI 类型检查、实际 Vite 构建、设计文档新鲜度及接口漂移检查通过。浏览器测试只做发现检查：266 文件、6,509 项可发现，未将其记为执行通过。

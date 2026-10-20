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

已检查的本地截图位于 `output/visual-team-audit/`：

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


## 新截图队列：Chat、Tasks 与所有信息栏

自己的 Channel 消息使用右侧浅色气泡，保留接收者、时间、排队和投递状态；Agent 消息仍在左侧显示身份。Tasks 使用紧凑的一行工具栏和非空状态过滤，Assignee 与 Seats 共用稳定的简短名称及真实 runtime 标记。Chat 的两种布局改名为 Chat / Split，Flow 本身的 Side by side 名称保留。停止后的 Run 恢复入口放回当前 Run 的上下文控制。

通过 computer use 观察了 Claude 的实际折叠、摘要、打开工具时收起信息栏、关闭后恢复及显式并排行为，原布局和草稿已还原。未发布真实桌面的图片。产品中的 Run、Conversation、Seats、步骤及技术记录统一使用可收起标题；可选空集合仅在成功读为空时省略，读取中、失败与重试仍可见。

修复毛玻璃被内层不透明滚动底色遮住的问题：共享 rail 材质使用透明内层，信息卡片保持自己的背景。浮动 rail 按内容收缩，并受实际 composer 高度约束。760×640 的实际 CUA 测量：收起后 rail 为 288×120，顶边 48、底边 168；composer 顶边 470、高 170，页面没有横向溢出。内层滚动背景为 rgba(0, 0, 0, 0)，外层 backdrop-filter 为 blur(12px)。1440×900 的 Details 并排测量：rail 右边 1040 与 Details 左边 1040 接合，没有重叠；工具关闭后保留原 rail 偏好。浅色、深色和窄窗口均实际检查。

新增审批来源的 From 无障碍关系文本，图标不会使其消失。可选 Judge 继续由 Details 明确进入；相应浏览器测试迁移到实际图形节点的 Configure 控件，并保留严格对齐与可达性断言，没有更新几何基线。

当前验证：UI 类型检查、实际 Vite 构建、严格设计审计和 pnpm check:push --base origin/development --fast 均通过。该命令显式跳过的 Node 与 browser 套件不计入通过。新轮完整 UI 与 hosted browser alignment 结果待本节追加。

新轮复核还补充了 SkillPage 的空 Loaded by 集合省略；读取中和保留的失败仍显示。测试先红后绿，SkillPage 48 项通过。输入框 No folder 测试保留原精确标题和内容断言，等待异步渲染完成，避免仅在完整套件负载下读取旧 DOM。合并后的三组守卫测试 53 项通过。

公开新增帧位于不可变截图提交 [35a55e46f074](https://github.com/HarnessDesk/HarnessDesk/tree/35a55e46f0743df0c6e9234bbccd039377503c44/pr-1813/visual-team-flow)，均来自隔离 rig，已逐张检查。

最终冻结产品源码后的完整 UI Vitest：677 个文件、8,596 项通过，退出码 0，211.94 秒。最终类型检查、Vite 构建和快速提交门禁再次通过。760px 收起与 1200px Details 并排均通过实际测量；1200×800 时浮动 rail 为 x=504、宽 288、底 448，Details 从 x=800 开始，保留 8px 间隔且无横向溢出。

Hosted browser 先执行于 50d45bc51。旧完成结果预览需要先切到 Chat；修正后 optional-judge 在 91e205d45 上四项全部通过（run 39382135011）。另外两处 Team Work helper 迁移保留了 Tasks/Findings 的实际选中状态断言和 Seats 区域可见性断言，等待独立重跑。

已完成的 hosted 浏览器执行（这些文件在后续提交中未修改）：

| Spec | 源码 | 结果 | Run |
| --- | --- | --- | --- |
| edge-alignment | 50d45bc51 | 8 passed | [39381508634](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39381508634) |
| goal-bar-alignment | 50d45bc51 | 2 passed | [39381510685](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39381510685) |
| reading-column-edges | 50d45bc51 | 4 passed | [39381512071](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39381512071) |
| sidebar-edges | 50d45bc51 | 19 passed | [39381514351](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39381514351) |
| frame-fix6 | 50d45bc51 | 50 passed | [39381516115](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39381516115) |
| frame-contract-work-tile-composer | 50d45bc51 | 2 passed | [39381521377](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39381521377) |
| optional-judge | 91e205d45 | 4 passed | [39382135011](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39382135011) |
| frame-contract-team-work | 1ef634850 | 30 passed | [39382384479](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39382384479) |

完整浏览器套件、所有 native 与全量 pnpm verify 尚未执行，以上有界验证不替代这些套件。

额外复审在 50d45bc51 上确认共享气泡、审批、FlowCanvas、浮动 rail 与玻璃材质没有新增缺陷，但覆盖仅 87/125 个要求文件，不能记录为完整无问题审查。指出的剩余旧 Chat 布局测试和 publication-words 的 Judge 入口已迁移；普通 Team 的长任务误指 Done when 的提示已修正，三个新增回归与 FrontDoor 60 项通过，类型检查通过。

alignment census 首轮 87 项通过，104 个 board 用例在测量前因同一目录清单缺少新增 Flow example 而失败。未测量的 board 使 afterAll 的“fixed”信息无效，本轮没有据此修改对齐基线。补全清单后执行完整重跑，再决定是否存在真实几何变化。

新一轮完整 UI（含三个表单提示回归）677 个文件、8,599 项通过，214.78 秒；类型检查、构建和最终快速门禁通过。新增四组浏览器验证中 team-bar 四项通过；team-tabs 揭示 360px 的真实标题宽度为零，正在共享 TopBar 修复，未放宽严格标题断言。

alignment census 补全目录后的完整重跑在 9899bd575 通过：192 项（run [39383094074](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39383094074)），覆盖新增 Flow example，未修改 alignment-census.json。后续发现的窄顶栏问题独立修复，最终源再执行该测量。

360px 的真实窄窗口修复：栏内标题从 0 恢复到 216.34px，data-fold=1，页面无横向溢出；直接保留 sidebar、标题与 More。More 含原 Back/Forward、rail、Terminal、Changes（原禁用原因）、Browser、Files、Run history 和窗口动作。折叠 rail 动作实际打开信息栏并把焦点交回 More。保持菜单打开时放大到 1440px，data-fold 回到 0，原工具恢复且菜单继续可用；深色也实际检查。

独立静态复核还指出 compact 属性移除后折叠状态未复位，已在正宽与零宽两种情形先红后绿修正。内联审批的新旧焦点回归先红后绿，真实模态的聚焦/恢复测试仍通过。图中 Runtime 3 的拒绝现在只显示共享 issue mark，完整消息保留在 title 和无障碍名称中；CUA 选择 Use Runtime 1 后标记消失，Judge 显示 Runtime 1。


## 最终产品源码与证据

产品源码冻结在 `1bf847c5697303fe68137a365a6b8d05c19a790f`，已包含 development `24aa8d7fdeee47f03f787cc77f40978948bf8141`。提交后的完整 UI 命令 `pnpm --filter @harnessdesk/ui test --maxWorkers=4` 实际通过：677 个文件、8,604 项，退出码 0，210.31 秒。类型检查、Vite 构建、严格设计审计和 `pnpm check:push --base origin/development --fast` 通过，快速门禁耗时 65.7 秒；其跳过的 Node/browser/native 套件不计为通过。审计保留所有硬零类别与既有几何标准，布局债务上限为 2,038，没有增加例外。

最终新增的浅色 Chat、窄顶栏浅色/深色菜单帧已逐张检查，来自隔离 rig 或 preview，发布于不可变截图提交 [2c9d4a06acd4](https://github.com/HarnessDesk/HarnessDesk/tree/2c9d4a06acd4c2e8390d956768518e3b686d8304/pr-1813/visual-team-flow)。真实 Claude 桌面只用于本机观察，没有发布。最终本机 Chat 保持两个原待处理审批、空输入区、可收起 Run/Seats 和正常窗口尺寸，没有发送新的 Agent 消息。


最终一轮独立只读复核覆盖共享 TopBar 的折叠属性切换、零宽与正常宽度清理、原工具回调与拒绝原因，内联/模态审批聚焦边界，以及 rail 的透明内层、composer 测量清理、工具优先级、显式 reveal 持久化和 Swap。该范围未发现新的可复现缺陷；它是有界静态审阅，不替代完整逐文件审查、hosted 浏览器结果或 native 验证。


同一最终产品源码的 hosted 浏览器实跑（runs=1、copies=1、单 worker、无 retry）：

| Spec | 实际结果 | Run |
| --- | --- | --- |
| alignment-census | 192 passed | [39385553578](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39385553578) |
| edge-alignment | 8 passed | [39385555228](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39385555228) |
| goal-bar-alignment | 2 passed | [39385557814](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39385557814) |
| reading-column-edges | 4 passed | [39385559709](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39385559709) |
| sidebar-edges | 19 passed | [39385561540](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39385561540) |
| team-tabs | 6 passed | [39385564127](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39385564127) |
| team-frame | 37 passed | [39385565299](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39385565299) |
| team-bar | 4 passed | [39385567714](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39385567714) |
| publication-words | 2 passed | [39385569752](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39385569752) |
| frame-contract-work-leads-wide-teams | 54 passed | [39385571857](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39385571857) |
| frame-contract-work-leads-narrow-teams | 54 passed | [39385574263](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39385574263) |

上述十一组共 382 项通过，0 项失败，其中五组视觉对齐检查共 225 项。没有修改 alignment-census.json 或放宽 title-contract；实际浏览器结果与静态发现、CUA 测量分别记录。


最终产品源码的常规 CI [39385542685](https://github.com/HarnessDesk/HarnessDesk/actions/runs/39385542685) 已完成并通过，tier 为 bounded；其中显式跳过的浏览器分片、server-facing 与 native smoke 仍不计为通过，不把 bounded 解释为 full-tier 或可合并证明。

最终证据文件整理后再执行快速提交门禁，退出码 0，64.3 秒。


## Teams 与 Agents 目录复核 — 2026-10-20

Teams 保留按需要人处理、工作中、可收尾的真实三组工作入口；长 runtime 拒绝改为准确状态与一个共享 IssueMark，全文保留在可访问描述、悬停、搜索和原 Team 详情。任务标题可读两行，普通摘要有界。Agent 目录把角色用途与实际 runtime/model、asked/held ceiling 分开，新增来源筛选和搜索；完整文件来源与被覆盖副本由 Sources and precedence 统一展开，精确详情身份和未完成保存恢复保持原行为。

实际 CUA 已检查两页浅色、深色与宽/窄窗口。375px 时 Agent 卡片宽 319px，高 112–136px；Teams 卡片高 124–144px，两页都没有横向溢出。搜索 Implementer 只保留一个角色卡，点击后进入准确的 Implementer 详情。警告全文仍可由原共享标记读取。公开帧只取自隔离 rig 与 preview。

完整 UI 命令 pnpm --filter @harnessdesk/ui test --maxWorkers=4 实际通过：678 文件、8,613 项，209.81 秒。独立类型检查、Vite 构建、严格设计审计与文档路径检查通过。新 Agent Catalogue 问题描述回归先红后绿；两页聚焦回归共 69 项通过。新增目录板覆盖生产默认、加载、空、失败、长名称与来源展开；注册测试 37 项通过。完整 CI 与本轮浏览器验证结果随后记录。

依照所有者新指示，.superpowers 和 docs/superpowers 从 Git 跟踪中移除并忽略，本机工作文件保留；正式接口、决定与验证记录仍在文档树中。

推送前快速门禁实际通过，退出码 0，67.2 秒；跳过项不计为通过。两页六张浅色/深色/窄窗口帧已逐张检查并发布到不可变截图提交 [ef22d1ee6ba0](https://github.com/HarnessDesk/HarnessDesk/tree/ef22d1ee6ba0f89383a0d35697539bd407e94cc2/pr-1813/visual-team-flow)。

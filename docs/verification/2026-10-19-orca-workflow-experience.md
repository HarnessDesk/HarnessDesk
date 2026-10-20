# Orca 与 HarnessDesk 的团队开发使用心得

2026-10-19，在真实桌面界面中走查添加项目、启动团队、观察工作状态和处理失败。HarnessDesk 基线为 development 的 `a821873cd8b389638d66e44c977cf303af16c4f6`；Orca 源码为 `acdf0663f0560b7c6c0a64c0336ab66d58e4c382`，包版本 1.4.214。两者使用独立的应用资料目录和同一个可丢弃的 storefront 示例项目。

最明显的差距在启动成本：Orca 先让人进入项目，再从 New tab 直接启动 Agent Teams；HarnessDesk 先要求人在十种 Flow 中选择，再处理角色、运行时和预检。HarnessDesk 的结构能表达更严格的审核流程，但简单任务也要理解这些概念。启动失败时，错误必须直接解释原因，并出现在眼前，否则这些额外步骤只会增加不确定感。

## 实际走查

| 操作 | Orca 的实际表现 | HarnessDesk 的实际表现 |
| --- | --- | --- |
| 进入项目 | Add project → Browse folder → 打开 storefront → 选择 main，进入终端和文件树 | 已记住的 storefront 出现在侧栏和新会话的文件夹栏中 |
| 找到团队入口 | New tab 菜单直接列出 Claude Agent Teams | New session 旁的菜单 → New Team；也可用快捷键 |
| 配置任务 | 在已有终端中输入自然语言团队任务 | 填任务、选 Flow，再选择角色与运行时；首次展示十种 Flow，角色设置需要继续滚动 |
| 启动 | 首次菜单启动因本地开发 CLI 尚未构建而失败；补建后以普通权限命令启动成功 | Write and review 被预检阻止；Just a Team 则创建了 Team，但所选 Seat 因项目准入遗漏而无法打开 |
| 观察工作 | 一条只读任务启动两个 Explore 子代理，界面自动出现主代理和两个终端分栏，侧栏显示 Working | 失败的 Team 已出现在侧栏；对话框留在成员列表，固定页脚显示 Retry unfinished，实际错误在滚动区域下方 |

Orca 菜单第一次失败属于本次源码开发环境缺少 CLI 构建，不能据此认定发行版也有这个问题。补建后没有重试菜单默认附带的权限跳过参数，而是在终端以普通权限启动团队。Orca 的终端沿用本机代理账户；这些画面不用于公开截图。

HarnessDesk 使用仓库的假代理 rig。它证明真实 UI、预检、项目准入和 Seat 生命周期的行为；代理输出是脚本，不能作为真实模型完成开发任务的证明。Orca 的本次任务限定为只读：一个子代理检查 src，另一个检查 test，评估主题切换及测试方案。两个子代理均返回报告，主代理汇总后侧栏显示三个代理 Done；报告指出示例项目没有实际 UI，因而没有执行主题切换开发。

## 三个已复现的问题

### 1. 记住的项目可以显示，却不能启动普通团队

复现：在记住但没有捕获 shell identity 的项目中，New Team → Just a Team → 选择 Codex 与 Implementer → Start Team。界面报 Seat 项目不属于已打开项目，要求先打开；但同一项目已出现在侧栏和对话框标题里。

原因：Flow 启动会把用户选择的项目通过 `admitTeamProject` 准入；普通团队路径直接创建 Goal 再打开 Seat，漏掉此步骤。`docs/decisions.md` 中关于 Team start 的既有约定要求支持这种旧项目记录。

修复：普通团队使用专用的 `goal/start` 请求，只接受用户所选 root、任务和 checkout 模式。主机先执行既有项目准入，再创建 Goal。通用 `goal/create` 和代理创建 Goal 的路径保持原有权限；未知项目和失效的已捕获身份仍拒绝。

### 2. 预检说不能运行，却遗漏能帮助修正的原因

复现：Write and review 的写手和审核者显式选择同一提供方。角色行提示同一提供方，而醒目的阻断信息只说无法打开 code-reviewer，没有说明独立审核约束。自动候选的登录和健康状态也会被遗漏。

原因：错误汇总只保留四种候选拒绝原因，丢弃了 sameProvider、signIn 和 health 等已有解释。

修复：使用现有拒绝原因格式器汇总所有被拒候选。这里应保留独立审核约束，而不是为了让 Start 可点击而取消它。初次走查中的登录和只读能力拒绝来自 rig 特意设置的候选，不另算产品故障。

### 3. 启动失败后，错误藏在屏幕外

复现：在成员列表处点击 Start Team，部分成员打开失败。页脚变为 Retry unfinished，错误追加在 Done when 后面，当前视口仍停留在成员列表。

修复：失败出现时，将现有错误区域聚焦并滚动到可见位置，保留已经创建的 Team、成功的 Seat 和只重试未完成成员的行为。

## 已实施的启动体验改进

按后续明确的范围，只进一步研究 Orca、Agent Orchestrator 和 Paperclip；[参考研究](2026-10-19-team-start-reference-research.md) 分开记录真实走查与源码结论。

- 首次显示三个常用或项目 Flow，加 Just a Team；完整目录保留在 All Flows 和搜索中。选中后，目录收为名称、真实策略缩略图和 Change，不再占据角色配置上方的大块空间。
- 每个角色只保留一个显示实际 runtime/model 的 Configure 入口；指令预设留在角色名称旁，模型、effort 和指令在同一弹层中调整。自动选择的固定 model/effort 与实际策略保持一致，过期 effort 仍可清除。
- 任务、Flow、成员和 Start 留在同一个对话框内。可选完成条件与 dry run 收起；Flow 的额外输入始终显示，避免把执行必需信息藏进 Details。切换 Flow 保留任务与各自草稿。
- 预设 Agent 页面顶部直接提供 Choose runtime 与 Customize。Choose runtime 复用已有本机偏好写入与并发保护，保留后备列表；内建 Agent 文件保持只读。

桌面复验：选择 Side by side 后，实际策略图随“由我选择、无自动 Judge”的配置更新。rig 的第二个候选因权限能力不足被拒绝，角色行直接提供 Use Codex。应用建议后，Start Team 成功创建 Run、两个隔离 Seat 与两张已分配任务卡。它证明从紧凑表单到实际 Team 的执行链路，未声称假代理完成了开发任务。

预设 Agent 的 Choose runtime 直接打开本机 runtime/model/effort 对话框；保存后 On this Mac 显示所选 Codex，页面的内建候选列表仍保留。

在实际 preview 页面测量 Write and review：1280×900 与 680×900、light/dark 四种组合均无水平溢出；任务与所选 Flow 的左右边界一致，两个角色配置按钮的左右边界一致。宽窗口的内容左边界为 234px，右边界 1038px；窄窗口为 40px 与 632px。选中后任务、两个角色及固定 Start 都可见；可选设置仍可能需要纵向滚动，不声称所有内容零滚动。共享 SelectedFlow 也加入设计系统目录，并在 design explorer 的 light/dark 实际检查。

后续仍值得改善：启动后的 Overview、Board、Chat 如何更集中地回答“谁在做什么、卡在哪里”。Orca 的分栏更直观，但长文本会变窄；本次没有重做工作区布局。“10x”是目标，不是已经测得的可用性倍数。

## 验证记录

子代理分别补充了候选拒绝原因、启动错误焦点和普通团队项目准入的回归测试，先观察失败再修复。集成后独立执行：

- `pnpm build` 成功。
- `node --test packages/server/dist/test/goal-start.test.js packages/server/dist/test/flow-methods.test.js packages/server/dist/test/flow-preview.test.js`：50 项通过。
- FrontDoor、GoalCreate、FlowStart、AgentPage、FlowCards、team-start、store.goal 和 store.front-door：8 个文件，216 项通过。
- 桌面复验：同一记住的项目成功创建普通团队、打开所选 Seat 并显示任务卡；人为改变可丢弃项目的 Git checkout identity 后，启动仍被拒绝，错误自动进入视口并获得焦点；恢复 fixture 后，Write and review 的同提供方阻断信息明确显示原因。
- `pnpm check:push --base origin/development`：所选架构、设计、类型检查、protocol 和 retention 检查通过；server 测试中的 flow-resumed-work 在批量运行时超时。该文件单独重跑 1/1 通过。此次完整 check:push 的退出码仍为 1，不能记为全绿；规划器跳过的广泛依赖和浏览器套件也不算通过。

- 最终 `pnpm check:push --base origin/development --fast` 成功；它明确跳过 Node/UI/browser 测试，不能替代上面单独执行的测试。新共享组件已注册到目录，生成文档和设计审计通过；布局历史基线减少 2 项，严格项保持零。

浏览器回归文件同步更新了折叠目录、键盘焦点和四种布局组合的断言；本次通过 CUA 实际走查同一页面，未将未执行的 Playwright 套件记为通过。PR 审核结果随本次 PR 记录。


## 可检查的界面证据

以下来自独立假代理 rig 或公开 preview fixture。

![紧凑 Team 启动](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/998014c248ed1904cc997f6b41e3a39bbfc1d37a/team-start-2026-10-19-b2aa/compact-team-native.png)

![预设 Agent 直接配置](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/998014c248ed1904cc997f6b41e3a39bbfc1d37a/team-start-2026-10-19-b2aa/agent-runtime-direct.png)

[角色配置](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/998014c248ed1904cc997f6b41e3a39bbfc1d37a/team-start-2026-10-19-b2aa/compact-role-configuration.png) · [窄窗口 light](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/998014c248ed1904cc997f6b41e3a39bbfc1d37a/team-start-2026-10-19-b2aa/compact-flow-narrow-light.png) · [窄窗口 dark](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/998014c248ed1904cc997f6b41e3a39bbfc1d37a/team-start-2026-10-19-b2aa/compact-flow-narrow-dark.png) · [实际启动两个 Seat](https://raw.githubusercontent.com/HarnessDesk/HarnessDesk/998014c248ed1904cc997f6b41e3a39bbfc1d37a/team-start-2026-10-19-b2aa/compact-team-opened.png)

# 团队启动与预设配置参考研究

2026-10-19。按最终范围，只比较 Orca、Agent Orchestrator、Paperclip。Orca 包含真实桌面走查；另两者的操作路径来自本地源码和文档，不记为已运行的产品验证。快照分别为 Orca `acdf0663f0560b7c6c0a64c0336ab66d58e4c382`、Agent Orchestrator `a7f709ef31a38f2882c2bd609341ca36e134ce60`、Paperclip `f4d21e2b840ba0e6966e6223d3cd04e5ce60f689`。

结论：HarnessDesk 应把复杂度留在 Flow 引擎和可选设置里。普通启动只需要任务、一个 Flow、已经配好的角色和 Start。图形用来解释这支队伍如何工作，不应让人先看完整个模板库、再到下一屏寻找成员配置。

## 三个参考产品

| 产品 | 最值得借鉴的路径 | 对 HarnessDesk 的启发 |
| --- | --- | --- |
| Orca | 进入项目 → New tab → Agent Teams → 自然语言任务；工作时展开主代理与子代理分栏 | 项目上下文已经确定时，直接进入任务；团队进展应能一眼看见 |
| Agent Orchestrator | New task → 写任务 → 查看已解析的 Agent/model → Start；复杂任务交给项目协调者 | 默认值要显示实际将使用的选择，并且仍可直接修改 |
| Paperclip | 选择完整 Team package → 只问适用的前置条件 → 预览成员与 adapter → 安装 | 一次选择应带齐角色配置；只为真正缺失的条件增加问题 |

### Orca

真实走查中，添加项目后可从一个菜单直接启动 Claude Agent Teams。补齐源码环境的 CLI 构建后，普通权限命令启动成功。一次限定只读的任务启动了两个 Explore 子代理，主代理汇总了两个报告，侧栏显示三者 Done。三栏很直观，但长文本明显变窄；“更可见”也需要保留可读的主工作区。完整记录见 [使用心得](2026-10-19-orca-workflow-experience.md)。

源码中的新工作区表单只有一个可选 Agent 选择器和一个 Advanced 开关；协调设置另外列出技能的 Ready/Missing 覆盖范围。它把“现在做什么”和“环境是否能做”分开呈现。其并行工作配方仍包含手动创建多个 worktree、启动代理、粘贴任务和比较结果的步骤，因此不能把文案里的 fan-out 当作所有流程都已一键完成的证明。

来源：[新工作区 Agent 区域](https://github.com/stablyai/orca/blob/acdf0663f0560b7c6c0a64c0336ab66d58e4c382/src/renderer/src/components/new-workspace/NewWorkspaceComposerAgentSection.tsx#L47)、[协调设置](https://github.com/stablyai/orca/blob/acdf0663f0560b7c6c0a64c0336ab66d58e4c382/src/renderer/src/components/settings/OrchestrationPane.tsx#L91)、[并行工作配方](https://github.com/stablyai/orca/blob/acdf0663f0560b7c6c0a64c0336ab66d58e4c382/docs/site/content/docs/recipes/parallel-agents.mdx#L7)。

采用：任务优先、一个主要配置入口、图形化并行关系、明确的准备状态。保留 HarnessDesk 的权限约束和真实预检，不把“技能装好了”说成“团队肯定能运行”。

### Agent Orchestrator

TaskComposer 明确预选实际 spawn 会采用的 Agent 和 model，而不是只显示含糊的 default。记住的 Agent 只有在仍可用时才复用；独立任务选择 ready 的候选。启动使用项目感知的权威路径，重复提交保留同一个请求身份，偏好在成功后才持久化。失败会保留结构化恢复选项。

项目协调者把子工作挂在同一上下文下，列表分别表达加载、不可用、空列表和实时状态。设计文档把真实状态、当前任务和下一步操作排在视觉装饰之前，要求控制台紧凑、对齐，并将次要 inspector 收起以保护主内容。

来源：[默认值解析](https://github.com/OrchestratorInc/agent-orchestrator/blob/a7f709ef31a38f2882c2bd609341ca36e134ce60/frontend/src/renderer/components/TaskComposer.tsx#L343)、[启动与重试](https://github.com/OrchestratorInc/agent-orchestrator/blob/a7f709ef31a38f2882c2bd609341ca36e134ce60/frontend/src/renderer/components/TaskComposer.tsx#L645)、[协调者子工作列表](https://github.com/OrchestratorInc/agent-orchestrator/blob/a7f709ef31a38f2882c2bd609341ca36e134ce60/frontend/src/renderer/components/OrchestratorChildrenSection.tsx#L17)、[设计指南](https://github.com/OrchestratorInc/agent-orchestrator/blob/a7f709ef31a38f2882c2bd609341ca36e134ce60/DESIGN.md#L41)。

采用：显示实际 runtime/model，保留明确覆盖，失败时保留上下文。它的任务协调路径不等同于 HarnessDesk 强制执行的审核 Flow；简化入口不应取消独立审核或证据要求。

### Paperclip

TeamCatalog 把一支队伍作为可预览的完整包来安装，而不是要求先逐个创建成员。向导步骤由实际条件计算：简化 onboarding 去掉不适用的 manager/source 问题，确有必需技能时才保留 prerequisite 步骤。预览按 Agent/project/starter task 分组，adapter 可按成员绑定；缺少认证、无效预览或不可用 adapter 会阻止安装。

单个 Agent 的初始创建只问名称和 adapter，较深的 model 配置留到后面。这个模式的价值是“只问必要问题”，而不是多加一个向导。HarnessDesk 的普通 Flow 启动应保留在同一屏，不复制组织、经理、来源政策等额外概念。

来源：[按条件计算步骤](https://github.com/paperclipai/paperclip/blob/f4d21e2b840ba0e6966e6223d3cd04e5ce60f689/ui/src/pages/TeamCatalog.tsx#L869)、[安装前置检查](https://github.com/paperclipai/paperclip/blob/f4d21e2b840ba0e6966e6223d3cd04e5ce60f689/ui/src/pages/TeamCatalog.tsx#L1249)、[成员预览与 adapter 选择](https://github.com/paperclipai/paperclip/blob/f4d21e2b840ba0e6966e6223d3cd04e5ce60f689/ui/src/pages/TeamCatalog.tsx#L1875)、[Agent 基础表单](https://github.com/paperclipai/paperclip/blob/f4d21e2b840ba0e6966e6223d3cd04e5ce60f689/ui/src/components/new-agent/AgentBasicsDialog.tsx#L38)。

采用：完整、可执行的预设，预先准备好角色，只针对缺失条件询问。成员名称、模型或开关只有真正进入执行请求，才算配置生效。

## HarnessDesk 的具体改造

1. 首次只呈现少量常用 Flow 与 Just a Team；搜索和 All Flows 保留完整能力。选中后把模板库收成名称、真实策略图和 Change。
2. 每个角色只有一个整齐的配置入口。默认显示指令预设和实际运行时，模型、effort 和指令更改在本地弹层中完成。阻断原因留在受影响角色旁。
3. 预设 Agent 页面顶部直接提供 Choose runtime 和 Customize；不要求先读文件来源、历史成本和多级偏好说明，再滚动寻找入口。局部选择仍使用既有原子写入和并发保护。
4. 任务、Flow 图、成员、错误和主按钮共享清晰的边界。正常启动无需换页；可选完成条件和专家信息收起，必需输入仍显示。
5. 用真实桌面走查和 light/dark、窄/宽窗口的边界测量验证结果。“10x”是改善目标，未作为已测得的性能或可用性倍数。

实施契约见 [紧凑 Team 启动设计](../superpowers/specs/2026-10-19-compact-team-start-design.md)。

# HarnessDesk documentation

Start where your question starts. Three doors, an evidence shelf, and the
rule that keeps them honest.

## Use it

You run agents, and you will never read this repository's source.

| | |
| --- | --- |
| [getting-started.md](getting-started.md) | Install an agent — or three — sign in, run a first session; keyboard; troubleshooting |
| [interface.md](interface.md) | Every surface of the window, and why each is shaped the way it is |
| [cli.md](cli.md) | The `harnessdesk` command line: installing it from the app's menu, and every command, flag, `--json` shape and exit code — generated from the command table by `pnpm cli:doc` |
| [agents.md](agents.md) | Who does the work: an Agent's brief, the most it may do and the seats it prefers; the ten that ship; starting as one, and saving your own |
| [runtimes.md](runtimes.md) | Which copy of a runtime — an installed agent CLI — runs, where the model list comes from and why it is sometimes wrong, and multiple accounts |
| [agent-capabilities.md](agent-capabilities.md) | What four agents declared they could do, surveyed out of the running app on 2026-08-23 and not re-run since — a dated survey, not the current roster |
| [message-queue.md](message-queue.md) | Typing while the agent works — what Enter does in every case |
| [background-tasks.md](background-tasks.md) | Work an agent starts that outlives the turn, and how each agent reports it |
| [multi-agent.md](multi-agent.md) | Hand-offs, `/race`, Teams, and every board and channel flow across vendors |
| [flows.md](flows.md) | Declaring a Team's policy up front — roles, rules and rounds — so a loop of agents runs without you routing every card |
| [context-usage.md](context-usage.md) | The ring beside the model: how full the window is, and — where the agent can say — with what |
| [usage-dashboard.md](usage-dashboard.md) | Every plan's limits and what the month cost, on one screen |
| [browser-control.md](browser-control.md) | The browser inside the window, and which agents get its tools |
| [data-boundaries.md](data-boundaries.md) | What leaves this machine, per lane — what you send an agent, and the few things the app itself asks the network for, with how to turn each off |
| [open-and-hosted.md](open-and-hosted.md) | What is open and what is hosted: the client and the wire are open, the service that relays and pushes is not, and sees only ciphertext |

## Extend it

You are building against HarnessDesk — a plugin, a tool, or a backend.

| | |
| --- | --- |
| [extending.md](extending.md) | Writing plugins (panels, tools, editor plane), composer context chips, and runtime adapters |

## Understand it

You are deciding whether to trust it, or changing it.

| | |
| --- | --- |
| [architecture.md](architecture.md) | The system as built, package by package |
| [decisions.md](decisions.md) | The choices that shape the system, their costs, and the rules a reviewer can apply |
| [diagrams/](diagrams) | The architecture as a diagram — typed JSON source, rendered to one self-contained interactive page |
| [design-system.md](design-system.md) | Tokens, primitives, patterns — generated from the source by `pnpm design:doc`; never edited by hand |
| [design.md](design.md) | The type scale, ink levels, row rhythm, and when a row earns a second line |
| [../assets/brand/README.md](../assets/brand/README.md) | The mark, the icon spec measured against macOS itself, and what blue is not |
| [release.md](release.md) | Cutting a release by hand: the changelog, the version bump, the release PR, signing, notarizing, checksums and publishing |
| [site-demo.md](site-demo.md) | The website's staged Run: building the embedded renderer, and the views and stages it plays |
| [site-scenes.md](site-scenes.md) | The website's live scenes: every registered view, its logical size and what it shows |
| [claude-agent-acp-follow-ups.md](claude-agent-acp-follow-ups.md) | What is still open on the Claude Code bridge over the official Claude Agent ACP package |

[decisions.md](decisions.md) records the choices behind the system and their
trade-offs. Where a decision defines a rule, its section states it explicitly.

## Evidence

Dated measurements against named builds. Nothing on this shelf is evergreen
and nothing on it is promised — each file says what was run, on which
versions, and when, and a newer build owes it nothing.

| | |
| --- | --- |
| [verification/2026-09-18-agents-ceilings.md](verification/2026-09-18-agents-ceilings.md) | 2026-09-18, 0.2.4: the phase-3 ceiling walkthrough — live observations kept apart from deterministic test proof |
| [verification/2026-10-19-visual-team-flow.md](verification/2026-10-19-visual-team-flow.md) | 2026-10-19, in Chinese, no build named: using and checking the visual Team, Flow and Work path end to end |
| [verification/library-measurements/](verification/library-measurements/README.md) | 2026-10-03: sign-in-free, isolated measurements of what sixteen agents report about skills, rules and MCP |
| [typography-cjk/measurement.md](typography-cjk/measurement.md) | 2026-10-03, macOS with Chromium 153: which system font renders each Chinese, Japanese and Korean glyph in the shared components, before and after |

The capability matrix in
[agent-capabilities.md](agent-capabilities.md) is the same kind of fact: read
out of the running app on a stated date, never asserted.

## The rule

An evergreen guide carries no version snapshot; a dated measurement carries
nothing evergreen. And a documented fact names how it was measured, or links
the code that settles it — a sentence with neither is a sentence nobody can
maintain. The rest of the writing rules are in
[../CONTRIBUTING.md](../CONTRIBUTING.md).

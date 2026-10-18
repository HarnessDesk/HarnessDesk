<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/svgs/harnessdesk-icon-white-transparent.svg" />
    <img src="assets/brand/svgs/harnessdesk-icon-black-transparent.svg" width="56" valign="middle" alt="" />
  </picture>
  HarnessDesk
</h1>

<p align="center">
  <a href="https://github.com/HarnessDesk/HarnessDesk/releases/latest"><img src="https://img.shields.io/github/v/release/HarnessDesk/HarnessDesk?style=flat-square&label=release&color=blue" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/macOS-13%2B-black?style=flat-square&logo=apple&logoColor=white" alt="macOS 13 or later" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue?style=flat-square" alt="MIT licence" /></a>
</p>

<p align="center">
  <strong>Your coding agents, working as a team.</strong><br/>
  Race Codex, Claude Code, Cursor and a dozen more on one task, let them check each other’s work, and decide what lands.
</p>

<h3 align="center"><a href="https://github.com/HarnessDesk/HarnessDesk/releases/latest"><ins>Download for macOS</ins></a> · <a href="docs/README.md"><ins>Documentation</ins></a></h3>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark) and (prefers-reduced-motion: no-preference)" srcset="docs/images/app/readme-race-dark.gif" />
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/app/readme-race-dark-poster.png" />
    <source media="(prefers-reduced-motion: no-preference)" srcset="docs/images/app/readme-race-light.gif" />
    <img src="docs/images/app/readme-race-light-poster.png" width="960" alt="Side by side: Codex and Claude Code each build a runner game in their own browser. Codex finishes first, Claude Code follows, the judge picks Codex’s attempt, and Merge waits for you." />
  </picture>
</p>

<p align="center"><sub>Two agents, one brief, a browser each. The judge picks; you merge.</sub></p>

## Features

<table>
<tr>
<td width="42%" valign="middle">

### Teams

Every Team on one board, with the work that needs you first.

[Docs →](docs/interface.md#the-teams-page)

</td>
<td width="58%">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/app/readme-teams-dark.png" />
    <img src="docs/images/app/readme-teams-light.png" width="100%" alt="The Teams board: Needs you, Working and Ready to wrap, each Team with its progress and project." />
  </picture>
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### Flows

Set who writes, who reviews, which checks run and where you step in. Every Run keeps the route it took.

[Docs →](docs/flows.md)

</td>
<td width="58%">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/app/readme-flow-dark.png" />
    <img src="docs/images/app/readme-flow-light.png" width="100%" alt="The route a Run took: write, check, review, a requested fix, land, and a person step waiting for you." />
  </picture>
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### Library

Skills and MCP servers across every agent you use, and which agents actually load each one.

[Docs →](docs/interface.md#settings)

</td>
<td width="58%">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/app/readme-skill-dark.png" />
    <img src="docs/images/app/readme-skill-light.png" width="100%" alt="A skill’s page: its SKILL.md, an available update, and which agents load it." />
  </picture>
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### Dashboard

A year of work across every agent and account: what it cost, what is left, and when you work.

[Docs →](docs/usage-dashboard.md)

</td>
<td width="58%">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/app/readme-dashboard-dark.png" />
    <img src="docs/images/app/readme-dashboard-light.png" width="100%" alt="Activity for the last 12 months: 370 million tokens over 252 active days, with weekends and days off." />
  </picture>
</td>
</tr>
<tr>
<td width="42%" valign="middle">

### Command line

Script it, or let your agent run it: the same Runs from a terminal.

[Docs →](docs/cli.md)

</td>
<td width="58%">
  <picture>
    <source media="(prefers-color-scheme: dark) and (prefers-reduced-motion: no-preference)" srcset="docs/images/app/anim-cli-dark.svg" />
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/app/anim-cli-dark-poster.png" />
    <source media="(prefers-reduced-motion: no-preference)" srcset="docs/images/app/anim-cli-light.svg" />
    <img src="docs/images/app/anim-cli-light-poster.png" width="100%" alt="An illustrated split screen: a terminal starts the comparison Flow and HarnessDesk follows the same Run to the merge step." />
  </picture>
</td>
</tr>
</table>

**Also in the box:**

- **[Hand-off](docs/multi-agent.md#2-hand-offs-passing-the-baton)** — pass a conversation to another agent with a packet it can pick up.
- **[A browser per Seat](docs/browser-control.md)** — each agent opens, clicks and reads its own pages.
- **[Agents](docs/agents.md)** — reusable briefs and ceilings, with ten built-in roles to start from.
- **[Every account](docs/runtimes.md)** — several sign-ins per agent, and how much each one has left.
- **Plugins.** Twelve built in. HarnessDesk projects its 73 built-in plugin tools into each agent’s tool interface. [Docs →](docs/extending.md)
- **[One policy, one audit log](docs/architecture.md)** — the same rules, whichever agent asked.

## Supported agents

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/agents-dark.svg" />
    <img src="docs/images/agents-light.svg" width="912" alt="Codex, Claude Code, Cursor, Gemini CLI, Copilot, OpenCode, Antigravity, Grok Build, Cline, Kimi, CodeBuddy and DeepSeek" />
  </picture>
</p>

<p align="center">…and Hermes Agent, pi, OpenClaw, or any agent that speaks ACP.</p>

Each agent keeps its own sign-in, skills and history; HarnessDesk reads them where they live. A control for something an agent cannot do is simply not drawn — [what each one can do →](docs/agent-capabilities.md)

## Install

Download the signed, notarized app for macOS 13+, Apple silicon or Intel, from the [latest release](https://github.com/HarnessDesk/HarnessDesk/releases/latest). It updates itself. Then bring an agent you already use — [getting started](docs/getting-started.md) covers each one.

**Build from source** — Node 22.19+ and pnpm 10:

```bash
pnpm install
pnpm build
pnpm app
```

[CONTRIBUTING.md](CONTRIBUTING.md) is the way in; security reports go to [SECURITY.md](SECURITY.md).

## Licence

MIT. HarnessDesk is an independent project, not affiliated with, endorsed by, or sponsored by any of the vendors whose agents it drives; their names appear here only to identify their software. The extension kernel is DeepSeek's Cordis (MIT), and the Codex protocol types are generated from `openai/codex` (Apache-2.0). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [TRADEMARKS.md](TRADEMARKS.md).

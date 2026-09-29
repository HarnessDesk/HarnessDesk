<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/svgs/harnessdesk-icon-white-transparent.svg" />
    <img src="assets/brand/svgs/harnessdesk-icon-black-transparent.svg" width="84" alt="HarnessDesk" />
  </picture>
  <h1>HarnessDesk</h1>
  <p><strong>Where your agents work — whoever made them.</strong><br/>
  A control plane for coding agents, owned by no model vendor.<br/>
  <sub>Context, policy, history, tools, cost and evidence in one place — whichever agent does the work. macOS app today.</sub></p>
</div>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue?style=flat-square" alt="MIT licence" /></a>
  <img src="https://img.shields.io/badge/macOS-13%2B-black?style=flat-square&logo=apple&logoColor=white" alt="macOS 13 or later" />
  <img src="https://img.shields.io/badge/agents-Codex%20%C2%B7%20Claude%20%C2%B7%20Cursor%20%C2%B7%20Gemini%20%C2%B7%20any%20ACP-111?style=flat-square" alt="Codex, Claude, Cursor, Gemini, and any ACP agent" />
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/app/turn-dark.gif" />
    <img src="docs/images/app/turn-light.gif" width="900"
         alt="A turn arriving in HarnessDesk: the agent's reasoning appears first, then its tool calls one at a time — reading a file, grepping for a status code, editing it — while the task list in the sidebar ticks over, ending with a summary of what changed." />
  </picture>
</p>

<p align="center"><em>A turn, as it arrives. Reasoning, then the tool calls, then what changed.</em></p>

---

## The problem

Your machine probably already has several of these:

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/agents-dark.svg" />
    <img src="docs/images/agents-light.svg" width="760" alt="Codex, Claude Code, Cursor, Gemini CLI, Copilot, Amp, OpenCode, Cline, Windsurf and DeepSeek" />
  </picture>
</p>

Several agents. Several histories, several permission models, several config
directories, several sets of credentials. No shared context between them, no way
to compare them, and no single answer to *what did the agents do in this
repository this week*.

**A model vendor has little reason to fix that**, and every reason to fix it
only as far as its own agent stays the default — DeepSeek's harness drives
Codex today, and it is still DeepSeek's harness. A shell built by a model
vendor is a shell with a preferred worker, however many others it can run.
HarnessDesk is the desk they all report to, and it makes none of them.

Full positioning: [VISION.md](VISION.md).

## What you get

- **Every agent on one desk.** One window, one history, one search — and a
  sidebar that puts what needs you above what is working, read off each
  turn's items rather than from prose.
- **Parallel work that cannot collide.** Each conversation can run in its own
  git worktree, on its own branch, so two agents edit the same files without
  seeing each other — and `/race` sends one task to two agents side by side.
- **One set of rules, and a library they share.** One permission policy and
  one audit log whichever agent asked; a conversation handed from one agent
  to another as a packet; and a Library that knows every skill and MCP server
  on the machine, which agents actually load each one, and what its catalogue
  line costs per turn.
- **Plugins.** Twelve built in — git, files, search, task list, team,
  checkpoints, guardrails, the browser, the iOS Simulator, Android, the web
  fetcher and the test runner. A plugin's tools reach *every* agent:
  HarnessDesk offers each one an MCP server carrying its 73 built-in plugin
  tools, so a capability written once is available wherever you are working.

## What it looks like

### A room, and a board

<p align="center">
  <a href="docs/images/app/room-light.png">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/images/app/room-dark.png" />
      <img src="docs/images/app/room-light.png" width="900" alt="A room named Checkout hardening with four agents present — Claude, Gemini, Copilot, and Antigravity — each having just answered the same question about retrying a 502 in the checkout flow, in a shared chat panel next to a board showing five unclaimed cards and four cards being worked, one per agent." />
    </picture>
  </a>
  <a href="docs/images/app/board-light.png">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/images/app/board-dark.png" />
      <img src="docs/images/app/board-light.png" width="900" alt="The same room's board: a To do column with five unclaimed cards and a Working column with four cards in progress, one per agent — Claude, Gemini, Copilot, and Antigravity — each showing what it claimed." />
    </picture>
  </a>
</p>

<p align="center"><em>Four vendors' agents on one piece of work, each answering in its own words and claiming from one shared board.</em></p>

### Or hand the room a flow

<p align="center">
  <a href="docs/images/app/flow-light.png">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/images/app/flow-dark.png" />
      <img src="docs/images/app/flow-light.png" width="900" alt="A dialog for naming a new room, mid-fill: Fix and review chosen as its flow, “Retry the checkout call on a 502” as what to fix, and a dry run beneath it listing the four seats it would open — one fixer on Codex and three reviewers on Cursor's Gemini 3.8 Flash — each with its grant, and the round-by-round trace from fixer to reviewer to referee, ending in a note about what running the loop costs beyond opening the seats." />
    </picture>
  </a>
  <a href="docs/images/app/flow-board-light.png">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/images/app/flow-board-dark.png" />
      <img src="docs/images/app/flow-board-light.png" width="900" alt="The same flow mid-run: a Ready column holding three review cards — Review round 2, 1 of 3 through 3 of 3 — each tagged reviewer, each depending on the fixer's pull request, with Waiting, Claimed and Blocked columns all empty beside them." />
    </picture>
  </a>
</p>

<p align="center"><em>A flow says who does what and what moves work between them. Dry run first: it spends nothing and shows exactly what it would open. <a href="docs/flows.md">Flows</a>.</em></p>

### What is left, and what it cost

<p align="center">
  <a href="docs/images/app/dashboard-light.png">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/images/app/dashboard-dark.png" />
      <img src="docs/images/app/dashboard-light.png" width="900" alt="The Dashboard's Overview: a rail of views — Overview, Plans, Spend, Activity, Projects — an All accounts scope in the header, a Paid/Value/Turns/Tokens strip, the accounts that need attention, and what it cost beside where it went." />
    </picture>
  </a>
</p>

<p align="center"><em>Every plan and every account on one screen — what is left, when it resets, and what the work cost at public rates.</em></p>

### The repository, beside the work

<p align="center">
  <a href="docs/images/app/git-light.png">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/images/app/git-dark.png" />
      <img src="docs/images/app/git-light.png" width="900" alt="The repository pane beside a new session: a branch graph with two feature branches and a merge back into main, drawn over the real git history of the open folder." />
    </picture>
  </a>
</p>

<p align="center"><em>History, branches and worktrees next to the conversation that is changing them.</em></p>

## Getting started

macOS 13+ · Node 22.19+ · pnpm 10 · a coding agent — for Codex,
`brew install codex` or `npm i -g @openai/codex`, version 0.145.0 or later.

HarnessDesk is a developer preview built from source:

```bash
pnpm install
pnpm build
pnpm app
```

Headless, against a browser: `pnpm serve`. The host binds `127.0.0.1` and prints
a loopback URL with a per-launch token.

See [docs/getting-started.md](docs/getting-started.md) for adding ACP agents
(Claude Code, Cursor, Gemini CLI), packaging, and troubleshooting.

## What it does not do yet

Stated plainly, because the gaps are the plan.

- **Sign in with an API key from the interface.** Codex's API-key login
  completes synchronously CLI-side; the sign-in dialog says to use the CLI
  for that one case.
- **Raw `config.toml` editing.** The controls people change are surfaced as
  session options and feature toggles; arbitrary config editing is not built.
- **Chat-Completions model routes.** Routes speak the Responses API only;
  LiteLLM's bridge was evaluated against a captured request and declined
  (see [the gateway decision](docs/decisions.md#other-models-reach-codex-through-a-gateway-never-a-fork)).
- **Remote crash reporting, and a release on the update feed.** The updater
  itself ships — packaged apps check a static feed, download in the
  background, install on quit, and roll back by republishing
  — but it is only as real as the
  infrastructure behind it: a notarized build on a feed someone operates.
  Crash capture is local and ships in the diagnostics bundle; nothing is
  reported anywhere.
- **Run your package manager for you.** The Install section names the copy
  of an agent that answers and the command that updates each of the others —
  `brew upgrade`, `npm install -g …@latest`, `uv tool upgrade` — and never
  runs them; only a build HarnessDesk downloaded itself is updated by
  HarnessDesk ([runtimes.md](docs/runtimes.md)).
- **Drive every agent's sign-in.** Gemini CLI, Kimi, CodeBuddy and pi sign in
  from their own interface; the settings page says which command to run in
  a terminal and offers the API-key field where the vendor takes one.

## What each agent can actually do

Agents differ, and the interface is built to say so rather than to paper over
it: a runtime **declares** its capabilities, and a control for something an
agent cannot do is simply not drawn. Nothing here pretends an agent can steer
a turn, fork a conversation or report a quota when it cannot.

What each of them declares today is surveyed in
[docs/agent-capabilities.md](docs/agent-capabilities.md), read out of the
running app rather than off the source. What they have been *shown* to do is a
different question, and the answer is not a document: every capability claim in
this repository is backed by a recording that drove the real app against a
signed-in agent, and `script/check-claims.mjs` fails the build if one of those
claims stops naming a test that still exists.

## Documentation

[`docs/README.md`](docs/README.md) routes by what you came to do — use it,
extend it, or understand it.

- [VISION.md](VISION.md) — positioning, and the promise about what needs an account.
- [docs/interface.md](docs/interface.md) — every surface of the window.
- [docs/multi-agent.md](docs/multi-agent.md) — hand-off, `/race`, boards, and channels.
- [docs/flows.md](docs/flows.md) — declaring a room's policy: roles, rounds, rules, and dry run.
- [docs/architecture.md](docs/architecture.md) — two planes, host, and packages.
- [docs/extending.md](docs/extending.md) — writing plugins and adding ACP backends.
- [docs/decisions.md](docs/decisions.md) — the choices everything else follows from.

## Credits and licence

MIT. HarnessDesk is an independent project, not affiliated with, endorsed
by, or sponsored by any of the vendors whose agents it drives. Their names
and logos appear here to identify their software, and nothing more.

Contributions start at [CONTRIBUTING.md](CONTRIBUTING.md); security reports
take a private door, [SECURITY.md](SECURITY.md).

The extension kernel is DeepSeek's Cordis (MIT), and the Codex protocol types
are generated from `openai/codex` (Apache-2.0). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [TRADEMARKS.md](TRADEMARKS.md).

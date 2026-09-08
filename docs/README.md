# HarnessDesk documentation

Start where your question starts. Three doors, an evidence shelf, and the
rule that keeps them honest.

## Use it

You run agents, and you will never read this repository's source.

| | |
| --- | --- |
| [getting-started.md](getting-started.md) | Install an agent — or three — sign in, run a first session; keyboard; troubleshooting |
| [interface.md](interface.md) | Every surface of the window, and why each is shaped the way it is |
| [agents.md](agents.md) | Which copy of an agent runs, where the model list comes from and why it is sometimes wrong, and multiple accounts |
| [agent-capabilities.md](agent-capabilities.md) | What each agent declares it can do, surveyed out of the running app — a control it has no answer for is not drawn |
| [message-queue.md](message-queue.md) | Typing while the agent works — what Enter does in every case |
| [background-tasks.md](background-tasks.md) | Work an agent starts that outlives the turn, and how each agent reports it |
| [multi-agent.md](multi-agent.md) | Hand-offs, `/race`, rooms, and every board and channel flow across vendors |
| [context-usage.md](context-usage.md) | The ring beside the model: how full the window is, and — where the agent can say — with what |
| [usage-dashboard.md](usage-dashboard.md) | Every plan's limits and what the month cost, on one screen |
| [browser-control.md](browser-control.md) | The browser inside the window, and which agents get its tools |
| [data-boundaries.md](data-boundaries.md) | What leaves this machine, per lane — today, nothing but what you send an agent |

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
| [decisions.md](decisions.md) | The nine choices everything else follows from, each with the rule a reviewer can apply |
| [diagrams/](diagrams) | The architecture as a diagram — typed JSON source, rendered to one self-contained interactive page |
| [design-system.md](design-system.md) | Tokens, primitives, patterns — generated from the source by `pnpm design:doc`; never edited by hand |
| [design.md](design.md) | The type scale, ink levels, row rhythm, and when a row earns a second line |
| [../assets/brand/README.md](../assets/brand/README.md) | The mark, the icon spec measured against macOS itself, and what blue is not |

[decisions.md](decisions.md) states the nine choices everything else follows
from — native Codex first with ACP for the rest, Cordis above the agent, a
gateway rather than a fork, writing through the editor plane, one panel system,
capabilities negotiated rather than normalised — each with the rule a reviewer
can apply, plus the one decision that is still open.

## Evidence

Dated measurements against named builds. Nothing on this shelf is evergreen
and nothing on it is promised — each file says what was run, on which
versions, and when, and a newer build owes it nothing.

| | |
| --- | --- |

The capability matrix in
[agent-capabilities.md](agent-capabilities.md) is the same kind of fact: read
out of the running app on a stated date, never asserted.

## The rule

An evergreen guide carries no version snapshot; a dated measurement carries
nothing evergreen. And a documented fact names how it was measured, or links
the code that settles it — a sentence with neither is a sentence nobody can
maintain. The rest of the writing rules are in
[../CONTRIBUTING.md](../CONTRIBUTING.md).

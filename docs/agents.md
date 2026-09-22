# Agents

An **Agent** is *who* does the work: a brief, the most it may do, and the
seats it prefers. A **runtime** is what it runs on — an agent program the desk
has added, such as Codex or Claude Code ([runtimes.md](runtimes.md)). One Agent
can sit on any runtime that can offer it a seat, and one runtime can hold any
number of Agents at once.

## An Agent is a folder

A folder named for the Agent — its id — holds one file, `AGENT.md`: front
matter, then the brief.

```markdown
---
name: Code reviewer
description: Reads a change it did not write and reports every problem it finds, blocking or not.
ceiling: read
answers: [approve, request-changes]
produces: [review]
prefer: [claude-code, codex, cursor]
---

You review a change somebody else wrote. …
```

| Key | What it says |
| --- | --- |
| `name` | What every surface calls it. |
| `description` | One line; the roster shows it under the name. |
| `ceiling` | The most it may do — `read`, `edit`, `publish` or `merge`. A limit, never a grant: see *Held and asked* below. |
| `permission` | The supported legacy spelling — `read`, `publish` or `merge`. Legacy `read` means `edit` on the ceiling ladder. Do not put both keys in one file. |
| `answers` | The verdicts it may give. |
| `produces` | What it leaves behind. |
| `skills` | The skills it expects, by name. Read-only for now. |
| `prefer` | The seats it asks for, in order — at most eight. |
| the body | The brief, handed to the seat once as its standing order. |

A file that will not parse is still listed, with where and why — the parser
(`packages/server/src/agent-def.ts`) names every problem it finds, and a
listing never drops an Agent it could not read.

The four ceiling levels are cumulative:

| Ceiling | Limit |
| --- | --- |
| `read` | Changes nothing. |
| `edit` | May change and commit inside its checkout, but never pushes. |
| `publish` | May also push its own branch and open a pull request. |
| `merge` | May additionally merge the pull request it was asked to merge. |

These are upper bounds, not permission to reset, force, rewrite published
history, or act outside the task. An old `permission: read` file keeps its old
meaning and is translated to `edit`; old `publish` and `merge` keep those
levels. A file with no key is treated as `read` and flagged for review. A file
with both `ceiling` and `permission` is refused, whichever line comes first,
and the error names both lines.

## Three places, one roster

| Where | Whose |
| --- | --- |
| `.harnessdesk/agents/<id>/AGENT.md`, at the top of a project's checkout | The project's, committed with its code: everyone who clones it has them |
| `~/.harnessdesk/agents/<id>/AGENT.md` | Yours, on this Mac |
| Inside the app | Built in; they change only when HarnessDesk does |

The project's Agents come first, then yours, then the built-in ones: an Agent
with the same id in a place that comes first **shadows** the one below. A
shadowed copy is listed where it lives and says what shadows it — never hidden.
A folder opened inside a repository reads its repository's Agents, and a linked worktree
its own branch's, because a project keeps its Agents at the top of its
checkout. The roster is read again whenever a file under any of the three
places changes (`packages/server/src/agent-watch.ts`).

## The nine that ship

| Agent | What it is for | `ceiling` |
| --- | --- | --- |
| Code reviewer | Reads a change it did not write and reports every problem it finds, blocking or not | `read` |
| Security reviewer | Reads a change for the ways it could be abused, and how to close each | `read` |
| Performance reviewer | Reads a change for what it costs in time, memory and I/O, and when that cost shows | `edit` |
| API reviewer | Reads a change for what it does to the interfaces other code and other people rely on | `read` |
| Test reviewer | Judges whether a change's tests would catch it being wrong | `edit` |
| Implementer | Builds the change it is given on its own branch, proves it with the project's checks, and hands it over | `publish` |
| Judge | Compares attempts at the same task, picks one or none, and says why | `read` |
| Researcher | Answers a question from the code and its sources, and writes the answer down with its evidence | `edit` |
| Requirements analyst | Turns a need into requirements that can be built and tested, and later judges whether a change meets them | `edit` |

Code, security and API reviewers and the judge only need to inspect and report,
so they stay at `read`. Test and performance reviewers run checks and write
their evidence; the researcher and requirements analyst write their results,
so those four need `edit`. The implementer may hand over its own branch, so it
has `publish`.

Each names runtimes, not models — `prefer: [claude-code, codex, cursor]` —
because a model name in a file that travels breaks the Agent on every machine
that does not have that model; each machine says which model in its own seats
(below). Their files are in `packages/server/agents/`, starting with
`packages/server/agents/code-reviewer/AGENT.md`, and a test holds each one to
parsing with no problems and seating on the desk's fake runtimes. To change
one, *Customize…* on its page copies it somewhere that comes first.

## Where an Agent sits

A seating tries seats in order and takes the first this machine can offer. The
list is, highest first:

1. a seating's own seats, when it names any;
2. this Mac's seats for the Agent, in `~/.harnessdesk/seating.json`;
3. the Agent's own `prefer`.

Each **replaces** the next rather than merging with it: two ordered lists
merged have an order nobody chose.

`seating.json` maps an Agent's id to its seats on this machine, and is never
committed:

```json
{ "code-reviewer": ["claude-code=opus-5/high", "codex/high"] }
```

A seat is written `runtime`, `=model`, `/effort` and `+thinking`, each part but
the runtime optional — or, for a model whose name the short form cannot carry,
as an object with those four keys. The file is edited on the Agent's page,
under *On this Mac*, and validated on the way in: an entry that does not read
**refuses** its Agent's seating, with where and why, rather than quietly
seating it on the list it replaced; and a file that is not JSON is never
written over (`packages/server/src/agent-seating-file.ts`).

**Refuse, never substitute.** A candidate is passed over when its runtime is
not added or not installed, cannot start, is signed out, has used up its plan
window, does not offer the model or effort asked for, does not answer within
ten seconds, or opens the conversation on something other than what was asked.
When every candidate is passed over, nothing is opened, and the refusal lists
every one with its reason and the one thing that fixes it — *Sign in to
Cursor*, *Add Codex*, *Edit seats for this Mac*.

**A seat passed over leaves nothing behind where its runtime allows it.** Codex
deletes the thread; the Claude Code and Cursor bridges delete what their agents
wrote, which for a conversation nobody spoke in is usually nothing. A runtime
with no way to delete one may keep an empty conversation in its own history;
the desk archives it, forgets it, and the refusal says so for that candidate.

Which seat each Agent would take here is a dry run that opens nothing and asks
each runtime once (`agent/seat/dry` in
`packages/server/src/methods/agents.ts`). Every menu that lists Agents is drawn
from it.

## Starting as an Agent

- **New session** in the sidebar lists Agents above the runtime's own door,
  each with the mark of the runtime it would sit on here. One that cannot be
  seated here stays — greyed, with its reason — and pressing it shows every
  seat it would take and what stands in the way.
- **⌘K** offers *Start as <Agent>* and *Open <Agent>*.
- **An Agent's page** offers *Start a conversation as <name>*.
- **A room's +** offers the project's Agents first; one seated there joins
  under the Agent's name.

A conversation seated as an Agent leads its header and its sidebar row with
the Agent's name; its composer names the seat it took, as read back from the
runtime; and its name card carries the Agent — what it is for, its ceiling,
where it came from, the seat, every seat passed over and why — with *The brief
has changed since this started* once the file has moved on from the one it was
handed. That a conversation was seated as an Agent is remembered until the
desk quits.

**Held and asked.** A seat's effective ceiling is the narrower of its Agent's
ceiling and its seating grant. The current `agent/seat` interface still accepts
the legacy `permission` words; the ordinary app start grants at most the level
that now corresponds to `edit`, so selecting a `publish` Agent does not by
itself grant a publish seat.

*Held* means the runtime control was set when the seat opened and the runtime
reported it back. *Asked* means the standing order carries the limit but the
runtime supplied no reliable control and read-back for that level. Codex maps
`read` to its read-only sandbox and `edit` to its workspace sandbox, with
approval reviewed by the person. The workspace sandbox is narrower than the
ladder's `edit`: it cannot commit, reach the network or listen on a port.
Claude Code plan mode is not a read-only sandbox, so it is not claimed as held.
No runtime is claimed to hold `publish` or `merge` in this phase.

The desk's own tools enforce the effective ceiling whether its chip says held
or asked. That includes calls from delegated children, which keep their root
seat's identity. Runtime-native shell publishing is not intercepted globally,
so an asked seat still depends on its standing order outside desk tools.

## Making your own

- **Save as an Agent…** in a conversation's ⋯ menu: a name, what it is for and
  a ceiling, with the seat the conversation is on as its first. Saved for you,
  it is written under `~/.harnessdesk/agents`; saved to the project, the
  committed file names the runtime alone and this Mac keeps the exact seat in
  `seating.json`. The new brief — a skeleton — opens in the editor.
- **Customize…** on a built-in Agent or one of yours copies it to the project
  or to you, where the copy comes first and shadows the original.
- **Remove…** on a project's Agent or one of yours moves its folder to the
  Trash; the copy it shadowed, if any, is in force again.
- Or write the folder by hand. The roster notices.

A legacy or missing key is flagged in the roster. Follow that row to the Agent
page, then choose **Ceiling → Update…**. A legacy file offers the translated
level or a narrower one; a missing key offers **Keep Read** and **Allow Edit**.
The dialog shows the exact one-line diff before it writes. If the file changes
after that preview, the write is refused rather than retried or overwritten.
A built-in must be customized first. A project Agent's successful update is a
normal uncommitted project diff for its author to review and commit.

## Where to find them

**Agents** in the sidebar opens a window of its own: *All Agents*, then the
open project's Agents, yours and the built-in ones in the rail. The overview
uses the same three sections — *In <project>*, *Yours*, *Built in* — and names
the folder each reads. A row is an Agent's name and what it is for, with its
ceiling and the seat it would take here, or *Can't seat here* and the first
reason; a shadowed copy is muted and says what shadows it; a file that will not
parse says why. Each row opens the Agent's page: its file, with *Open file* and
*Reveal*; its ceiling; its own seats and their state here; *On this Mac*, this
machine's seats, added to, reordered or cleared; what it answers and produces,
and its skills; and its brief's first paragraph, with *Open in editor*.

Every would-be or live Agent seat carries an explicit ceiling chip. Neutral
means held; warning means asked, and both words are written on the chip rather
than conveyed by colour alone. **Settings › Permissions › Ceilings** shows the
four declared holds for each runtime and chooses whether a watched conversation
may open an unheld seat with a warning or must pass it over.

**Settings › Workspaces** opens a page per project — so does *Project
settings* in the sidebar's project menu — listing the project's own Agents and
the folder they are read from.

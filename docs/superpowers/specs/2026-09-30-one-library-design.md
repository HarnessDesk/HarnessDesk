# One Library: what every agent knows, in one place

*2026-09-30. Product design, use cases first: the goal, what the desk has today,
what has to change, and the journeys a person takes. The survey of other tools
behind these choices is analysis of other people's products, so it is kept out
of the repository, as [VISION.md](../../../VISION.md) requires. A second-vendor
design review has been folded in. Nothing here is built yet.*

> **Superseded in part.** The chosen page design is
> [the Library design](2026-10-01-library-design.md), and the phases are in
> [the roadmap](../plans/2026-10-01-library-roadmap.md) (phases 0–4). The
> six-phase list at the end of this document is the earlier order and no
> longer applies. The goal, the principles and the evidence rule below still
> do.

## The goal

**The best place to manage what your agents know, across every agent you use.**
Three kinds of thing count as what an agent knows:

- the **skills** it can load;
- the **rules** it reads before it starts: `AGENTS.md`, `CLAUDE.md`,
  `GEMINI.md`, `.cursor/rules`;
- the **MCP servers** it can call.

"Best" means four claims that a person can check:

1. **One look answers "what does each of my agents know, here?"** That covers
   this machine and this repository, and every kind: skills, rules and servers.
2. **One change reaches every agent it can.** The desk writes it in each
   agent's own format and folder. The answer is a receipt per agent: changed,
   refused and why, or needs a re-check. A batch is never reported as "synced".
3. **Reach is proven, not assumed.** A cell says *loads* only when that agent
   said so. A file sitting in a folder is not enough.
4. **Nothing is lost.** Every write is previewed and audited, and a copy
   someone else wrote is never overwritten without asking.

Today nothing shows a person what each agent has actually loaded, only what
sits in its folders. The desk hosts the agents, so it can ask the ones that
answer, and it can say *loads* only where an agent said so. For an agent that
cannot answer, it says what it can see on disk and labels the rest *not
measured*. That is the advantage this design is built around.

## Principles

These follow from [AGENTS.md](../../../AGENTS.md) rules 3 and 7, and from what
went wrong in the tools surveyed.

- **The agent's own files are the truth at run time.** The desk keeps only two
  things beside them: where each item came from, and the state the person asked
  for. It never keeps a shadow copy that an agent reads instead.
- **Every fact has a basis, and each kind has its own facts.** A basis is
  *reported* (the agent said so), *scanned* (we read the folder) or *expected*
  (our table predicts it). Only *reported* earns the word "loads". The facts
  themselves differ by kind, and are never folded into one word:

  | Kind | Facts, weakest to strongest |
  |---|---|
  | Skill | present → in the agent's catalogue → fired in a conversation the desk stored |
  | Rules file | present → in that agent's load chain for this folder |
  | Server | configured → reported available → signed in → called in a stored conversation |

  Today a server that was only scanned is drawn as `reaches`. That claims too
  much, and it changes. An *Ask it* probe's answer is recorded as *the probe
  said*, which is evidence, not proof of load.
- **Every write is a plan.** Preview, diff, apply, audit, and a backup wherever
  something existing is touched. The `library/plan` and `library/apply` engine
  already does this for skills and servers. Rules join it; they do not get a
  second engine.
- **Translation that loses something says so.** Before anything is applied,
  each agent's result is labelled *exact*, *approximated* or *dropped*, and
  size limits are checked. "Synced" is never printed over a loss.
- **Union, not intersection.** An agent-only feature survives the round trip,
  whether that is a glob-scoped rule or a server with custom headers. Where
  another agent cannot host it, the cell says so.
- **Nothing in an agent's folder is ours to overwrite.** A same-name copy we
  did not write is a conflict, not an update. This is today's manifest rule,
  kept for every kind.
- **Evidence is tied to a build.** An agent update can change which folders and
  files it reads. Evidence is recorded against the agent's version, and a new
  version marks that evidence *needs a re-check*.

## What we have today

This is measured from the code on `main` at `aa261fd10`.

| Capability | Today | Gap |
|---|---|---|
| See skills × agents | **Strong.** Settings › Library: list and matrix, nine reach states, filters, per-agent catalogue tokens, never-fired | — |
| See MCP × agents | Library's MCP kind is scanned from files and drawn `reaches` from that scan alone. Extensions › MCP servers is reported by the runtime, with sign-in and reload | **Two pages, two data sources** for one server, and the Library overclaims |
| Rules (instruction files) | **Nothing.** No surface reads, shows or edits any of them. Codex's import offer carries `AGENTS.md` once, at startup | The biggest gap |
| Project scope | Project skill and MCP folders are *scanned* when a workspace is open. Resolve, remove and restore can act on them | **Install and New skill target user scope only** (`skillWriteRoot`, `mcpWriteTarget`). A repository cannot be given a skill |
| Install between agents | Import, install to every agent missing it, Resolve, New skill — all through a previewed plan | Results are per op, but the page does not present them as a per-agent receipt with a retry |
| Install from a source | None. No GitHub, URL or registry; Codex's own store is reachable only through Extensions | The manifest keeps a free-text `source` for the audit trail, but no pinned upstream and no updates |
| Drift | `differs` and `hollow` states; Resolve picks a winner | No lineage (which copy is the source), no three-way view, no "updated upstream" |
| Turn off without deleting | Codex only (`runtime/skills/setEnabled`). The toggle appears on **two pages**: Skills and the Library sheet | Every other agent: none |
| Why didn't it use X? | Per-skill reach, usage and "Declared by" | No view of what applies to *this folder × this agent* |
| Undo | History of every library write; Restore where the op kept a backup | A plain create keeps no backup, so it has no one-press undo |
| Agents (the noun) | An Agent's `skills:`/`mcp:` allowlist resolves against Library copies, and is reviewed and staged | Edited on the Agent page; the Library can only filter by it |

The settings navigation splits one subject across three places:

- **Agents › Skills** (scoped to the active agent): a list with a toggle, but no
  reach, cost or usage.
- **Agents › Extensions** (scoped to the active agent): the plugin and app
  store, app search, store failures, and MCP sign-in and reload. In practice it
  is Codex-only.
- **Capabilities › Library**: everything cross-agent.

To answer one question, a person has to know which of the three pages holds it.

## Who it is for

- **The person with several agents.** This is the core user. They want the same
  kit everywhere and no surprises.
- **The repository owner.** They want this repo's rules and skills applied to
  whoever works in it, committed beside the code.
- **The skill author.** They write a skill and want to know it fires, in which
  agents, and at what token cost.
- **The Agent builder.** They put together an Agent (the noun) from Library
  items and want to see what it will actually load.

## Use cases

Each use case has a test it must pass. The test describes what the person sees,
not how it is built. They come in three priority tiers, and the phases follow
the tiers.

### First: see it truly

**U1. See everything, here.**
"What does each of my agents know in this repository?"
The Library opens on the open workspace. It shows skills, rules and servers at
both user and project scope, one column per agent, and a basis on every fact.
- *Passes when* a person can answer "will Gemini read this repo's `AGENTS.md`?"
  without leaving the page.

**U9. Why didn't my agent do X?**
*What applies here* is one agent in one folder, including a nested one. It
lists:
- the rules files in that agent's load chain, in order;
- the skills in its catalogue;
- the servers and their status.
Each item carries its basis. *Ask it* runs a throwaway probe turn, and records
the agent's answer as *the probe said*.
- *Passes when* the person can see that a nested `AGENTS.md` was shadowed, or
  that a skill was rejected and why — in the agent's own words, which
  `rejected` already carries.

**U14. An agent updated.**
When an agent's version changes, evidence recorded against the old build is
marked *needs a re-check*. This covers which folders it scans, which rules files
it reads, and what it reported. One press re-checks.
- *Passes when* updating an agent while the Library is open shows what needs
  re-checking, rather than keeping the old answers as if they still held.

### Next: change it safely

**U2. Bring a skill to every agent.**
"Install for all missing" exists today. It gains two things:
- a scope: *me* or *this repo*;
- a receipt per agent after it is applied: changed, refused and why, or
  *stale — Have it look again*.
- *Passes when* no agent is ever reported as done without a re-check, and a
  refusal can be retried on its own.

**U10. Give this repository its kit.**
Project-scope writes put skills into `.claude/skills`, `.cursor/skills` and
their equivalents, rules into the repository, and servers into `.mcp.json` and
its equivalents. Each shows up as an ordinary working-tree change that the
person commits.
- *Passes when* a collaborator who opens the repo on their own desk sees the kit as
  *this repo* rows.

**U15. Open a repository someone else equipped.**
A committed kit is files, not consent. For each item the collaborator sees:
- whether each agent will load it;
- what it needs and does not have: a sign-in, a credential, an approval;
- what their agents cannot host at all.
- *Passes when* a server committed in `.mcp.json` reads *configured — needs
  sign-in* rather than *loads*.

**U3. Write rules once, per place, by choice.**
For one place (this Mac, the repository root, or a nested folder), the person
can choose one file as the source, usually `AGENTS.md`. Each other agent is then
pointed at it:
- *by reference* where the agent supports that. Claude Code's `CLAUDE.md` can
  hold an `@AGENTS.md` import, and Gemini CLI can be told which file names to
  read. These are to be measured per build.
- *by a generated copy* only where it does not. The copy carries a managed
  header and is watched for drift.

This is opt-in per place. A native file can keep agent-only fragments, and it
can stay independent. The preview shows:
- the full load chain before and after;
- *exact*, *approximated* or *dropped* for each agent;
- the size against each agent's limit;
- any import cycle;
- any edit to a shared or global settings file.
- *Passes when* a glob-scoped rule that an agent cannot express is shown as
  *dropped for Codex*, not lost.

**U6. Stay in sync.**
- Upstream changed: "3 updates".
- You edited one agent's copy: "Cursor's copy differs from its source".
The second case gets a three-way view (source, last applied, now) with four
choices: *keep mine*, *take theirs*, *merge* and *stop managing*. A conflict is
never overwritten silently.
- *Passes when* editing a managed copy by hand is noticed on the next scan and
  offered as a choice.

**U5. Install from a source.**
Sources are a GitHub repository or path, a URL, a registry, or an agent's own
store. Before anything is written, the person sees:
- the source and the version, pinned to a tag or commit;
- what the skill can run: scripts, allowed tools, the servers it needs;
- the files that will land, and in which folders.
The source is recorded in the desk's manifest, not injected into the skill's
own text.
- *Passes when* "Check for updates" shows a diff from the pinned version and
  applies it as a plan.

**U16. A change half-applied.**
When some targets of a multi-agent plan succeed and others fail, the receipt
shows:
- which targets changed and which refused;
- the reason for each refusal;
- per target: *Retry*, or *Restore* where a backup exists.
- *Passes when* nothing about a partial failure needs reading the audit log to
  understand.

### Later: optimise and automate

**U7. Turn off without deleting.**
- *Native first:* an agent's own switch where it has one (Codex today).
- *Elsewhere:* an explicit, previewed *remove, with restore* for copies the desk
  owns.

The word *off* appears only after a fresh read of the agent reports the skill
gone. A general "park" that moves agent-owned folders is deferred. It would
dirty repositories, and a running session's catalogue would not change.
- *Passes when* an *off* skill is absent from the agent's next reported
  catalogue.

**U8. Spend context on purpose.**
The cost view exists today. It is relabelled honestly: *not seen in
conversations this desk stored*, not "never used". Token figures carry their
scope. Rules files are sized against each agent's limit. There is no bulk
removal on this evidence alone.

**U4. Adopt the mess I already have.**
A guided clean-up groups:
- duplicates, matched by content;
- empty folders;
- copies that differ;
- rules files that say nearly the same thing in three formats.

For each group the person chooses "one source, the others follow" or "keep
independent". This comes after U3 and U6, which it is built from.

**U11. Author and try.**
*New skill* and *New rule* open an editor. *Try it* starts a scratch
conversation with a chosen agent and reports whether the item fired.

**U12. A new agent, my kit.**
Adding a runtime ends on *Bring your kit*: one plan with everything the new
agent can host, and a list of what it cannot.

**U13. Agents use the Library.**
An Agent's allowlist is picked from Library rows, and a Library row shows which
Agents use it. Removing a skill warns "2 Agents name this".

## One Library: consolidating Settings

**Decision proposed:** skills, rules and servers are one subject, so they get
one home, and Agents › Skills and Agents › Extensions stop being separate pages.

**The condition:** the merge ships only when every runtime operation those pages
offer works in the Library, with the same status and recovery. An agent filter
and an *Add* menu item are not enough on their own.

Inside the Library, an **agent-scoped view** keeps what is genuinely one
agent's:
- its store, app search and store failures;
- server sign-in and reload;
- its hooks;
- its slash commands.

```
Settings
├─ General       General · Appearance · Notifications · Keyboard shortcuts
├─ Conversations Workspaces · Archive
├─ Agents        Runtimes · Models
├─ Capabilities  Library · Plugins
└─ Access        Permissions · Browser
```

| Today | Becomes |
|---|---|
| Agents › Skills (list + toggle) | Library › Skills, filtered to that agent. The native toggle stays on the row and in the sheet |
| Agents › Skills › hooks (read-only) | Library › Hooks: its own kind, shown only when an agent has the `hooks` capability |
| ACP slash commands shown as "Skills & commands" | Library › Skills rows with a *command* chip: read-only, reported, and never counted as skills |
| Extensions › MCP servers (sign-in, reload, status) | Library › Servers. A row joins the scanned file with the runtime's reported status; *Sign in* and *Reload* are on its sheet, and failures are shown there |
| Extensions › Plugins / Apps (an agent's store, search, failures) | The agent-scoped view's **Store** tab, kept whole. It is also offered as a source under **Add** |
| `skills`, `extensions` route ids | Mapped by `resolveSection` to `library`, with that agent's view, so old links still land |

The scoped-to-agent cue on those two nav rows (a `RuntimeMark` trail) becomes
the agent filter at the top of the Library. It is the same fact, placed where
it changes the list.

### The page

```
Library                                         [Add ▾]  [Check for updates]
Where  [ This Mac · HarnessDesk (repo) ]     Agents  [ All ▾ ]   🔍
──────────────────────────────────────────────────────────────────────────
 Skills 42 · Rules 6 · Servers 9 · Hooks 3              [ List | Matrix ]
 ⚠ 2 don't reach Gemini · 1 rule over Codex's size limit · 3 updates  Review
──────────────────────────────────────────────────────────────────────────
 brainstorming        superpowers@4.2  ●●●○  in 3 catalogues of 4   ›
 AGENTS.md            this repo        ●●◐●  Claude via @import     ›
 github               configured       ●○●–  1 needs sign-in        ›
 ...
```

- **Where** is the scope switch: this Mac (user scope) and the open repository
  (project scope). The default is both, each labelled by scope.
- **Agents** filters the list, and picking one agent opens its agent-scoped
  view.
- **The kind tabs** each carry a count.
- **The attention strip** appears only when there is something to act on. It
  always ends in one verb.
- **A row** follows rule 9: the name, a chip for its source or scope, and a
  reach summary in that kind's own words. Its sheet opens behind `›`.
- **The sheet** has five sections:
  - *Overview*: what it is, its source and version, which Agents name it.
  - *Reach*: per agent and per scope, with basis, verify and toggle.
  - *Content*: rendered or source; editable for rules and for skills the desk
    authored.
  - *Usage*: seen in, sessions, tokens per turn.
  - *History*: every write, with Restore where a backup exists.

### The Rules tab

Rules are files at a place, not named items, so the tab is drawn by **place**:
this Mac, the repository root, and each nested folder that has one. Under each
place there is one row per file. Each row has a column per agent, saying
whether that agent reads it, with its basis.

**What applies here** is the same data turned on its side: pick any folder and
an agent, and see the files in the order that agent loads them. A row at the
repository root cannot answer a nested-folder question, so this view is the
primary way in.

**Make one source…** is offered per place, never globally. Its plan works in
four steps:
1. It proposes `AGENTS.md` as the source.
2. It adds a reference for each agent that can follow one.
3. It adds a managed copy for each agent that cannot.
4. It ends with the before-and-after load chain, the compatibility table, the
   size check and the diff.

### Should the Library leave Settings?

At 100 rows by 10 agents, with diffs, history and a three-way merge, the
Library is a workspace, not a short settings page. Agents already set the
precedent: it has a window of its own, opened from the sidebar, in the
AppWindow shell. Both reviews of this design lean toward a window. See
decision 1.

### Outside Settings

The Library should be reachable from the work itself:

- **The composer's skill picker.** A skill that another agent has and this one
  does not shows as *Not loaded by <agent> — Install…*.
- **A fired skill in the transcript** links to its Library row.
- **The conversation's context ring.** Its menu gains *What applies here*,
  prefiltered to that conversation's agent and folder.
- **Adding a runtime** ends on *Bring your kit*.

## What has to change, in order

The review changed this order. The read model comes first because every write
has to be explained by it. Moving pages before the core question can be
answered would add risk to navigation without adding the answer.

1. **See it truly (read only).** U1, U9 (read), U14.
   - A rules location table in `packages/agent-inventory`, beside skills and
     MCP. It covers user, project and nested scope.
   - A `rules` kind in `library/read`, carrying load chain and reach per agent.
   - **Per-kind facts.** Server rows join `runtime/mcp/list`, so that
     *configured*, *available* and *signed in* are separate facts, and scanned
     servers stop being drawn `reaches`.
   - Evidence recorded with the agent's version, so that a version change marks
     it for re-check.
   - A measured table of which build reads which file. Rule 7 applies: it is
     measured by asking each build in a temp `$HOME`, never by grepping the
     binary — the `~/.agents/skills` lesson.
   - *What applies here* for any folder and agent.
2. **One home.** The consolidation above. It ships only when Extensions' store,
   search, failures, sign-in and reload all work in the agent-scoped view.
   The route ids are mapped.
3. **Change it safely.** U2, U10, U15, U16.
   - Project-scope targets for install and New skill.
   - A per-agent receipt with retry and restore.
   - "Committed is not consented": the facts a collaborator needs about a kit
     someone else committed.
4. **Rules, written.** U3.
   - `linkRules`, `generateRules` and `editRules` intents in the existing
     engine, opt-in per place.
   - Per-agent `exact | approximated | dropped`, size limits, cycle detection,
     and a warning before any shared settings file is edited.
5. **Sources and updates.** U5, U6.
   - A structured `source` on manifest entries: kind, location, pinned ref,
     content hash. Today it is only a free-text string.
   - `library/sources/*` to resolve and preview a GitHub or URL source.
   - An update check, and a three-way drift state.
   - A review of scripts and required tools before install.
6. **Optimise and automate.** U7, U8, U4, U11, U12, U13.
   - Native toggles, plus remove-with-restore for owned copies.
   - Honest usage wording.
   - Guided clean-up, *Try it*, *Bring your kit*, and allowlists picked from
     the Library.

Every phase ships on the existing preview harness with fixture libraries. Each
phase is verified on the four-agent sandbox rig against real agent builds
before it is called done.

## Decisions for the owner

1. **Where the Library lives.**
   - *Option A:* keep it a Settings page, with Skills and Extensions folded in.
   - *Option B:* give it a window of its own from the sidebar, as Agents has,
     with Settings linking to it.
   - *Recommendation:* B. Both reviews lean that way, because it is a
     workspace. Either way, the fold happens in phase 2.
2. **The canonical rules format.**
   - *Recommendation:* `AGENTS.md` plus references, opt-in per place, so the
     desk invents no format of its own (rule 3).
   - *Alternative:* a desk-owned intermediate format that compiles to each
     agent's files. It is more expressive, but it builds our own world beside
     theirs.
3. **Where desired state lives.**
   - *Recommendation:* local only, in `~/.harnessdesk/library/manifest.json`
     as today. A repository's kit is the native files committed in it, which
     keeps desk-specific files out of the repository.
   - *Alternative:* add an optional committable manifest for collaborators.
4. **Which sources come first.**
   - *Recommendation:* GitHub repositories and paths first, then an agent's own
     store, which already works for Codex. Public skill and MCP registries come
     after.

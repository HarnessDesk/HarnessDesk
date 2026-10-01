# Cross-agent skill management: every use case

*2026-10-01. The complete list of what a person can do with skills across the
agents on their desk. It follows the order they meet things, starting from the
moment their agents are signed in. It is the input to the UX design that comes
next. It extends
[2026-09-30-one-library-design.md](2026-09-30-one-library-design.md), which
holds the goal, the principles and the phase order. A survey of other tools sits
behind it; that survey is kept out of the repository, as
[VISION.md](../../../VISION.md) requires. Rules files and MCP servers appear
only where their journey differs from a skill's.*

## How to read an entry

Each use case answers seven questions:

| Field | Question it answers |
|---|---|
| **Who · when** | Who it is for, and the situation they are in |
| **Wants** | What they want |
| **Desk** | What HarnessDesk does — today, or as proposed (marked *new*) |
| **Agents today** | What each support tier can do, measured or not (next section) |
| **If not** | What the desk does where an agent cannot |
| **Worked when** | What the person sees that proves it worked |
| **Priority · needs** | `must`, `should` or `later`, and the IDs it depends on |

There are three rules from [AGENTS.md](../../../AGENTS.md) that every entry
obeys:

- **Rule 3 — the agent owns its world.** Skills live in each agent's own
  folders. The desk reads them and writes into them; it never keeps a copy an
  agent reads instead.
- **Rule 8 — the UI never names a runtime.** The UI asks what an agent *can*
  do (its capabilities), never which agent it is.
- **Rule 7 — parity is measured.** A claim about what an agent can do is worth
  only what the measurement behind it is worth.

## What agents support today

The desk can host 16 agents: Codex natively, and 15 over ACP. Grouped by what
the code knows about each, they fall into three tiers. Each tier is a set of
capabilities, not a list of brands. The UI decides from the capability flags,
never from a name.

Each fact carries one of three kinds of evidence:

- **asked:** the running agent reported it.
- **build:** the path string was found in the shipped binary (2026-08-28). This
  is weaker than *asked*. The `~/.agents/skills` row showed a build can contain
  a path it does not load. A *build* fact is never presented as a confirmed
  load.
- **table:** written into our code with no measurement behind it.

| Tier | Agents (as of 2026-10-01) | Skill folders | Catalogue | Rejections | Native on/off | Re-read | MCP status |
|---|---|---|---|---|---|---|---|
| **A — reports and switches** | Codex 0.149 | user + project, **asked** (2026-09-06) | its skill list, **asked** | yes, in its own words, **asked** | yes, **asked** | live, **asked** | from the runtime, **table** |
| **B — known folders, commands only** | Claude Code, Cursor, Gemini CLI, DeepSeek harness | user + project, **build** | slash commands only, **table** | — | — | commands only, by restarting while idle, **table** | through the agent's CLI, **table** |
| **C — unknown folders** | OpenCode, OpenClaw, Hermes Agent, Cline, CodeBuddy Code, Kimi CLI, pi, Grok Build, GitHub Copilot, Antigravity, Devin | unknown | slash commands only, **table** | — | — | commands only, by restarting while idle, **table** | through the agent's CLI, **table** |

**Rules files.** Nothing is known, for any tier. No agent's set of rules files
(`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules`) has been measured.

**What the evidence locations are.** The location table is
`packages/agent-inventory/src/locations.ts`. The capability flags are
`RuntimeCapabilities` in `packages/protocol/src/runtime.ts`. An ACP agent's
catalogue is its advertised slash commands, mapped in
`packages/adapter-acp/src/runtime.ts`.

**This table is itself a deliverable.** It belongs on the screen, as the basis
of each cell, and it improves only by measuring (see *Measurements owed*,
below). A tier B agent becomes tier A for a fact only after a build of it has
answered for that fact.

The UI needs four capability facts that are not flags today. It must gate on
these, never on a brand:

| Capability | Meaning |
|---|---|
| `reportsCatalogue` | The agent lists the skill bundles it loaded, not just its commands |
| `reportsRejections` | The agent says which skills it refused, and why |
| `skillToggle` | The agent has its own switch to turn a skill off |
| `catalogueRefresh: 'live' \| 'restart' \| 'none'` | How the agent re-reads its skills |

The tiers are a way to read this document, never a code path. *Facts, not
buttons* comes from whether a writable location is known for that agent, and
*no skill support* comes from an observed capability. Neither comes from a
tier label.

## 1 · First look

**F1 · See which skills each agent has, and where each came from**
- **Who · when:** anyone with two or more agents, on their first visit or any
  later one, with a repository open or none.
- **Wants:** every skill, under every agent, with its scope (*this Mac* or
  *this repository*), its folder, and its origin. The origin is one of: added
  by the desk, found already there, from a source, or from a repository commit.
- **Desk:** today, the Library shows skills × agents and a reach state for each
  cell. *New:* a scope column, an origin chip, and the basis of every cell
  (asked, build or table).
- **Agents today:** A — folders and catalogue asked. B — folders from the
  build; catalogue is commands only. C — commands only; no agent-specific
  folder is known.
- **If not:** a tier C agent gets its own column. It shows its commands and the
  words *folders not measured*; empty cells are never drawn as *absent*.
- **Worked when:** for any skill, the person can say which agents have it, at
  which scope, and how we know.
- **Priority · needs:** must · —

**F2 · See what needs attention**
- **Who · when:** anyone, when some copies differ, are empty, were rejected, or
  need a re-check.
- **Wants:** one honest count, with a reason and one verb for each.
- **Desk:** today there is an attention strip. The *Problems* filter does not
  warn on `unscanned` alone, but it does include an entry no agent reaches.
  *New:* it also counts
  updates, partial failures and evidence that needs a re-check.
- **Agents today:** *rejected* comes only from A. Every other state comes from
  disk, for A and B.
- **If not:** nothing is counted as a problem for an agent whose folders are
  unknown.
- **Worked when:** every number, when clicked, shows exactly that many rows.
- **Priority · needs:** must · F1

**F3 · Tell an empty library from a failed scan**
- **Who · when:** a new user, or a machine whose agent did not answer.
- **Wants:** to know whether there is nothing there, or the desk could not
  look.
- **Desk:** today, an agent that cannot answer is recorded as a gap and
  falls back to disk; it is never an empty list (the listSkills lesson).
  *New:* the empty state says which of the two it is, per agent.
- **Agents today:** all tiers can fail to answer.
- **If not:** the agent shows as *could not ask*, with the reason, and the disk
  copies are labelled *scanned*.
- **Worked when:** stopping an agent never turns its column empty.
- **Priority · needs:** must · F1

**F4 · Switch place and agent**
- **Who · when:** someone moving between repositories, or into a subfolder.
- **Wants:** the same view for *this Mac*, for *this repository*, and for any
  folder inside it.
- **Desk:** today, project scope is scanned only for the open workspace. *New:*
  a place switch and an agent filter.
- **Agents today:** project folders are asked for A, from the build for B, and
  unknown for C.
- **If not:** a project folder that is not measured shows as *probably read*,
  with that evidence.
- **Worked when:** switching place changes the rows and nothing else.
- **Priority · needs:** must · F1

## 2 · Understanding what they have

**U1 · Tell presence, catalogue and use apart**
- **Who · when:** anyone looking at a single cell.
- **Wants:** to know whether the skill is *on disk*, *in the agent's
  catalogue*, *rejected*, or *seen firing in a stored conversation*. These are
  four separate facts.
- **Desk:** today there are nine reach states with a basis
  (`reported`/`scanned`), plus a usage reader for fired skills. *New:* these
  ladders are shown per kind, as defined in the one-library design.
- **Agents today:** A can reach *catalogue*. B and C stop at *on disk*, or at
  the command if the skill also surfaces as one. Usage comes from stored
  transcripts, by detecting `/<name>/SKILL.md` path mentions. How well that
  works for each tier is not measured.
- **If not:** the ladder stops at the last fact that can be shown, and says
  why.
- **Worked when:** no cell says *loads* unless the agent said so.
- **Priority · needs:** must · F1

**U2 · Know how old the evidence is**
- **Who · when:** someone looking at a cell scanned days ago, or under an
  earlier agent version.
- **Wants:** where the evidence came from, when, and against which build.
- **Desk:** *new.* Evidence is stamped with the agent's version and time.
- **Agents today:** a version is reported when the runtime discovers one. It is
  optional, and an ACP agent can return none.
- **If not:** an agent that reports no version is shown as *build unknown*.
- **Worked when:** hovering any cell shows its source and age.
- **Priority · needs:** must · U1

**U3 · Inspect one skill**
- **Who · when:** someone who sees the same name in several places.
- **Wants:** its content, files, scope, version, origin and owner, and the
  scripts it can run.
- **Desk:** today there is the skill sheet, with a rendered or source view of
  `SKILL.md` (`library/definition`). *New:* bundle files, scripts, origin and
  owner.
- **Agents today:** this is read from disk, so it works for any tier.
- **If not:** —
- **Worked when:** two copies with the same name can be told apart without
  opening a terminal.
- **Priority · needs:** must · F1

**U4 · Same name, different skill**
- **Who · when:** two unrelated skills share a name, across agents or scopes.
- **Wants:** to see which one each agent loads, and never have one replace the
  other by accident.
- **Desk:** today the `differs` state exists, and an install never overwrites a
  copy the desk did not write. *New:* the desk shows by content when the two
  are unrelated, and presents them as two rows rather than one row that
  differs.
- **Agents today:** A asked. B from disk only.
- **If not:** both copies are shown, with *which one loads is not measured*.
- **Worked when:** installing a third copy with that name asks the person
  before writing.
- **Priority · needs:** must · U3

**U5 · A project skill shadows a user skill**
- **Who · when:** someone working in a repository that has its own copy of a
  skill they also have at *this Mac* scope.
- **Wants:** to see which copy wins, for each agent.
- **Desk:** *new.* Precedence for each agent, shown on the row and in *What
  applies here*.
- **Agents today:** A reports the skill, but which copy wins is inferred from
  our table's scan order (the scan-order chips), not asked. B and C:
  precedence is not measured.
- **If not:** both copies are shown as *present*, with *precedence not
  measured*.
- **Worked when:** the person can say which copy the agent will use before
  they start a conversation.
- **Priority · needs:** must · F4, U3

**U6 · What applies here**
- **Who · when:** someone in a conversation with one agent, in one folder.
- **Wants:** that agent's skills, its rules files in load order, and its
  servers and their status.
- **Desk:** *new.* *What applies here* is opened from the conversation's
  context ring, or from the Library.
- **Agents today:** skills — A asked, B from disk. Rules — unknown for every
  tier. Servers — A from the runtime, B from config.
- **If not:** each part says how much of it is measured. Rules show as *files
  present*, and the load order is marked *not measured* until it is.
- **Worked when:** the person can see that a nested `AGENTS.md` was shadowed.
- **Priority · needs:** must · F4, U1

**U7 · Why didn't it use my skill?**
- **Who · when:** a skill author whose skill never fires.
- **Wants:** to know which of these it was: never invoked, not in the
  catalogue, rejected, or not relevant to the task.
- **Desk:** today, *rejected* shows the agent's own words, and *stale* offers
  *Have it look again*. *New:* a diagnosis panel that walks the ladder.
- **Agents today:** A can show catalogue, rejection and stored-transcript
  evidence. Nothing signals *not relevant to the task* for any tier. B can show
  *on disk* and *fired*.
- **If not:** the panel says which steps it cannot check for this agent.
- **Worked when:** the panel ends in one cause, or names the one check left to
  run.
- **Priority · needs:** should · U1

**U8 · What skills cost**
- **Who · when:** someone watching context use.
- **Wants:** an estimate of tokens per turn for each agent, and which skills
  were not seen used.
- **Desk:** today there is catalogue tokens per agent and a never-fired
  filter. *New:* the label changes to *not seen in conversations this desk
  stored*, and the estimate shows its scope.
- **Agents today:** the estimate is built from the names and descriptions of
  skills on disk, summed only over cells drawn as reaching. Whether it covers
  command-only or unknown-folder catalogues is not established. Usage covers
  only the agents the desk stored conversations for.
- **If not:** an agent whose catalogue is unknown shows no estimate rather than
  zero.
- **Worked when:** no figure is read as a fact it is not.
- **Priority · needs:** should · U1

**U9 · Commands are not skills**
- **Who · when:** someone using an ACP agent whose catalogue is its slash
  commands.
- **Wants:** to see those commands, without them being counted as skills.
- **Desk:** *new.* Commands appear as their own chip or kind, read-only, and
  are left out of skill counts and costs.
- **Agents today:** B and C advertise commands. A has a real skill list.
- **If not:** —
- **Worked when:** the skill count for a B agent equals the skills on disk,
  not its commands.
- **Priority · needs:** must · F1

## 3 · Getting skills in

**I1 · Discover: search what I already have**
- **Who · when:** someone who remembers a skill's purpose, not its name.
- **Wants:** to search names, descriptions and content across every agent and
  scope.
- **Desk:** today, search covers names. *New:* descriptions and content too.
- **Agents today:** disk, any tier.
- **If not:** —
- **Worked when:** a search for a word that appears only in a description
  finds the skill.
- **Priority · needs:** should · F1

**I2 · Discover: browse sources**
- **Who · when:** someone looking for a skill they do not have.
- **Wants:** to browse and search a source, see what each skill does and who
  publishes it, then install.
- **Desk:** *new.* Sources are a GitHub repository or path, a URL, a public
  registry, or an agent's own store.
- **Agents today:** A has a plugin and app store, in Extensions. Whether it can
  serve as a skill source is not verified. B and C have none.
- **If not:** the desk's sources work for every tier, because they write into
  the agent's folders.
- **Worked when:** finding a skill and installing it is one path, with no
  terminal.
- **Priority · needs:** should · I4

**I3 · Copy a skill to agents that lack it**
- **Who · when:** one agent has a skill and the others do not.
- **Wants:** to install it for one, several or all of the agents that can
  host it.
- **Desk:** today: *Install for…*, *Install to all N missing* and *Import* — a
  previewed plan. An install refuses a differing copy it does not own. A
  backup is kept wherever a replace or remove would lose data.
- **Agents today:** A and B can be written to. C cannot be, because it has no
  folder row.
- **If not:** a C agent gets facts, not buttons: *where this agent keeps skills
  is not known yet*.
- **Worked when:** see I8 and I9.
- **Priority · needs:** must · U3

**I4 · Install from a source, pinned**
- **Who · when:** someone installing from GitHub, a URL, a registry or a store.
- **Wants:** to see the files, choose a version (tag or commit), and know
  where the skill came from later.
- **Desk:** *new.* The source and pinned ref are recorded in the desk's
  manifest, never injected into the skill's text. Today the manifest keeps
  only a free-text `source`.
- **Agents today:** as for I3.
- **If not:** as for I3.
- **Worked when:** the skill's sheet names its source and version a month
  later.
- **Priority · needs:** should · U3

**I5 · Review before it can run**
- **Who · when:** someone about to install, or update, a skill that contains
  scripts, needs tools or brings servers.
- **Wants:** to see what it can do before it can do it.
- **Desk:** *new.* The review lists scripts, allowed tools, servers and
  network use. Anything risky has to be read before *Install* is offered.
- **Agents today:** this is read from the content, so it works for any tier.
- **If not:** —
- **Worked when:** a skill with a shell script cannot be installed without the
  script being shown.
- **Priority · needs:** must · I4

**I6 · Choose the scope**
- **Who · when:** someone deciding whether a skill is personal (*this Mac*) or
  belongs to the project (*this repository*).
- **Wants:** to choose the scope before anything is written.
- **Desk:** today, install and *New skill* write at user scope only. *New:* a
  scope choice on every install.
- **Agents today:** the project folder is asked for A and from the build for
  B. C has none.
- **If not:** project scope is offered only to agents whose project folder is
  known.
- **Worked when:** a project install shows up as a working-tree change in the
  repository.
- **Priority · needs:** must · F4, I3

**I7 · Check fit before applying**
- **Who · when:** someone installing into agents with different formats or
  limits.
- **Wants:** to see, before applying, which targets cannot take the skill and
  which would be too large.
- **Desk:** today, `unhostable` exists for MCP. *New:* skill fit — frontmatter
  each agent rejects, size, missing tools — shown as *fits*, *fits with
  changes* or *cannot*.
- **Agents today:** A asked — Codex's rejection errors are its rules, in its
  own words. B is unknown.
- **If not:** *fit not measured*; the person can still apply, and the receipt
  re-checks.
- **Worked when:** a skill missing a `description` is flagged for A before it
  is written.
- **Priority · needs:** must · I3

**I8 · A receipt for every agent**
- **Who · when:** someone who has just applied a plan across several agents.
- **Wants:** to see, for each agent, whether it changed, was refused (and
  why), or needs a re-check.
- **Desk:** today `library/apply` returns a result per op, and one failure
  never aborts the rest. *New:* the receipt view, with *Retry* and *Restore*
  on each target.
- **Agents today:** all tiers can be written to, as far as their folders are
  known.
- **If not:** —
- **Worked when:** a partial failure can be understood without opening the
  audit log.
- **Priority · needs:** must · I3, I7

**I9 · Prove it loaded**
- **Who · when:** someone looking at a receipt whose files were all written.
- **Wants:** each agent to confirm it now has the skill.
- **Desk:** today, the `stale` state and *Have it look again*
  (`runtime/refreshCatalog`). *New:* the re-check runs as the receipt's last
  step.
- **Agents today:** A re-reads live, asked. For B and C, a restart while idle
  refreshes their *commands*. That does not show the skills on disk were
  re-read, so B can confirm only that the skill is on disk.
- **If not:** the receipt says *written — this agent cannot confirm it
  loaded*. It never says *installed*.
- **Worked when:** every target ends in *loads* (A) or an honest weaker word.
- **Priority · needs:** must · I8

**I10 · Write my own skill**
- **Who · when:** a skill author with nothing that fits.
- **Wants:** to write a skill, choose its agents and scope, and save it.
- **Desk:** today, *New skill* writes `SKILL.md` for the chosen agents. *New:*
  scope, and the fit check from I7.
- **Agents today:** as for I3.
- **If not:** as for I3.
- **Worked when:** the new skill reaches I9's *loads* in every agent that can
  confirm it.
- **Priority · needs:** should · I6

**I11 · Import my own folder**
- **Who · when:** someone with skills in a folder, an archive or a repository
  of their own.
- **Wants:** to bring them in without retyping anything.
- **Desk:** *new.* Choose a folder; the desk finds every `SKILL.md` and
  offers them as one plan.
- **Agents today:** as for I3.
- **If not:** as for I3.
- **Worked when:** a folder of 10 skills becomes one previewed plan.
- **Priority · needs:** should · I3

**I12 · Adopt what is already installed**
- **Who · when:** someone whose skills were put in place by hand or by another
  tool.
- **Wants:** the desk to manage them from now on, without rewriting them.
- **Desk:** *new.* *Manage this copy* records it in the manifest as found,
  with its digest. Nothing is written into the agent's folder.
- **Agents today:** disk, A and B.
- **If not:** —
- **Worked when:** an adopted copy that is later hand-edited is caught by K2.
- **Priority · needs:** should · U3

## 4 · Keeping them right

**K1 · Sync one skill across agents**
- **Who · when:** someone who wants a skill identical everywhere.
- **Wants:** one copy to be the source and the others to follow it, or the
  copies to stay deliberately independent.
- **Desk:** today, *Resolve* picks a winner and syncs it (`syncSkill`). *New:*
  the lineage is remembered, so a later change offers to follow.
- **Agents today:** as for I3.
- **If not:** as for I3.
- **Worked when:** the `differs` count drops to the copies the person chose to
  keep independent.
- **Priority · needs:** should · U3, K2

**K2 · Someone edited a managed copy**
- **Who · when:** the person or another tool changed a copy the desk wrote.
- **Wants:** to keep the edit, replace it, merge, or stop managing the copy.
- **Desk:** *new.* A three-way view: source, last applied, and now. Today the
  manifest digest notices edits to the definition (`SKILL.md`), but not to
  the bundle's other files. *New:* a digest of the whole bundle.
- **Agents today:** disk, any tier the desk wrote to.
- **If not:** —
- **Worked when:** a hand edit is never overwritten without the person
  choosing to.
- **Priority · needs:** must · I12

**K3 · Format differences**
- **Who · when:** a skill written for one agent that is wanted in another
  whose rules are different (frontmatter fields, size, supporting files).
- **Wants:** to know what changes, or what would be lost, in each agent.
- **Desk:** *new.* The fit check from I7, applied whenever a copy moves
  between agents. It is per-agent *exact*, *approximated* or *dropped*.
- **Agents today:** only A states its rules (asked). The rest are unknown.
- **If not:** *fit not measured*, and the receipt re-checks.
- **Worked when:** nothing is lost in a copy without the person seeing that it
  was.
- **Priority · needs:** must · I7

**K4 · Updates from a source**
- **Who · when:** a skill installed from a source whose upstream has changed.
- **Wants:** to see that an update exists, read the diff, review what it can
  now run, then apply it.
- **Desk:** *new.* An update check against the pinned ref, followed by I5's
  review and a plan.
- **Agents today:** as for I3.
- **If not:** as for I3.
- **Worked when:** an update that adds a script cannot be applied without
  showing that script.
- **Priority · needs:** should · I4, I5

**K5 · Repair a missing or broken copy**
- **Who · when:** a managed copy was deleted, or its folder is empty (`hollow`).
- **Wants:** to put back only that one copy.
- **Desk:** today, *Clean up* handles empty folders. *New:* *Repair* rewrites
  the managed copy from its source or from the last applied version.
- **Agents today:** disk, any tier the desk wrote to.
- **If not:** —
- **Worked when:** repairing one agent touches no other agent's folder.
- **Priority · needs:** should · I8

**K6 · Retry a partial failure**
- **Who · when:** a receipt where some targets were refused.
- **Wants:** to retry those targets alone.
- **Desk:** *new.* *Retry* on the receipt re-plans only the refused targets.
- **Agents today:** any tier.
- **If not:** —
- **Worked when:** a retry never rewrites a target that already succeeded.
- **Priority · needs:** must · I8

**K7 · Try it**
- **Who · when:** a skill author whose skill is in the catalogue but has never
  fired.
- **Wants:** to see whether a chosen agent uses it.
- **Desk:** *new.* *Try it* starts a scratch conversation, prompts for the
  skill, and records whether it fired, using the usage detector. The result is
  stored as *probe said*.
- **Agents today:** all tiers can hold a conversation. The detector counts
  `/<name>/SKILL.md` path mentions, so it cannot see a skill that was inlined.
  How well it covers each tier is not measured.
- **If not:** —
- **Worked when:** the author learns which agents fire it, in one place.
- **Priority · needs:** should · U7, I9

## 5 · Turning off, removing, undoing

**O1 · Turn a skill off, keep it**
- **Who · when:** someone with a skill that is noisy, conflicts with another,
  or is not wanted in this project.
- **Wants:** the skill off for one agent, without deleting it.
- **Desk:** today, `runtime/skills/setEnabled` does this for A, and the switch
  sits on two pages. *New:* one switch, and the word *off* is shown only after
  the agent's next report agrees.
- **Agents today:** A has a native switch (asked). B and C have none.
- **If not:** the switch is not offered. O2 (remove, with restore) is offered
  instead, for copies the desk owns. A copy someone else owns gets facts, not a
  button.
- **Worked when:** an *off* skill is missing from the agent's next catalogue,
  and its token estimate drops.
- **Priority · needs:** should · I9

**O2 · Uninstall from one agent, or all**
- **Who · when:** someone who no longer wants a skill.
- **Wants:** it gone from the chosen agents and scope, and from nowhere else.
- **Desk:** today, *Remove* runs a plan with a backup.
- **Agents today:** as for I3.
- **If not:** as for I3.
- **Worked when:** removing the *this repository* copy leaves the *this Mac*
  copy in place, and the reverse.
- **Priority · needs:** must · U5

**O3 · Never remove what isn't mine without asking**
- **Who · when:** a bulk action that would touch a copy the desk did not write.
- **Wants:** to be asked about that copy, not to have it swept up silently.
- **Desk:** today, the manifest rule applies: foreign copies need `backup:
  true` and a confirmation. *New:* foreign copies are listed separately in the
  plan.
- **Agents today:** any tier.
- **If not:** —
- **Worked when:** a bulk remove names every foreign copy it would touch.
- **Priority · needs:** must · U3

**O4 · Roll back**
- **Who · when:** someone whose update or change made things worse.
- **Wants:** the previous version back.
- **Desk:** today, History with *Restore* wherever the op kept a backup. A plain
  create keeps none. *New:* undoing a create is offered as removing it, and
  rolling back an update restores the last applied version.
- **Agents today:** any tier the desk wrote to.
- **If not:** —
- **Worked when:** every write in History has an undo, or says why it does
  not.
- **Priority · needs:** must · I8

**O5 · A skill turns out to be malicious**
- **Who · when:** a skill that is now suspect is installed for several agents.
- **Wants:** to see every agent and scope that has it, take it out everywhere,
  and confirm it is gone.
- **Desk:** *new.* *Find every copy*, matched by content hash, not name. Then
  one plan to remove them all, and a re-check.
- **Agents today:** disk, any tier. Confirmation as in I9.
- **If not:** an agent that cannot confirm is listed as *removed from disk —
  restart this agent*.
- **Worked when:** the plan finds renamed copies too.
- **Priority · needs:** must · U3, O2, I9

## 6 · Sharing with collaborators

**T1 · Equip a repository**
- **Who · when:** a repository owner who wants every contributor's agents to
  carry the project's skills.
- **Wants:** project-scope skills written into each agent's project folder,
  ready to review and commit.
- **Desk:** *new.* I6 at project scope, for every agent that can host it. The
  change shows up in the repository's changes view.
- **Agents today:** A asked, B from the build, C unknown.
- **If not:** the plan lists which agents' contributors will not get the
  skill, and why.
- **Worked when:** the commit contains only native files, never a desk file.
- **Priority · needs:** should · I6, I10

**T2 · Open a repository someone else equipped**
- **Who · when:** a collaborator opening a repository whose committed skills they
  never chose.
- **Wants:** to see what their agents will load from it, and to agree before
  trusting it.
- **Desk:** *new.* *This repository brings…* shows each skill with I5's
  review. Committed skills are present, which is not the same as agreed.
- **Agents today:** an agent loads project skills by itself, and the desk
  cannot stop that (rule 3). A seated Agent refuses to seat only when its
  runtime cannot be stopped from auto-loading unapproved content. Other
  unsupported declarations become per-item problems.
- **If not:** the desk shows plainly what will load. It does not pretend it
  can block it.
- **Worked when:** a collaborator sees a committed script before their first
  conversation in that repository.
- **Priority · needs:** must · U3, U6

**T3 · Different agents across collaborators**
- **Who · when:** an owner whose collaborators use different agents and builds.
- **Wants:** to know which collaborators' agents the kit reaches.
- **Desk:** *new.* The plan for T1 shows per tier which agents get the skill,
  which cannot host it, and which are not measured.
- **Agents today:** the tiers table.
- **If not:** —
- **Worked when:** the owner can tell a collaborator which agents lack the kit.
- **Priority · needs:** should · I7, T1

**T4 · Review a change to the kit**
- **Who · when:** a reviewer of a commit that changes a project skill.
- **Wants:** to see what changed in behaviour: scripts, tools, the agents it
  reaches.
- **Desk:** *new.* I5's review, run on the diff, from the repository's changes
  view.
- **Agents today:** this is read from content, so it works for any tier.
- **If not:** —
- **Worked when:** a newly added script stands out in review.
- **Priority · needs:** should · I5, T1

**T5 · Take my kit to another machine**
- **Who · when:** someone setting up a second Mac.
- **Wants:** the same skills, with the same sources and pins.
- **Desk:** *new.* Export the kit — sources, pins, and the content of authored
  skills. Import it as one plan.
- **Agents today:** as for I3.
- **If not:** as for I3.
- **Worked when:** the new machine's Library matches the old one, apart from
  agents that are not installed there.
- **Priority · needs:** later · I4

**T6 · A new agent, my kit**
- **Who · when:** someone who has just added a runtime.
- **Wants:** everything the new agent can host, in one step.
- **Desk:** *new.* Adding a runtime ends with *Bring your kit*: one plan, plus
  a list of what the agent cannot host.
- **Agents today:** as for I3 and I7.
- **If not:** a C agent gets *where this agent keeps skills is not known yet —
  measure it*.
- **Worked when:** every hostable item reaches I9.
- **Priority · needs:** should · I3, I7

## 7 · Edge states

**E1 · An agent isn't installed**
- **Who · when:** someone with a runtime registered on the desk whose binary is
  gone, or one that was never added.
- **Wants:** its skills still visible, with no reach that cannot be confirmed.
- **Desk:** today, a registered agent that cannot answer becomes a gap, and its
  copies fall back to disk. An agent never added has no column. *New:* the
  column is headed *not installed*, its cells are labelled *on disk*, and
  writes are refused with *Install it first*.
- **Agents today:** any tier.
- **If not:** —
- **Worked when:** an uninstalled agent's skills are listed, and nothing claims
  that they load.
- **Priority · needs:** must · U1

**E2 · An agent is signed out**
- **Who · when:** someone whose agent has lost its sign-in.
- **Wants:** to see that the disk facts still hold and that the agent cannot
  confirm anything right now.
- **Desk:** today, being signed out is not treated specially in `library/read`.
  *New:* the column shows *signed out*. Files can still be written. A re-check
  waits until the agent is signed in again, and the reason is linked to *Sign
  in*.
- **Agents today:** any tier. Whether an agent can list its skills while
  signed out is not measured.
- **If not:** —
- **Worked when:** the receipt for a signed-out agent says *written — sign in
  to confirm*.
- **Priority · needs:** must · I9

**E3 · Offline**
- **Who · when:** someone with no network.
- **Wants:** everything that works on this machine to keep working.
- **Desk:** *new.* Source browsing, update checks and registry search say
  *offline*. Inventory, install between agents and history work as normal.
- **Agents today:** reading the inventory is local, for every tier.
- **If not:** —
- **Worked when:** offline, only the network actions are greyed out, each with
  its reason.
- **Priority · needs:** should · U2, I4

**E4 · An agent with no skill support**
- **Who · when:** an agent whose `skills` capability is off.
- **Wants:** to see that it is *not supported*, not that it has no skills.
- **Desk:** *new.* A column headed *no skill support*, with no cells and no
  install offers.
- **Agents today:** an ACP agent's `skills` flag is false until its commands
  arrive. That means *not yet known*, not *unsupported*, so the column reads
  *skill support unknown* until the flag is settled.
- **If not:** —
- **Worked when:** such an agent is never counted as missing a skill.
- **Priority · needs:** must · U1

**E5 · An agent updated**
- **Who · when:** an agent whose version changed, possibly changing where it
  looks.
- **Wants:** to know which evidence is now old, and to re-check it.
- **Desk:** *new.* Evidence from the old build is marked *needs a re-check*,
  with one press to re-check.
- **Agents today:** any tier that reports a version.
- **If not:** *build unknown* (U2).
- **Worked when:** an update never leaves old answers showing as current.
- **Priority · needs:** must · U2

**E6 · A write is refused by the system**
- **Who · when:** a target folder that is read-only, or managed by a policy.
- **Wants:** the exact refusal, with the other targets unaffected.
- **Desk:** today, one failure never aborts the rest. *New:* the reason is
  shown on the receipt.
- **Agents today:** any tier.
- **If not:** —
- **Worked when:** see I8.
- **Priority · needs:** must · I8

**E7 · A conversation started before the change**
- **Who · when:** someone changes a skill while a conversation is open.
- **Wants:** to know whether that conversation sees the change.
- **Desk:** *new.* An open conversation whose agent re-reads only on restart
  shows *skills changed — this conversation has the old set*, with the step
  that refreshes it.
- **Agents today:** A re-reads live. B and C re-read only by restarting while
  idle.
- **If not:** —
- **Worked when:** nobody is surprised that a running conversation ignored a
  new skill.
- **Priority · needs:** should · I9

## 8 · Rules, servers and Agents

**R1 · Rules files per place**
- **Who · when:** anyone with `AGENTS.md`, `CLAUDE.md` or similar in their home
  folder, a repository or a subfolder.
- **Wants:** to see which files exist at each place, and which agents read
  each one.
- **Desk:** *new.* A Rules kind, laid out by place.
- **Agents today:** unknown for every agent. This is the first measurement
  owed.
- **If not:** *present*, with *who reads it is not measured*.
- **Worked when:** see U6.
- **Priority · needs:** must · F4

**R2 · Write rules once, by choice**
- **Who · when:** a rules author keeping three files that say the same thing.
- **Wants:** one source per place, with the other files following it.
- **Desk:** *new.* *Make one source…*, opt-in per place: references where an
  agent can follow one, managed copies where it cannot, and *exact /
  approximated / dropped*, size and cycles shown in the preview.
- **Agents today:** unknown. Whether each agent can follow a reference has to
  be measured first.
- **If not:** a managed copy, watched as in K2.
- **Worked when:** nothing is lost without being shown in the preview.
- **Priority · needs:** should · R1, K2

**R3 · Is a server ready?**
- **Who · when:** someone with a server in an agent's configuration.
- **Wants:** to know whether it is *configured*, *available*, *signed in* and
  *called*.
- **Desk:** today, the Library shows only what is configured, and draws it as
  reaching. Status lives on the Extensions page. *New:* both are joined into
  one row.
- **Agents today:** A — status from the runtime. B and C — through the agent's
  CLI, where the code has it (table).
- **If not:** *configured*, with *status not reported*.
- **Worked when:** a server that needs sign-in never shows as reaching.
- **Priority · needs:** must · U1

**R4 · A committed server needs my credentials**
- **Who · when:** a collaborator whose repository's `.mcp.json` names a server
  that needs a key or a sign-in.
- **Wants:** to know what is missing, without anyone else's secret being
  carried in.
- **Desk:** *new.* The row shows *needs sign-in* or *needs a value for
  X_API_KEY*, and links to where that is supplied.
- **Agents today:** as for R3.
- **If not:** —
- **Worked when:** a committed server reads *configured — needs sign-in*.
- **Priority · needs:** must · R3, T2

**A1 · Agents name Library skills**
- **Who · when:** an Agent builder.
- **Wants:** to pick an Agent's skills from the Library, and to see which
  Agents name a skill before removing it.
- **Desk:** today, the allowlist is edited on the Agent page and resolves
  against Library copies, and the Library has a *Declared by* filter. *New:*
  the allowlist is picked from Library rows, and each row shows which Agents
  use it.
- **Agents today:** this is the desk's own noun, so it works for any tier.
- **If not:** —
- **Worked when:** removing a skill warns that two Agents name it.
- **Priority · needs:** should · F1

## Priorities at a glance

**must, read first (phase 1 of the one-library design):**
F1–F4, U1–U6, U9, R1, R3, E1, E2, E4, E5.

**must, change safely (phases 2–4):**
I3, I5–I9, K2, K3, K6, O2–O5, T2, R4, E6.

**should:** U7, U8, I1, I2, I4, I10–I12, K1, K4, K5, K7, O1, T1, T3, T4, T6, E3,
E7, R2, A1.

**later:** T5.

## Measurements owed (rule 7)

Each of these is measured the same way the `~/.agents/skills` question was:

- a temporary `$HOME` holding fixtures;
- the agent's real build, asked through its own interface;
- the answer recorded with the version.

Reading a binary for a path string does not count.

| # | Measurement | Unlocks |
|---|---|---|
| 1 | The rules files each agent reads, and in what order, at user, project and nested scope | R1, R2, U6 |
| 2 | For each tier B agent: does a skill bundle on disk reach its catalogue, and how can we ask it (beyond its commands)? | U1, I9, the move from tier B to tier A |
| 3 | Project-scope precedence over user scope, for each agent | U5, O2 |
| 4 | Each agent's limits on `SKILL.md`: required fields, size, files — what it refuses | I7, K3 |
| 5 | Where the tier C agents keep skills | moving tier C into tier B |
| 6 | Re-read behaviour: what makes each agent reload its skills, and whether an open conversation sees the change | I9, E7 |
| 7 | MCP configuration and status, for each agent | R3, R4 |
| 8 | Whether a signed-out agent can still list its skills | E2 |

The UX design comes next. It will offer two or three options, each shown as
real mockups from the preview harness. It goes to the owner for approval before
any code is written.

# The decisions this is built on

The choices that shape everything else. Each is
stated as it stands today, not as it was argued — what the code does, and what
it costs to keep doing it. Where a decision has a rule a reviewer can apply,
the rule is the last line of its section.

---

## Insight measures remain source-qualified

Historical usage is read from runtime-owned local records rather than quota
balances, current context occupancy, or a guessed allocation. The host keeps
opaque source identity and missing-field information through the wire, so an
explicit zero is distinct from an unavailable value. Reads do not refresh
evidence or mutate a wrapped receipt.

---

## One foundation and one public UI vocabulary

Every first-party surface is downstream of one design system. The editable
foundation lives in `packages/ui/src/design/foundation`; generic interactive
controls are Base UI-backed shadcn-style source in `design/ui`; HarnessDesk
compositions live in `design/patterns`; and specialized renderers cross only
the explicit contracts in `design/adapters`. Features import the public
`design/index.ts` vocabulary instead of reaching into those layers.

This replaces the former split between Kit, shadcn/Radix controls, and local
overlay implementations. The cost is intentional constraint: a feature that
needs a new generic state changes the canonical component or adds a named
pattern before it changes a screen. In return, one edit propagates to Settings,
conversation, rooms, tools, the live catalog, portals, editor and terminal
bridges, and the generated native About foundation.

The constraint is executable. `script/check-ui-system.mjs` reconciles every
tracked UI-producing file, rejects legacy or alternate headless imports, and
requires catalog coverage; `script/design-audit.mjs --strict` refuses every
style-system finding and any non-zero saved baseline.

**The rule:** product features compose the public design API; they do not own
generic controls, overlay behavior, or foundation values.

## Native Codex first, ACP for everything else

The native Codex adapter is the primary, deep path. ACP is a second adapter
behind the same `AgentRuntime` interface, and everything that is not Codex
arrives through it.

Codex's app-server carries things a generic protocol has nowhere to put:
account rate limits and credit balance, per-server MCP startup status, the
skills list, permission profiles, turn-level aggregated diffs, per-model
reasoning-effort options, and paginated access to transcripts that routinely
run past three hundred items. Routing those through a common protocol flattens
them away.

Two adapters is the cost, and it is paid once: `packages/adapter-codex` speaks
the app-server, `packages/adapter-acp` speaks ACP, and nothing above either of
them knows which is running.

**The rule:** a capability is not dropped because only one adapter can carry it.

## Cordis is the extension kernel, above the agent

Plugins run on `@deepseek-ai/cordis`, depended on rather than reimplemented,
and the kernel sits **above** `AgentRuntime` as a plane orthogonal to it —
never inside an agent.

That position is what makes the two planes independent: a plugin registered
once is usable by every agent, and an agent added once can use every plugin.
A kernel living inside one agent would tie every plugin to that agent's
lifecycle and give the others nothing.

**The rule:** a plugin never imports an adapter, and an adapter never imports
the kernel.

## Other models reach Codex through a gateway, never a fork

Where Codex has to talk to a model that is not OpenAI's, it goes through a
local translating gateway. HarnessDesk carries no long-lived fork of Codex.

*Long-lived* is the word that matters. Cutting a branch to confirm an upstream
bug, or to run a patch while a fix is in review, is ordinary engineering. What
is refused is a capability whose existence depends on a private fork somebody
has to keep rebasing — a cost paid every week, by whoever is holding it,
forever, and invisible in any single week.

**The rule:** if a feature needs a patched Codex to work, it is not a feature
yet.

## DeepSeek Harness joins over ACP, and its plugins stay in its own profile

DSH is an ACP agent, at the ACP level — not a native adapter — and its plugins
are surfaced rather than adopted.

The deeper seam is worse where it matters most here. HarnessDesk has a stop
button, and over DSH's SDK protocol stopping means killing the runtime, where
ACP has `session/cancel`. HarnessDesk has one approval surface across every
agent, and that protocol cannot ask a question at all, where ACP has
`session/request_permission`. And it makes no compatibility promise and
negotiates no version, where `adapter-codex` earns its depth against a
versioned contract with a drift check behind it.

Its plugins stay where they are because a DSH plugin is bound to *DSH's*
services, not to Cordis alone — running one here would mean reimplementing
DSH's session model. The seam that works is the one DSH itself uses: the
profile.

**The rule:** depth is worth having only against a contract that promises
something.

## Writing a file belongs to the editor plane

Three halves, and they are genuinely different:

1. **No write tool is projected to agents.** The `files` built-in is
   read-only, and that is an invariant with a test against it rather than a
   default nobody examined.
2. **Plugins write through `ctx.editor.applyEdits`** — gated by `editor` *and*
   `workspace.write`, confined to the open roots, and landing in a pane the
   person can see.
3. **Privilege cannot be laundered through a plugin.** A write reached by an
   *agent* calling a plugin is refused, whatever that plugin was granted.

Agents still edit files; they do it through their own tools, under their own
approval flow, which is the surface a person already watches.

*Open where this meets the vision:* "visible in a pane" assumes a pane, and a
person in front of it. Work that starts from a pull request or a schedule has
neither. The principle that survives is that a write is **attributable and
reviewable** — which is a stronger requirement than a visible pane, not a
weaker one — but what stands in for the pane when nobody is watching is not
designed yet.

**The rule:** every write is visible in a pane before it is on disk.

## One panel system, and a feature never knows where it is

*Scope: the desktop client.* This decision and the one after it are about how
a window is arranged. They are not control-plane decisions, and a web or
mobile surface is not bound by them — what those surfaces owe is the same
context, policy and history, not the same four edges.

Four areas — sidebar, main, right, bottom — and one vocabulary behind all of
them:

```
area    a place a panel can live: sidebar, main, right, bottom
view    a mounted feature, as data — the PaneView union
dock    a stack of views along an edge, one shown, with a size
zoom    one area given the room, at one of two scopes
```

The currency is `PaneView`, the union the split tree already stored, so a
feature is mounted into an area rather than built for one. Changes can be the
right panel's tab, the bottom panel's tab, or a docked section under the
session tree, and the component cannot tell which.

**The rule:** the controls belong to the panel, never to what is inside it.

## A plugin declares where its UI may dock

The plugin declares the set of areas its panel may live in, the person chooses
within that set, and the host enforces it:

```ts
ctx.ui.register({
  slot: 'sidebar.panel',
  mounts: ['right', 'bottom'],   // the first is where it opens
  label: 'Coverage',
  component: 'hd.panel',
})
```

A plugin that only makes sense in one place says so and gets one place. A
plugin that would work anywhere says that instead, and the person decides.
Neither can put itself somewhere the host did not agree to.

**The rule:** placement is negotiated at registration, never at draw time.

## A narrow window lays things over the conversation

*Scope: the desktop client's renderer, as a browser draws it.* The desktop
window cannot be narrower than 720px, and at its ordinary zoom every width it
can take keeps the four areas side by side. A browser goes below that — a
phone, a tab dragged thin — and so does the desktop app zoomed in, whose width
is counted in CSS pixels; and there the sidebar's 240px column left the
conversation 135px: a composer wrapping its placeholder a word to a line, a
title one pixel wide.

Below 720px the sidebar floats over the conversation instead, and a panel on
the right takes the conversation's width while it is open. Three things were
chosen rather than defaulted:

- **The line is the desktop window's own minimum**, not a width picked for
  phones, so at its ordinary zoom no width the desktop app can take lays
  anything over anything. Zoomed in, it crosses the line like any narrow
  window, and that is right: everything on it is bigger too.
- **The floating sidebar is a state of its own**, beside the column's.
  Folding the column away on the way down and back on the way up would have
  been one flag, and it would have lost the person's choice both ways: a
  column put away in a wide window is still put away when the window is wide
  again, and a narrow window never opens the sidebar over the conversation
  because the column happened to be up when it narrowed.
- **Over the floating sidebar, one Escape closes one thing.** It hears the
  key on the window, after everything inside it, and stands aside for any
  handler that marks the key spent with `preventDefault` — a menu, a filter
  field, a rename, a window opened over it. What it covers — the workbench's
  content and the notices floating over it — is inert while it is open, so
  the covered pane's own keys, an approval's Escape among them, cannot answer
  for it. A toast is drawn above it and stays in reach, an error's as well
  as one that leaves on its own: it is so often the answer to something done
  in the sidebar. Settings and Usage hold the rule the same way, from the same
  stack: `lib/overlays.ts` answers Escape on the window, after every menu on the
  document, so a menu open inside either window takes the key and the window
  stays — and the window marks the key spent, so this sidebar stands aside when
  one is open over it.

**The rule:** a window too narrow for a column covers the conversation rather
than squeezing it, and only when asked.

## Capabilities are negotiated, not normalised

`RuntimeCapabilities` is a flat set of booleans an adapter declares about
itself — resume, fork, steer, interrupt, reasoning, metered, skills, hooks and
the rest; `packages/protocol` holds the current list. The desk reads them and
draws accordingly: a control for something a runtime cannot do is not
rendered, and one for something it can is.

The interface is the **union** of what the agents offer, presented per agent —
never the intersection presented once. The intersection is how a multi-agent
client becomes a lowest-common-denominator chat window, with every agent
reduced to the weakest in the set and each new agent making the product
smaller.

A capability may have exactly one implementor and that is fine. It does not
have to be general to be real.

**The rule:** gate on `runtime.capabilities`, never on `runtime.id`.

## The row is the fallback; the machine decides which copy runs

An `agents.json` row names a command, and that command is what runs when
nothing better is found. Before every start the host looks for every copy of
the agent on the machine, asks each for its version, and runs the newest one
that is new enough — or the one the person pinned.

A download the desk made is a copy like any other, ranked by version, and the
only copy the desk will update itself. The app's PATH is the terminal's PATH:
the login shell is asked once at start, and the well-known install folders that
exist are appended.

*Open where this meets the vision:* "the machine" is unambiguous while there is
one. Once work can run somewhere else, resolution has to happen where the agent
will actually run rather than where the window is — and a pin made on a laptop
means nothing to a runner that has never seen that laptop's disk. The rule
below still holds; *which* machine answers it does not have an answer yet.

**The rule:** the row is a fallback, not an instruction.

## A pull request is published through the desk, and the desk signs it

A vendor's own client signs the pull requests its agent opens — "Generated
with Claude Code" — and the signature is what tells a reviewer which tool,
on which model, wrote what they are reading. An agent driven from this desk
signed as nothing, or as the client it was not running in.

The first answer was to *tell* the agent: an instruction in the person's own
message, once per conversation, asking it to end any pull request with the
line. It was wrong as product design. The sentence was in the conversation
as a block the person never wrote and had to read past; it relied on the
agent obeying; and it named what it could see — "Gemini CLI Auto" is not a
model. Nobody's client works that way. Claude Code signs a pull request
because *Claude Code opens it*.

So the desk opens it. The Git plugin's `pr_create`, `pr_update` and
`pr_review` tools reach GitHub with the person's own `gh`, exactly as the
agent's shell would, and add the two things a shell cannot: the signature,
rendered for the seat that made the call, and the record of the publication
in the transcript, drawn as the object it is. The seat — agent, model,
effort, in the agent's own labels, with the agent's automatic choice counted
as no model — is a fact about the conversation, and the host is the one party
that knows it; a plugin reads it through `ctx.forge`, which stamps who asked
and refuses a call that rides no live invocation, as the team plane does.
The signature is a template in the Git plugin's settings, with placeholders
for the seat and its parts and a default of “🤖 Generated with
[HarnessDesk](https://harnessdesk.app) ({seat})”; a person who wants a
different line writes it there, and a blank line signs nothing. The agent is
told one sentence, through its own instruction layer — Codex's developer
instructions, a bridge's system-prompt append, the MCP server's
`instructions` — never through the conversation, and the sentence names the
tools rather than the line.

*Not done here:* an agent that reaches for `gh pr create` itself, ignoring
the sentence, opens an unsigned pull request that the transcript does not
record. Watching its commands for the verb would catch it, at the cost of
tying the feature to one CLI; the honest fix is the same one the vendors
made, which is to make the desk's way the easy way. A GitHub App the desk
installs later is a second way to reach the forge (`ForgeIdentity.via`), and
changes nothing above it.

**The rule:** the party that publishes writes the signature; the desk
publishes.

## Where a conversation runs is chosen on the draft, and made on send

A new conversation's place — the open folder, a worktree the project already
has, or a new one — is a control in the composer, shown only while the
conversation is a draft. The choice is held on the draft (`draftPlace`), and a
new worktree is cut by the host when the first message goes, not when it is
chosen.

The alternative was the one the app had: a worktree made the moment its button
was pressed, with a conversation started in it. That cannot be previewed,
cancelled or shown — there is nothing to show until it exists, and once it
exists, abandoning it leaves a branch and a folder behind. Holding the choice
costs one field on the draft and one branch in `newSession`. Once a
conversation exists the choice is a fact, the header's git control states it,
and the composer control is gone, so the two never say the same thing.

The way back is a checkout, not a merge. `worktree/bringHome` checks the
worktree's branch out in the main checkout and removes the worktree. Git will
not check out a branch two trees hold, so the order is forced: uncommitted work
is refused rather than discarded, and a checkout git refuses puts the worktree
back from its branch — naming what git ignores there, which `git status` never
counted and the removal took — or, when git will not allow even that, says the
folder is gone rather than claiming it stayed. Only worktrees HarnessDesk made,
of a repository opened here, are moved, as only they are removed. A
conversation cannot change folders, so the one that lived there is carried to
the main checkout by a hand-off. A send whose agent fails to start keeps the
worktree it cut, and the draft then points at it, so a retry does not cut a
second; a draft abandoned after that leaves the worktree, listed with the others.

**The rule:** nothing is made on disk for a conversation that has not been
sent, and nothing git tracks is discarded to bring work home — what it ignores
goes with the folder, and the dialog says so first.

## A Codex profile is a bounded new-session input, not another configuration

Codex's app-server cannot take the CLI's profile flag, but each thread verb can
take configuration overrides. HarnessDesk therefore declares the available
profile names as one ordinary new-session option. With **None** selected it
sends nothing new. With a profile selected, the adapter reads that file when
the conversation starts and carries only its root `model`,
`model_context_window`, and `model_auto_compact_token_limit` values.

The file is input, never a program: its name, byte count, UTF-8, strings and
integers are bounded; commands, instructions, MCP tables and every other key
remain inert. A malformed profile stays in the list with its refusal instead
of disappearing. This is deliberately narrower than asking Codex to load the
whole profile, which would execute capabilities the person did not choose on
this surface.

The values sent are not facts about the resulting conversation. The live
model comes from the thread response, and the context ring remains empty until
Codex reports its context window in usage. A profile can ask; only Codex can
say what landed.

**The rule:** profiles may contribute bounded start parameters; session state
comes back from the agent.

## Provenance preserves a defensible association

A commit's author, message and trailers do not authenticate the Seat that made its changes. HarnessDesk associates only the patches explained by locally observed diff facts and the original Seat record. Stable and verbatim fingerprints must agree; surviving file changes can retain partial attribution through an amend. A squash compares its net change with bounded observed ranges and keeps every defensible contributor. Competing explanations, overlapping contributions that cannot be separated and unavailable source objects remain unattributed.

Passive capture cannot recover a ref move whose reflog and objects Git no longer retains. The desk reads available transitions, preserves known gaps and says when capture is degraded or stopped. It installs no hooks, changes no Git configuration and never delays a turn to observe it.

**The rule:** ambiguity remains visible; a rewritten association never refreshes the original checks, reviews or evidence.

## A Goal is finite; Seats and receipts are the authority

Rooms accumulated three competing truths: a member array, the conversations
the host happened to hold, and Seat evidence. Goals keep the useful surface —
board, channel and roster — but make the durable records authoritative. An open,
non-restored Seat establishes membership. Assignment and Release are serialized
host transactions; the renderer refreshes the resulting Goal instead of
splicing a member into local state.

Isolated Goal work receives a durable lane: retained checkout, disjoint port
block and, by default, its own persistent browser partition. The host injects
the lane environment into each agent invocation. Wrapping takes a reviewed
snapshot and journals the receipt before cross-store settlement, so replay is
idempotent and later mutation is refused. Backup restore deliberately removes
execution authority: journals are cleared and lanes are released archives.

**The rule:** active work is derived from open Seats; finished or restored work
is read-only history.

## A cloned tree is hostile; the person's own processes are not

A project's `.harnessdesk` arrives with a clone, so its flows, Agent folders,
planted links, hard links, odd names, oversized files and malformed YAML are
the repository's, not the person's. That static tree is the threat. Another
process running as the same person, swapping folders between two calls, is
not: it can already write anything the person can, and Node's path-only fs
API cannot close that race anyway, so the code does not pretend to.

Every read and write the flow catalogue, the flow update, its journal and the
Agent files it creates make goes through one module, `confined-tree.ts`. It
resolves the root once and pins its identity, so an update previewed against
one folder is refused against a folder that replaced it. Every open below the
root uses macOS's `O_NOFOLLOW_ANY`, which refuses a link at any component.
Where that flag does not exist, reads walk each component without following
it, and every write fails closed with a refusal rather than falling back to a
last-component `O_NOFOLLOW`. A file is replaced by writing a synced sibling,
checking that the target still holds the previewed bytes (or already holds
the new ones), renaming the sibling over it and syncing the folder. It is
never truncated in place, a person's edit since the preview is kept, and a
crash leaves the old bytes or the new ones, which the update journal, written
the same way, can replay.

**The rule:** no fs call on a project path bypasses the confined tree, and no
write there happens on a platform without an any-component no-follow open.

## An evidence guard judges revisions, found by card and revision, never by round

A finished round's rule asks whether some work is good enough to move on,
and the facts that answer are filed all over the run: a check on the check's
own card, a judge's review on the judge's card, an observed diff or pull
request on the writer's card with no round at all. The first version asked
for a fact on the *subject's own card, in the finished round* — a join no
fact the desk records ever satisfied, so every guarded rule waited forever,
and a judge sitting in a clean Goal checkout was even taken for the thing
being judged.

So a guard judges *subjects*, and a subject is a revision: the head, read
now, of the nearest cards back along `dependsOn` whose grant lets them change
files and whose Agent does not produce reviews. A judge or reviewer is never
a subject, whatever its grant; a check or a
person round is walked through. The facts that may speak for a subject are
those filed on any card that walk crossed — which is what scopes a fact to
this run — at the subject's own revision, fresh, and observed here. The last
observation of each question decides. Review guards are judged first and may
single out one candidate every required reviewer (the finished round's own
Seats) chose; every other guard is then judged at that revision. A writer
whose checkout is dirty is kept as unsettled and waits, rather than being
dropped from "every subject". The same walk, started from a card's own
`dependsOn`, gives a check its fan-out width and a reviewer its candidates.
Every durable append to the evidence store wakes waiting guards; a message
never does.

**The rule:** a fact counts for a rule by the card it is filed on and the
revision it names, never by the round number it carries, and never for a
checkout that could not have changed.

---

## A declared attachment is a catalogue name, never an executable spec

An Agent's `skills:`/`mcp:` lines name entries by identifier, not by command
or path. Reading a cloned repository's `AGENT.md` and the `skills/` folder
beside it starts no process and runs no script; it only ever produces the
identities and bytes a person reviews before anything is trusted to load.
Agent-local content is hashed whole — every referenced script and resource,
not only `SKILL.md` — and bound to the repository's own incarnation, the
Agent's origin and id, that bundle's digest, the runtime build and the
effective ceiling; any one of those changing means review again. An external
MCP server is classified `merge` by default, whatever a repository or the
server's own tool annotations claim, and is only ever reached through the
desk's own gateway, which can identify and gate every call — a runtime never
holds a server's real address. A runtime that cannot suppress its own
unapproved auto-loading for one Seat is refused outright before any session
exists, never seated unscoped and hoped honest.

**The rule:** trust and classification are host-computed from what was
actually read, never taken from a repository's own claim about itself, and a
runtime that cannot honor a Seat's declarations fails that seating in its own
words rather than falling through to a different one nobody announced.

---

## A Seat freezes its attachments; nothing it loaded can change after it opens

What a Seat's runtime loads is decided once, at open, from the Agent's
declarations as they stood then — not re-read on reconnect, not widened by a
later approval, not narrowed by an edit to the Agent's file. `prepare` runs
before a runtime session exists so the isolated input it is given can
actually reflect what was decided; `record` durably appends one epoch to
that Seat's own append-only history only after the runtime's own readback
says what it loaded, so a Seat's history is what was *observed*, never what
was merely requested. A later reconnect or resume revalidates those same
frozen inputs and appends a new epoch; it never re-derives from the Agent's
current wishes. History persists after a Seat closes and after a restart,
and a restored (backup-imported) epoch is marked so and never reads as a
live "currently loaded" — retention is a fact about the past, not a
standing grant.

**The rule:** a Seat's attachment record is append-only and observed, never
rewritten and never optimistic; "declared, not loaded", "loaded" and "not
recorded" are three different facts and no code path collapses one into
another to look tidier.

---

## A memory citation retains bytes before the Goal ever references them

Citing a wrapped Goal's committed memory file into another Goal is a person
action, never an automatic link: `.harnessdesk/memory/<slug>.md` is ordinary
committed prose, and a citation names a full commit, a literal path and the
exact wrapped receipt a person selected — "Source selected by you", never a
claim the file itself makes about its own origin. Retention is
durable-before-reference: the exact bytes, the source Goal's receipt and the
Seats that were there are written to content-addressed storage first, and
only a successful write is ever referenced from the citing Goal's own index —
a failure past that point leaves at most an unreferenced object, never a
citation pointing at nothing. The source Goal, its checkout or the whole
desk that made it may later disappear; the retained copy still resolves,
honestly labeled `Source Goal unavailable` or `Original revision
unavailable` rather than silently going quiet. None of this grants a tool,
moves an evidence column, or lets a citation someone merely restored from a
backup satisfy a dependency a live Goal never actually earned.

**The rule:** retention happens before the Goal mutation that references it,
a citation is data a person carries on purpose, and no archived or restored
record may authorize dispatch, membership or tools by itself.

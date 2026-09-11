# The decisions this is built on

Eleven choices that shape everything else. Each is
stated as it stands today, not as it was argued — what the code does, and what
it costs to keep doing it. Where a decision has a rule a reviewer can apply,
the rule is the last line of its section.

---

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

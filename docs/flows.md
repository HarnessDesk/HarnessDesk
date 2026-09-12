# Flows

A room is a shared board with a **human referee**: somebody decides who does
what, moves work between agents, reads results, and takes the irreversible
steps. A **flow** is that referee's policy written down instead of performed —
a named set of roles, the rules that move work between them, and the seeding
prompt each role is handed — so a team of agents can run a full loop (do the
work → have it reviewed → act on the verdict → repeat until it passes) with the
person choosing exactly which steps stay theirs.

It configures the third way of cooperating in
[docs/multi-agent.md](multi-agent.md) §1. It is not a fourth.

---

## Where a flow lives

```
.harnessdesk/
  flows/
    fix-and-review.yml
    race.yml
```

In the repository it serves, which is a decision rather than a detail. A flow
there is versioned with the code it governs, reviewed like code, diffed when it
changes, and shared by everyone who clones — which is the difference between a
team habit and a team tool. It also means a flow can be **proposed in a pull
request**, which is the right way for a team to change how its agents work.

A flow can also be started from text that was never written to disk. The file
is the shareable form.

**Across projects.** A flow serves the repository it sits in, and somebody with
five repositories will want one `review-pr.yml` rather than five copies. Today
that is a copy, or a symlink, and the engine does not care which: it reads the
text and never asks where it came from. The library plane is the obvious place
for a shared one and is deliberately not being reached for yet — a flow names
seats, and a seat that exists on one machine and not another is exactly the
kind of sharing that has to be designed rather than assumed.

---

## The model, in one paragraph

A **role** is who does a kind of work. A **round** is N sibling cards of one
role, opened together, where N is that role's `count`. A **rule** fires when a
round finishes, reads its outcomes, and opens a round of another role that
*depends on* the one that ended — which is how the finished round's context
packages reach the new one, because the board already hands a claimant
everything its dependencies left behind. A round that matches no rule ends the
run.

That makes this a **statechart** — states, transitions, guards — and not a
pipeline. n8n, Node-RED and Zapier are data-flow graphs: a payload travels
along edges through transforming nodes, and the graph is a DAG. Here a node is
a round of work held by a role, an edge is a rule with a guard, and it loops:
review sends work back to fix, which comes back to review.

---

## The file

```yaml
# Anything after a # is a comment, and the file is yours to write by hand.
name: Fix and review
description: One fixer, three reviewers, and the merge stays yours.

# What the person fills in when they start it. Every {{slot}} in a template
# is one of these or a built-in (below).
inputs:
  work:
    label: What to fix
    default: ""

# Seconds one `await_work` call blocks before it answers "nothing yet". A seat
# loops on that answer inside its one turn, so this is how often it says so —
# not how long it may wait. Optional; 240 by default.
wait: 240

roles:
  fixer:
    kind: agent                       # agent | person | check
    seat: cursor=gpt-5.3-codex/xhigh  # runtime[=model][/effort][+thinking]
    count: 1                          # how many cards a round of this opens
    permission: publish               # read | publish | merge
    outcomes: [published, cannot]     # the only words it may answer
    order: |
      What this role is for, in your words. The loop scaffolding and the git
      rules are generated around it, so this is only the brief.

  reviewer:
    kind: agent
    seat: cursor=gemini-3.8-flash/high
    count: 3
    permission: read
    outcomes: [approve, request-changes]

  referee:
    kind: person                      # a step the human takes
    outcomes: [merged, dropped]

seed:
  role: fixer
  title: "{{work}}"
  detail: |
    {{work}}

rules:
  # Tried in file order; the FIRST match fires. So the unhappy branch is
  # written first: one reviewer asking for changes sends the work back however
  # many approved.
  - id: review-it
    on: fixer
    when: { every: published }
    then:
      role: reviewer
      title: "Review round {{round}} — {{n}} of {{count}}"

  - id: fix-again
    on: reviewer
    when: { any: request-changes }
    then: { role: fixer, title: "Answer round {{round}}'s reviews" }

  - id: hand-to-the-person
    on: reviewer
    when: { every: approve }
    then: { role: referee, title: "Merge it — every reviewer approved" }

# Where a visual builder keeps node positions. The engine never reads it.
layout:
  fixer: { x: 40, y: 40 }
```

### Roles

| key | what it is |
| --- | --- |
| `kind` | `agent` seats a conversation. `person` opens a card addressed to you. `check` runs a command. |
| `seat` | `runtime[=model][/effort][+thinking]`, or a **list** of them — one per card of the round, which is how a race runs two different models. Required for `agent`, refused for the others. |
| `count` | How many cards a round of this role opens. Defaults to the number of seats listed. |
| `permission` | `read`, `publish` or `merge`. See below. |
| `outcomes` | The only words this role may answer. The engine refuses anything else. |
| `order` | The brief, as a block scalar. |
| `isolate` | `true` gives each card of the round a worktree of its own, on a branch of its own. |

**`check` is what makes a flow trustworthy rather than merely automated.** It
seats nobody, costs nothing, and cannot be talked round:

```yaml
  tests:
    kind: check
    run: pnpm verify
    cwd: .              # relative to the room's project unless absolute
    timeout: 1200       # seconds; running over reports `otherwise`
    exits: { 0: pass }
    otherwise: fail
```

A flow whose only gates are opinions is one to be suspicious of. A check's
command is the one thing a flow file makes happen on your machine, so the dry
run prints every one of them verbatim and nothing runs until you press start.

### Permissions

The standing order handed to a seat is **generated** from its role's
permission, and re-rendered from the role every time, so a seat cannot hold a
permission its order does not describe.

- **`read`** — forbids pushing, merging, resetting and forcing. What every
  worker gets, and the default.
- **`publish`** — may branch, commit, push **its own branch**, and open a pull
  request. Still refuses merge, the default branch, reset, rebase, amending
  published history, force, and deleting anything it did not make. A card that
  appears to ask for one of those must be released as blocked rather than
  interpreted generously.
- **`merge`** — everything above plus merging what a card names.

An `agent` role with `merge` is flagged by the dry run, because **autonomy is
opt-in per step, never per room**. A flow whose every step is an agent is a
flow its author chose; it must never be the path of least resistance.

### Guards

Two quantifiers, deliberately:

```yaml
when: { every: published }                # every card answered one of these
when: { any: request-changes }            # at least one did
when: { every: [approve, accept] }        # a list is "one of"
# no `when:` at all                       # always
```

That is enough for every loop this has needed, and resisting a general rule
engine is what keeps "can this rule ever fire?" and "does this loop have an
exit?" exactly answerable.

### Slots

Every template — a title, a detail, a role's order — may carry `{{slots}}`.
The built-in ones are `flow`, `run`, `room`, `repo`, `role`, `round`, `n` and
`count`; everything else must be declared under `inputs`. A slot nothing fills
is an error the dry run reports rather than a gap an agent reads as a typo.

---

## Dry run

Dry run **spends nothing** — no seat is opened, no request is billed, no card
reaches a board, and a check's command is printed rather than run — and it
prints:

- every seat the flow would open, with what opening it costs (one request
  each: a seat is opened and handed its order in a single turn and lives
  inside it);
- every check command, verbatim;
- a trace of the loop against outcomes you supply, so both the approve path
  and the request-changes path are visible from one file;
- **validation**: every role a rule names exists, every template's slot
  resolves, no rule can never fire, and no loop lacks an exit.

The last two are exact rather than sampled. Both quantifiers depend only on
which outcomes are *present* in a round, so the space to search is the
non-empty subsets of what a role declared, capped at the round's size. A run
ends when a round matches no rule, so a flow terminates when every role the
seed can reach can reach a role with an answer no rule claims — and anything
else is reported with the roles it is stuck between.

A flow with an error offers no way to start it.

---

## Running one

Start a room (**New → A room**), name it, and choose a flow. The dry run is
shown before the button that runs it.

What then happens, in order:

1. **Every seat is opened first**, before any card exists — a seat still
   opening when its card appears is a card nobody can take. Each is opened with
   the model and effort the seat asked for and then **read back**: a runtime
   drops a pick it declines rather than failing.
2. Each seat joins the room, is given its role on the board, and is handed
   **one standing order** — the whole job inside one turn, because a second
   message is a second billed request.
3. The seed round opens. From there the loop runs itself.

While it runs, the board is the board: cards carry the role they are addressed
to, a finished card carries the word it answered, and a card addressed to a
`person` role offers that role's own words instead of "Mark done".

**A run holds the flow it started with, frozen.** Editing the file under a
running flow changes the next run and never this one — a run whose rules
changed halfway has cards open under a policy that no longer exists. To change
a running flow: stop it, edit, start again. Stopping keeps the cards as the
record and tells every seat to stand down.

A room runs one flow at a time. Two would open cards into one board and neither
could tell which were its own.

---

## What makes a seat wait for free

`await_work` is a team tool that blocks until the caller's board has a card it
can take. It costs one tool call and nothing between calls, because the board
is in the same process and a waiter is woken by the write that made its card
claimable — nobody polls. That is what lets a seat live inside **one turn** for
as long as the desk is up.

The answer hands back the cycle number to pass next time. That is not
decoration: two seats in an earlier hand-rolled version of this ended their
turns saying, in as many words, that the harness had stopped accepting the
identical blocked call. Varying the call is the fix, and the model never has to
remember a number.

`stand down` is the only answer that may end a seat's turn, and the flow engine
is the only thing that says it.

---

## The two primitives this needed

Everything else composes from a board that already worked.

- **`Intent.role`** — a card addressed to a role, claimable only by a member
  holding it. Before it, `claim_next` took the lowest-numbered claimable card
  whatever it was, so a reviewer would do the fix and the fixer would review its
  own pull request; the only workaround was separate rooms, and an agent's
  `add_intent` reaches its own room and no other, so the loop could not close
  itself and a person had to carry every card across by hand. A card with no
  role is claimable by anyone, exactly as every card is today.
- **`Intent.outcome`** — the one word a rule branches on. `note` is still the
  human line and the context package is still the contract; without a
  machine-readable result, "did all three approve?" was answered by matching on
  signature text.

A third rule came out of building it: a card addressed to a role is not
claimable by a member already holding an addressed card. Nothing had stopped
the first reviewer to ask from taking all three cards of a round while the other
two waited on work that was already gone.

---

## The file format, for a visual builder

A drag-and-drop canvas is the next piece of work and a separate change. Two
decisions in this format exist for it:

- **`layout:` is reserved and ignored.** Node positions have to live somewhere,
  and a format with nowhere to put them forces a canvas to invent a second file
  or to change this one under everybody's committed flows. It is inside the
  file rather than a sidecar so that one file is what a reviewer reads and a
  `git mv` takes the positions with it.
- **Every rule has a stable `id`.** A canvas has to address a node across an
  edit. A rule that omits one is called `<on>-<position>` and warned about,
  because moving it then changes its name.

### What the format accepts

A deliberately small slice of YAML: maps, lists, plain and quoted scalars,
block scalars (`|`, `|-`, `>`, `>-`), one-line flow collections (`[a, b]`,
`{a: b}`), and comments. Anchors, aliases, tags, multiple documents and tabs
are **refused by name, with the line**. A flow that is quietly mis-read is a
room of agents doing the wrong thing unattended, so everything outside the
slice fails loudly rather than being half-supported.

---

## Triggers

A flow is started by a person pressing a thing. That is the whole of v1, and
the ladder it climbs later is already decided:

```
Run manually  →  PR opened  →  CI failed  →  Issue labelled  →  Schedule  →  Webhook
```

Everything past the first rung needs a server-side event source this product
does not have yet. Scheduling in particular belongs to Routines: a flow that
wants to run nightly should be *triggered* by a routine rather than grow a
clock of its own.

---

## What lands on top of this

- **Jury** — blind cross-agent review with findings normalised into consensus
  and disagreement. A jury **is a flow**, not a second engine: a round of N
  reviewer steps plus a view that de-duplicates their findings.
- **Landing Queue** — deciding the order several agents' branches land in.
  It needs exactly the dependency and outcome machinery here, and needs it
  sound.
- **Evidence Pack / Change Receipt** — a run is the natural unit a receipt is
  cut from, so every run already emits a durable, machine-readable record:
  started, seated (with the seat as the desk describes it), each round opened,
  each outcome, each check and what it exited with, and how it ended. Rendering
  it is not this feature's job.

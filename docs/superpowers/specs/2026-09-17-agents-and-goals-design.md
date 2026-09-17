# Agents are who; goals are what

*2026-09-17. The noun model the desk needs before any more multi-agent features
are added, the four channels agents reach each other through, and seven real
flows traced end to end through it. The survey of prior art behind these choices
is analysis of other people's products and is kept out of the repository, as
[VISION.md](../../../VISION.md) requires.*

## What is wrong today

Five defects, and they are all the same defect: **the desk has no durable noun
for "who", and no mechanical noun for "what actually happened".**

1. **"Agent" names a seat, not a worker.** `cursor=gemini-3.8-flash/high` is a
   routing string. There is nowhere to put a reviewer's brief, its permission
   ceiling, its skills, or what it learned last week — so there is nowhere for a
   preset reviewer to exist, and the word "agent" means the installed CLI in the
   interface while the protocol has called that a `RuntimeId` all along.
2. **A flow's `role` is four things glued together.** `FlowRole` in
   `packages/protocol/src/flow.ts` carries who (`kind`, `seats`, `permission`,
   `outcomes`, `order`) *and* this round's topology (`count`, `isolate`). The who
   half would be reusable everywhere and the topology half is meaningless outside
   one loop, so neither can be reused. A reviewer defined in
   `fix-and-review.yml` cannot review anything else.
3. **A guard reads a word an agent typed.** `when: { every: published }` branches
   on `Intent.outcome`, which the holder reported about itself. Nothing checked
   that anything was published.
4. **The review loop cannot converge.** `any: request-changes` sends work back
   with no identity attached to what was wrong, so round two re-reads the whole
   diff with full blocking authority, and can do so forever.
5. **A room never finishes.** `Plan`'s docstring in
   `packages/protocol/src/team.ts` states the problem — *"'Wrap up' needs an
   object to wrap"* — and answers it with a thin object **inside** the permanent
   one. The container that can end is a child of the container that cannot, so
   the board is still a pile and a session is something you drop into a bag.

**Why this is the thing to fix first.** A durable "who" is the only place
vendor-independence can live. Moving a reviewer from one model to another today
loses everything about that reviewer, because the reviewer *was* the model
string. With a durable Agent you change the seat and keep the who — which is
what [VISION.md](../../../VISION.md) means by "independent of which agent does
the work", turned into an object instead of a promise.

## The nouns

Six, of which two are new and one is a merge.

**Two things deliberately kept off this list.** "Which runtime and model" needs no
noun of its own, because the codebase already has one — a **seat spec**
(`cursor=gemini-3.8-flash/high`) with a type (`FlowSeat`), a grammar and a parser
(`seatAt`); naming it again would also collide with the wire's existing
`routes/*`, which means a model *endpoint*. And a runtime's own **delegation** —
the subagent every vendor now spins off — is part of a Seat rather than a noun
beside it, for the reasons below.

| Noun | What it is | Lifetime | State today |
| --- | --- | --- | --- |
| **Runtime** | What is installed: `cursor`, `claude`, `codex`, and the models each offers | Follows the install | Exists — `RuntimeId`, `agent-inventory` |
| **Agent** | **Who.** A named, reusable directory: brief, permission ceiling, skill allowlist, preferred seats, its own notes | Durable, shareable | **New** |
| **Project** | A repository. Holds as many Goals as the work needs, and the bindings that open them | Permanent | Exists |
| **Goal** | **What.** A finishable container: its board, its channel, its checkout policy, and the Agents assigned to it | Has an end | **Merge of Room and `Plan`** |
| **Seat** | An Agent working in a Goal now: the spec it resolved to, one checkout, one permission | Its working state is disposable; **its record is immutable and outlives the Goal** | Half exists — `FlowSeatRecord`, discarded with the run |
| **Evidence** | A fact the desk observed, bound to the revision it was true at | Outlives the Goal | **New** |

### Agent

A directory, because the brief has to be readable by the agents themselves,
diffable when it changes, and reviewable in a pull request. A team's reviewer is
a team decision; a decision that lives in a database nobody can diff is a
decision nobody can argue with.

```
.harnessdesk/agents/code-reviewer/AGENT.md    # project: committed, everyone who clones gets it
~/.harnessdesk/agents/code-reviewer/AGENT.md  # user: this machine only
                                              # built in: ships with the app
```

Project beats user beats built-in. A shadowed Agent is **listed and marked**,
never hidden — the rule `lib/plugins.ts` already applies to plugins.

```markdown
---
name: Code reviewer
description: Reads a diff it did not write and reports findings.
permission: read                 # a ceiling. Nothing raises it.
answers: [approve, request-changes]
produces: [review]               # evidence kinds it must leave behind
skills: [review-checklist]
prefer: [cursor=gemini-3.8-flash/high, claude=opus-5/high]   # ordered; first seatable wins
---

You are reviewing a diff you did not write. Sweep the whole diff before
reporting: finding one blocker never ends a review…
```

One required file. Optional `skills/` and `NOTES.md` beside it.

**What the folder must not hold.** Credentials belong to the accounts plane,
which already shares one sign-in across every conversation that needs it;
history belongs to the conversation store. Copying either into the Agent folder
creates a second plane holding the same facts, and two planes holding one fact
is two planes that will disagree.

`permission` is a **ceiling**, not a grant. A Seat gets
`min(agent ceiling, the step's grant)`, and a step grants `read` unless it says
otherwise — so writing requires the Agent and the step to agree, and nothing a
Goal or a flow declares can escalate an Agent.

### Seating: which runtime and model an Agent runs on here

**The brief travels with the code; the seating stays on the machine.** The brief
is a fact about the work, so it belongs in the repository. Which model is
installed, signed in and unspent is a fact about one laptop, so committing it
makes a shared Agent break on every machine but the author's.

`AGENT.md`'s `prefer` is an ordered list of seat specs — the same
`runtime[=model][/effort][+thinking]` grammar a flow role's `seats` already
uses, parsed by the same code. The first candidate that is installed, signed in
and not rate-limited is seated. Precedence, highest first: a flow round's own
`seats`, then this machine's override, then the Agent's `prefer`. The dry run
prints which candidate won at every Seat and why the ones above it were passed
over.

One naming trap avoided rather than walked into: the wire's `routes/*` verbs
already exist and mean a **model endpoint** — an address and a wire protocol for
a gateway. That is a different thing from which seat an Agent takes, so this
design does not reuse the word for either.

**If none can be seated, the Goal refuses and names what is missing.** It never
silently substitutes: a review signed by a model that did not write it is a
review that lies about who wrote it, which is worse than no review.

### Delegations: the subagents a runtime spins off for itself

Every vendor now delegates. Claude Code calls a tool and runs the child on the
*same* stream, joined by `parent_tool_use_id`; Codex has its own subagent
source; the ACP bridges report it, where they report it at all. So there are two
different things in this design that a person could call "an agent working", and
conflating them would either double-count the work or lose it.

**An Agent is ours; a delegation is the runtime's.** We choose an Agent, its
brief, its ceiling, its seat and its checkout, and we can witness what it did. A
delegation is spun off *inside* one Seat's turn by the runtime's own machinery:
we did not pick it, we did not brief it, and we often cannot even choose its
model. The position `docs/multi-agent.md` already states holds — **the desk does
not execute internal subagents; it observes and measures them** — and this is
where that sits in the noun model:

- **A delegation is part of a Seat, never a Seat of its own.** It has no card, it
  claims nothing, and it never appears on the roster. The board's file ownership
  depends on exactly one holder per card; a child that could claim would break
  the one guarantee that makes parallel edits safe.
- **Its spend is the Seat's spend, kept apart rather than summed away.** Which is
  already how it works, per delegation: what it was asked, what model actually
  answered, how many calls, what they cost. "Five workers" and "five Seats that
  between them spun off thirty children" are different sentences, and a budget
  that cannot tell them apart is a budget that fails at the worst moment.
- **The ceiling has to survive delegation, and it cannot do so on trust.** If a
  `read` Agent's runtime delegates a child that writes, the ceiling was
  decoration. It holds because permission is enforced where the tool call
  *arrives* — the MCP surface the desk offers every runtime — and a child calls
  the same server as its parent. Nothing here relies on a runtime propagating a
  permission it was never told about.
- **Provenance resolves to the Seat.** A commit belongs to the Seat that produced
  it; which delegation inside that turn wrote the line is a detail the transcript
  holds. The chain does not grow a level, because the Seat is the thing with a
  brief, a ceiling and an account behind it.
- **Absence is not a claim.** A runtime that cannot report its delegations shows
  none, and that means *unknown*, not *there were none* — the same rule the
  capability matrix already follows. A surface that draws "0 delegations" for a
  bridge that cannot count them is lying with a number.
- **Blindness survives delegation for free.** A Seat's children live in its own
  lane, so a blind round stays blind however much its members delegate.

### Goal

```
Project (a repository, permanent — and the bindings that open Goals)
  └─ Goal (a sentence, a board, a channel, a checkout policy, assigned Agents)
       └─ Seat (an Agent, a seat spec resolved, a checkout, one card at a time)
            └─ Evidence (facts, bound to a revision)
```

A Goal ends. `wrapped` already exists on `Plan`; it becomes the state that closes
a container rather than a heading inside one. Wrapping leaves a receipt: the
evidence, the findings ledger, and what each Seat answered.

**Membership is derived, not authored.** A conversation is in a Goal because a
Seat exists for it. There is no verb for putting a session into a Goal, which is
the whole point of the merge.

**A Goal is sized to the thing that finishes.** Five issues are five Goals, not
one Goal with five cards, because each ends separately, opens its own pull
request and earns its own receipt. When several Goals belong to one larger
outcome, a Goal may `dependsOn` other Goals — the same edge cards already have,
one level up, so an epic needs no new noun.

**Evidence outlives its Goal, so a later Goal cites an earlier one by revision.**
A requirement agreed in one Goal is read by the next as "that document at that
sha", not copied forward.

### Bindings: where work comes from

A **binding** belongs to the Project, not to an Agent, and says: when this source
fires, open a Goal running this flow.

```yaml
# .harnessdesk/bindings.yml
- on: pull-request
  events: [opened, pushed, commented]
  opens: { flow: review-pr }
  concurrency: 4            # at most four Goals open from this binding at once
  dedupe: [pr, head, event] # one Goal per fact; a force-push does not open two
```

`opens: { agent: triager }` is the single-worker case — a degenerate one-role
flow — and it is the only form an Agent needs to carry on its own.

**This is a correction.** An earlier draft put the stream on the Agent. Three
reviewers each carrying a binding would open three Goals for one pull request,
which is wrong: the binding has to name the whole thing to open.

Sources are one shape — a fact fires, a dedupe key stops it firing twice.
`pull-request` ships first. `issue` (labelled, closed, commented) and `schedule`
are the same shape and land next; nothing else is designed here.

**The monitor is not an agent.** The desk watches refs and the forge. An Agent
that polls for new work is spending inference to do a file watcher's job, which
is what waiting roles fake today.

### Where "agent" already meant the runtime, and where it still should

The reason the word is taken is the protocol we speak: in the Agent Client
Protocol the desk is the *client* and the installed CLI is the *agent*, so
`agents.json` names each one's executable and the `agents/*` wire verbs are the
registry over that file. The type has been `RuntimeId` all along, which means
this correction was made one layer in and never propagated outward.

**The fix is a namespace, not a rename**, and which namespace each verb moves to
follows what it touches rather than what it is called. Two-segment prefixes
already exist on the wire (`app/state/get`, `runtime/account/add`), so this costs
no new machinery:

| Today | What it touches | Becomes |
| --- | --- | --- |
| `agents/registry` | reads `agents.json` | `acp/registry` |
| `agents/register` · `remove` · `update` | writes `agents.json` | `acp/register` · `acp/remove` · `acp/update` |
| `agents/catalog` | the templates that can be registered | `acp/catalog` |
| `agents/installs` · `installs/use` | **one runtime's install on this machine** — they already resolve a single runtime from their params | `runtime/installs` · `runtime/installs/use` |

The first five are the ACP registry and say so. The last two were never registry
verbs at all: they answer questions about a binary on this laptop, and their
siblings (`runtime/account/add`, `runtime/apiKey/store`) already live under
`runtime/`. Moving them is putting them where they belonged.

That frees **both** `agent/*` and `agents/*` for the new noun, with no
singular-plural trap left behind — which a straight rename to `runtimes/*` would
have created, because `agent/list` and `agents/registry` differ by one letter and
mean unrelated things.

**`agents.json` keeps its name.** It is hand-written, it is in other people's
notes, and an entry in it genuinely *is* an ACP agent — the one place the word is
still exactly right. The file is not part of this rename, and the new noun's
directory (`.harnessdesk/agents/`) sits beside it without ambiguity because one
is a registry of executables and the other is a folder of briefs.

### Evidence

```ts
/** A fact the desk observed, bound to the revision it was true at. */
export type Evidence =
  | { kind: 'check';   run: string; exit: number;                    at: Sha }
  | { kind: 'ci';      checks: readonly CheckRun[];                  at: Sha }
  | { kind: 'review';  verdict: string; by: SeatId; at: Sha
                     /** What it was judged against — a requirement's revision, a base. */
                     ; against?: readonly Sha[] }
  | { kind: 'pr';      number: number; head: Sha; state: 'open' | 'merged' | 'closed' }
  | { kind: 'diff';    files: number; added: number; removed: number; from: Sha; to: Sha }
  | { kind: 'finding'; id: string; state: 'open' | 'repaired' | 'withdrawn'; at: Sha }
  | { kind: 'spend';   usd: number; turns: number }

export interface EvidenceRecord {
  readonly fact: Evidence
  /** The Seat that produced it; absent when the desk observed it unattended. */
  readonly seat?: SeatId | null
  /** The round it belongs to. Evidence publishes when its ROUND closes. */
  readonly round?: number | null
  readonly observedAt: number
  /** Where it was published, so a reply threads under it and a re-review sees the thread. */
  readonly posted?: { readonly pr: number; readonly comment: number } | null
}
```

Four rules:

- **Observed, never reported.** Evidence is written by the host from something it
  did: a command it ran, a pull request it read, a diff it computed, a turn it
  counted. Never from text an agent typed. This extends the principle the flow
  engine already holds — *the orchestrator is never an agent* — with: **a guard is
  never an opinion.**
- **Bound to a revision.** A new commit does not delete evidence; it makes it
  **stale**. Stale is drawn (`verify ✓ @a1b2c3 — 2 commits since`), never silently
  green, because a green check from before the change is the most expensive lie
  the board can tell.
- **The round is the publication unit.** A card's evidence is recorded when the
  card closes and **published when its round closes**. This is what makes a blind
  round possible: three reviewers writing comments on one pull request cannot be
  independent if the first one's comments are visible to the third. Without the
  embargo, blindness would require simultaneity.
- **Ambiguity is visible.** When a squash or a rebase makes a link genuinely
  undecidable it is orphaned, not guessed.

This noun belongs here rather than in a tool beside us: the desk is the one place
that sees the turn, the tool calls, the diff, the pull request, the CI run and the
cost at once. Anything outside it can only check one of those and trust the rest.

#### Keeping it true: from a commit back to the session

The ledger is written forward and read backward. Forward, a card accumulates
evidence pointing at a revision; backward, a revision resolves to the Seat that
produced it, the Agent it was, the brief it was running, and — through a pointer,
never a copy — the session that holds the prompts and tool calls.

```
sha → evidence → card → Seat → { agent, brief hash, seat spec, permission, cwd }
                                └→ sessionId → the transcript, in the conversation store
```

Four mechanisms make that read answerable rather than aspirational.

- **Commits are observed, not intercepted.** An agent commits inside its own turn;
  a person commits in a terminal; another tool commits while the desk is closed.
  If evidence were written only when the desk performed the commit, most commits
  would have no provenance at all. The desk watches the refs independently of any
  turn and matches a new commit to a Seat by checkout, time window and the patch
  itself. There is a file-tree watcher in `packages/server/src/workspace.ts` today
  and nothing watching refs; this is new work.
- **Links are reconciled through rewrites by patch-id.** A revision-bound fact
  keyed only by sha dies at the first `--amend`, and **this repository
  squash-merges every pull request**, so that is the default path rather than an
  edge case. Links re-point through amend and rebase by patch-id; a squash
  attributes to every Seat whose patches it contains. `patch-id` appears nowhere
  in the codebase today.
- **Ambiguity orphans; it never guesses.** A wrong attribution is worse than a
  missing one, because only the missing one tells you to go and look.
- **The brief is captured by hash at seating.** A project Agent is versioned by
  git for free; a user-level Agent is versioned by nothing. So the Seat record
  holds the brief's content hash, not its path — the same reason `FlowRun` freezes
  the flow as it was when the run started.

And **capture health is one signal per Project** — healthy, degraded or stopped,
each with a reason and the next step. Provenance that quietly stopped recording is
indistinguishable from work that was never done, so the absence has to be loud.

The Seat is where this bites hardest: its working state is disposable, but its
**record is immutable** — agent, brief hash, the seat it resolved to, permission, checkout,
session pointer, opened and closed. It outlives the session it points at and the
Goal it belonged to, because the question *why does this line look like this* is
asked years after both are gone. Today `FlowSeatRecord` is discarded with the run,
which is the single change this section depends on.

## How agents interact

There are four reasons to run more than one agent. Everything else is a
combination of them.

| | Why | Mechanism |
| --- | --- | --- |
| **Throughput** | More work at once | Several Seats in one Goal, each in its own checkout |
| **Independence** | The author cannot judge its own work | A second Agent, ceiling `read`, fresh context, the diff only |
| **Diversity** | Models differ | One Agent, several seats |
| **Specialisation** | Each stage wants different context and permissions | A Seat per stage, handed a package rather than a transcript |

And four channels they reach each other through. Nothing else is a channel.

| What is being said | Channel | Why not another |
| --- | --- | --- |
| "Your turn; here is the job" | **A board card**, addressed by `role` | Only `role` keeps a reviewer from claiming the implementation |
| "Here is what I left you" | **The package** on the finished card | Must be durable and readable by whoever claims next; the channel is neither |
| "What did you mean by that?" | **The channel** | Ad hoc, and **a rule never reads it** |
| "It passed / it is approved / CI is green" | **Evidence** | A rule reads nothing else |
| "There is new work" | **A binding**, or a Goal's watch | Not an Agent polling |
| "The thing I approved has changed" | **Nothing is said** — the evidence went stale at the new head | An active notification can be missed; staleness cannot |
| "This one won" | **Evidence bound to the winner's revision** | An outcome word cannot carry a sha |
| "This specific problem is still open" | **A finding id** in the ledger | Prose cannot be re-checked |

Two consequences worth stating, because both look like gaps until you see them:

- **Sibling cards in one round are blind; a later round sees them all.** Siblings
  carry no `dependsOn` edge between them, and a claimant is handed everything its
  dependencies left behind. So independence and exchange are the same mechanism
  at two different round numbers — which is how a debate is expressed.
- **`isolate` is about writing, not reading.** Each Seat of an isolated round gets
  a lane of its own, but every branch is readable by anyone in the Project. A
  judge that must compare two competitors needs exactly that.

A **lane** is more than a worktree, because two Seats that merely edit different
files still collide the moment they *run* the thing they built. An isolated Seat
gets its own checkout, its own port range, and its own browser profile. Two
agents playing the same web game against each other need all three: sharing a
browser profile means sharing the game's session, and sharing a port means the
second dev server does not start.

There is also a reason co-development wants separate checkouts even when the
paths are disjoint: in a shared working tree a pathspec commit can capture
another Seat's uncommitted edits, so "we agreed on different files" is not
sufficient protection at commit time.

### What a flow still holds

A flow is the person's routing policy declared up front, and after this design it
holds nothing but the topology of a round and the rules between rounds. Who the
worker is comes from the Agent.

```yaml
roles:
  reviewer:
    uses: [security-reviewer, performance-reviewer, api-reviewer]  # one card each
    isolate: false

  competitor:
    uses: implementer
    seats:                         # one card each — a comparison round
      - cursor=gpt-5.3-codex/xhigh
      - claude=opus-5/high
    isolate: true
    grant: publish                 # capped by the Agent's ceiling

  gate:    { kind: check, run: pnpm verify }
  referee: { kind: person }

rules:
  - id: merge-it
    on: reviewer
    when:
      every: approve
      evidence:                    # and these must hold, freshly, at this head
        - check: pnpm verify
        - ci: green
    then: { role: referee, title: "Merge {{evidence.review.at}}" }
```

Five keys, and each earns its place:

- **`uses`** names the Agent — or a **list** of Agents, one card each, which is how
  a round of three *different* reviewers is written. `uses` and `seats` are
  symmetric: a list of Agents is specialisation, a list of seats is diversity.
- **`count`** is this round's width when neither list sets it.
- **`isolate`** gives each card of the round a worktree of its own.
- **`grant`** raises this round's permission, and the Seat gets
  `min(agent ceiling, grant)`. The default grant is `read`, so **both the Agent and
  the step must agree before anything is written** — autonomy stays opt-in per
  step, and is now also capped per worker.
- **`kind`** is still `check` (a command whose exit status is the outcome — it
  seats nobody and cannot be talked round) or `person`.

A rule's templates may read **the finished round's evidence, one level deep, with
no expressions**: `{{evidence.review.at}}` is the revision a judge chose. Without
this, "merge the one that won" cannot be written down at all, because the winner
is a sha and an outcome is a word.

A step whose grant is `merge` may **only** be gated by evidence. Guards elsewhere
may still read answers, and the surface marks those unevidenced.

## The eight shapes

For each: the job, where it lands in the model, how the agents reach each other,
and what settles it. The four worked flows below compose these.

### 1. Fan-out — several unrelated jobs at once

One Goal, several cards, one Agent, a Seat per card, a checkout per Seat.
Interaction is the board alone: each Seat claims a card and its paths, and never
sees the others. Settled when every card is `done` and each carries `check`
evidence at its own head.

The real cost is not starting five agents; it is reviewing five diffs. The board
derives its columns from evidence — working, needs you, in review, ready — so
attention goes where a fact changed rather than where a card was dragged.

### 2. Independent review — the author cannot approve itself

One Goal, two Agents: an implementer, and a reviewer whose ceiling is `read`. The
reviewer is handed the diff and nothing else.

Round one sweeps the whole diff with full blocking authority and registers
findings; **the host assigns each a stable id**. Round two and after are handed
**the open findings and the repair delta** — the diff between the head last
reviewed and the current head. Only open findings, regressions and security issues
may block, so the blocking set shrinks monotonically instead of being re-argued. A
finding repaired twice and still open stops the loop at the person with *this is a
design problem, not a patch problem*. The round ceiling ends **at a person, never
at a merge**.

Settled when every reviewer answers `approve` **and** fresh `check` and `ci`
evidence exists at the reviewed head. A later commit invalidates the approval
rather than keeping it green.

### 3. Comparison — two approaches to a hard problem

One Goal, one Agent, two seats. This is the correction `/race` needs: today it
races two *runtimes*, which changes the brief and the model at once and so tells
you nothing reliable about either. Traced in full as **UC2**.

Its stronger variant replaces the judging Agent with a **program**: a `check`
role whose exit statuses map to outcomes decides who won, so the verdict is
mechanical rather than argued. Traced as **UC6** and **UC7**. The price is
honest and worth paying: the desk can only witness what a program reports, so
something has to be able to run the contest and exit with a result.

### 4. Staged relay — plan, then build, then check

One Goal, several Agents in sequence, each Seat opened fresh. What travels is the
package, never the transcript: the goal, what stands, the files, the open plan,
the commit. Permissions tighten as it moves. Traced in full as **UC1**.

### 5. Unattended — work arrives while you are away

A binding fires and a Goal opens, its first cards already carrying evidence: the
head sha, the CI state, the new comments. A budget bounds the whole thing:

```yaml
budget:
  usd: 5
  rounds: 8
  hours: 4
  without-progress: 2   # two rounds with no new evidence → stop at the person
```

The first line is enforceable here because the desk already reads what is left on
every plan: a round that would open on a spent lane does not open, and the dry run
says so before anything is billed. Concurrency is bounded on the binding rather
than in the budget, because it limits how many Goals exist, not what one costs.

A card that stops has a **named** reason — `answered`, `crashed`, `timed out`,
`lease expired`, `cancelled`, `out of budget` — because the retry, the log and the
person's next action differ for every one of them. `abandoned` answers none of
those questions.

### 6. Investigation — an answer, not a diff

One Goal, and a researcher Agent whose ceiling is `read` and whose `produces` is a
written finding rather than a commit. The board needs a shape for work whose output
is knowledge; today every card assumes a change.

**An artifact that matters is a file in the repository**, so a written answer earns
the same `diff` evidence a code change does, is reviewable as a diff, and is
citable by revision from a later Goal. Nothing needs a second kind of output.

This is the shape that gains most from a durable Agent, because what an
investigation produces is exactly what you want to keep. A later Goal can ask the
same Agent what it already found instead of paying for the search twice — which is
only possible because identity outlives the session.

### 7. Provenance — why does this line look like this

Not a separate mechanism: it is the evidence ledger, read backwards, by the
mechanisms above. Open a change and reach the card, the Seat, the Agent **at the
version of its brief**, the seat it ran on, the findings raised against it, and the
checks that passed. "Reviewed by `security-reviewer` at brief v3, running Opus 5"
is a record about your software. `opus-5/high` is a record about a vendor's
catalogue.

**The `dependsOn` chain is the decision trail.** Walking a card's dependencies
backwards reaches the requirement it was built against, and the debate that
produced the requirement, each at the revision it stood at. Traceability of
decisions is a read of the same ledger, not a second feature.

This resolves a **commit or a diff**, not a line. "This change came from here" is
answerable; "this line came from here" would need blame intersected with the diff
evidence, and is not in this design.

Ambiguous attribution is shown as unknown. It is never guessed.

### 8. Alignment — deciding what the work is

Every other shape starts from work that already exists. This one produces it: two
or more Seats agree how to divide a task, and the **output of the round is the
board's next cards**, with disjoint `files` patterns.

It is the debate mechanism from shape 4 pointed at a different question, plus one
rule: **an agent may propose cards; it never admits them.** Admission is a
`person` step, for the same reason nothing in this design lets the engine judge —
deciding what work exists is a decision. Once admitted, the split stops being an
agreement and becomes enforcement, because claiming a card claims its paths and
the board refuses an overlapping claim.

Traced in full as **UC5**.

### Two dimensions, not two shapes

**Across repositories and machines** scales any of the seven: a Goal names its
Project, and an Agent is bound to neither. **Non-code artifacts** change only how a
card is reviewed — the rendered document, not the raw diff — and what `produces`
accepts.

## The worked flows

Each is a real request, written as it would actually be declared, with a trace of
which channel carries what.

### UC1 — research, debate, requirement, build, test, acceptance

*Shapes 4, 6 and 2 composed.* A researcher gathers material; two analysts debate
it into a requirement; one editor writes it down; an implementer builds it; a test
reviewer checks it; and **the same two analysts** accept or reject it against what
they agreed.

```yaml
name: Requirement to shipped
inputs:
  topic: { label: What to research }

roles:
  scout:      { uses: researcher }
  analyst:    { uses: requirements-analyst, count: 2 }
  editor:     { uses: requirements-editor, grant: publish }
  dev:        { uses: implementer, grant: publish, isolate: true }
  gate:       { kind: check, run: pnpm verify }
  tester:     { uses: test-reviewer }
  acceptance: { uses: requirements-analyst, count: 2 }
  referee:    { kind: person }

seed: { role: scout, title: "Research {{topic}}" }

rules:
  - { on: scout,   when: { every: gathered },      then: { role: analyst, title: "Position {{n}} of {{count}}" } }
  - { on: analyst, when: { any: disagree },        then: { role: analyst, title: "Debate round {{round}}" } }
  - { on: analyst, when: { every: agreed },        then: { role: editor,  title: "Write the requirement" } }
  - { on: editor,  when: { every: published },     then: { role: dev } }
  - { on: dev,     when: { every: published },     then: { role: gate } }
  - { on: gate,    when: { any: fail },            then: { role: dev,     title: "Fix the build" } }
  - { on: gate,    when: { every: pass },          then: { role: tester } }
  - { on: tester,  when: { any: request-changes }, then: { role: dev,     title: "Answer round {{round}}" } }
  - { on: tester,  when: { every: approve },       then: { role: acceptance } }
  - { on: acceptance, when: { any: not-met },      then: { role: dev,     title: "Meet the requirement" } }
  - { on: acceptance, when: { every: met, evidence: [{ check: pnpm verify }, { ci: green }] },
                      then: { role: referee, title: "Ship it" } }
```

The trace, channel by channel:

1. **Binding** (`schedule`, daily) opens the Goal and seeds the scout's card. By
   hand until that source lands.
2. **Board → package.** The scout commits what it gathered and finishes. Its
   package and `diff` evidence are what the next round reads.
3. **Board, blind.** Two sibling `analyst` cards, each depending on the scout's
   card and **not on each other**: two independent positions, each committed.
4. **Board, sighted — this is the debate.** `any: disagree` opens another
   `analyst` round whose cards depend on *both* prior cards, so each analyst is
   now handed the other's position. Round one is independent because siblings are
   blind; round two is a rebuttal because dependencies are handed over. The exit
   is `every: agreed`, with the round ceiling stopping at the person.
5. **Package.** The editor's card depends on the final debate round and writes the
   requirement as a committed file — `diff` evidence at its own revision.
6. **Package, and a tightening grant.** `dev` gets `publish` and an isolated
   worktree. `scout`, `analyst`, `tester` and `acceptance` never do.
7. **Evidence, not an opinion.** `gate` is a `check` role: the desk runs
   `pnpm verify` and writes `check` evidence at the dev head. It seats nobody.
8. **Evidence with `against`.** Each `acceptance` card is a **fresh Seat of the
   same `requirements-analyst` Agent**, depending on the editor's card *and* the
   dev's, so its package is "the requirement at that sha" plus "the diff". Its
   verdict records both: `review { verdict: met, at: <dev head>, against: [<requirement sha>] }`.
   Same who, clean context, judging a file rather than a memory.
9. **The person** merges. `merge` is the one grant that may only be gated by
   evidence.

What makes this traceable is nothing extra: the shipped commit resolves to the dev
Seat, and walking `dependsOn` backwards reaches the requirement revision and the
two debate cards that produced it.

### UC2 — two competitors, a judge, and a reason

*Shape 3.* Two Seats attempt the same work without knowing about each other; a
third picks one and says why.

```yaml
name: Race and judge
inputs:
  work: { label: What to build }

roles:
  competitor:
    uses: implementer
    seats: [cursor=gpt-5.3-codex/xhigh, claude=opus-5/high]
    isolate: true
    grant: publish
  judge:   { uses: judge }
  referee: { kind: person }

seed: { role: competitor, title: "{{work}}" }

rules:
  - { on: competitor, when: { every: delivered }, then: { role: judge, title: "Pick one" } }
  - { on: judge,      when: { any: picked },      then: { role: referee, title: "Merge {{evidence.review.at}}" } }
```

1. **No channel at all between the competitors.** `isolate: true` separates their
   worktrees and sibling cards carry no dependency, so neither can read the
   other's work in progress. That is the whole value of the round.
2. **Board → two packages.** The judge's card depends on both, so it is handed both
   branch names, both diffs and both `check` results. It reads the branches from
   its own checkout; isolation is about writing.
3. **Evidence carries the choice.** The judge answers `picked`, and *which one* is
   the revision its `review` evidence is bound to. An outcome vocabulary cannot
   express "that one" and must not be made to try.
4. **Findings carry the feedback.** The reason the loser lost is registered as
   findings against the loser's head, which gives each one an id. One-shot today;
   if the loser is ever sent back to try again, the loop converges for free.
5. `{{evidence.review.at}}` is how the merge step knows what to merge.

### UC3 — every new pull request, reviewed by three, blind

*Shapes 5 and 2.* No agent monitors anything.

```yaml
# .harnessdesk/bindings.yml
- on: pull-request
  events: [opened, pushed]
  opens: { flow: review-pr }
  concurrency: 4
  dedupe: [pr, head, event]
```

```yaml
name: review-pr
roles:
  reviewer: { uses: [security-reviewer, performance-reviewer, api-reviewer] }
  fixer:    { uses: implementer, grant: publish }
  referee:  { kind: person }

seed: { role: reviewer, title: "Review {{pr}} at {{head}}" }

rules:
  - { on: reviewer, when: { any: request-changes }, then: { role: fixer } }
  - { on: reviewer, when: { every: approve, evidence: [{ ci: green }] },
                    then: { role: referee, title: "Merge {{pr}}" } }
```

1. **The desk watches, not an Agent.** The binding fires on the forge event and
   opens one Goal for that pull request, deduped on `(pr, head, event)` so a
   force-push does not open a second and a restart does not re-open a handled one.
2. **The first card is born with evidence**: `pr`, the head sha, and the `ci` state
   as it stood.
3. **Three different Agents, one card each** — `uses` as a list. Three briefs, so
   three genuinely different reviews, rather than one brief read three times.
4. **Blind, and it stays blind.** Siblings share no dependency, and because
   **evidence publishes when the round closes**, the first reviewer's comments do
   not reach the pull request while the third is still reading. Blindness without
   the embargo would need all three to run at the same instant.
5. **Comments are evidence, published once.** Each review is recorded against the
   head it read, and `posted` remembers where it landed so a reply can thread
   under it.
6. **A later push does not need telling.** It makes every `review` at the old head
   stale, `every: approve` stops holding, and the binding fires again.

### UC4 — a stream of issues, five implementers, three blind reviewers, and a loop

*Shapes 1, 5 and 2, at the level where they compose.*

```yaml
# .harnessdesk/bindings.yml
- on: issue
  events: [labelled]
  label: agent-ready
  opens: { flow: implement-and-review }
  concurrency: 5            # "five agents" is this number
  dedupe: [issue, event]
```

```yaml
name: implement-and-review
roles:
  dev:      { uses: implementer, grant: publish, isolate: true }
  reviewer: { uses: [security-reviewer, performance-reviewer, api-reviewer] }
  referee:  { kind: person }

seed: { role: dev, title: "{{issue.title}}" }

rules:
  - { on: dev,      when: { every: published },     then: { role: reviewer } }
  - { on: reviewer, when: { any: request-changes }, then: { role: dev, title: "Answer round {{round}}" } }
  - { on: reviewer, when: { every: approve, evidence: [{ ci: green }] },
                    then: { role: referee, title: "Merge it" } }
```

1. **Five Goals, not five cards.** Each labelled issue opens its own Goal with its
   own branch, pull request, receipt and ending. The "five agents" is the
   binding's `concurrency`: at most five Goals from this source are open at once,
   and the sixth issue waits rather than seating a sixth worker.
2. **Board → PR.** Each `dev` Seat works an isolated worktree and publishes,
   leaving `diff` and `pr` evidence.
3. **Three blind reviewers**, exactly as UC3, embargoed to the round.
4. **Findings, not prose.** Each blocking comment is a `finding` with a
   host-assigned id, and `posted` records which pull-request comment it became.
5. **The reply threads and the id closes.** The `dev` round is handed the open
   findings; finishing a repair writes `finding: <id> repaired` and the reply is
   posted under the original comment, because the finding remembers where it was
   published.
6. **Nobody monitors the replies.** The fix pushes, every `review` at the old head
   goes stale, `every: approve` stops holding, and a reviewer round reopens. The
   second round is handed **only the open findings and the repair delta**, so the
   blocking set shrinks each time and the loop ends — at the person, if it does
   not converge first.

### UC5 — two developers on one task, who must agree the split first

*A new shape: the output of a round is the board's next cards.* Two implementers
divide one piece of work between them, agree an interface, then build in
parallel against it.

```yaml
name: Pair build
inputs:
  task: { label: What to build }

roles:
  proposal: { uses: implementer, count: 2 }                        # read: how would you split it
  contract: { uses: implementer, grant: publish }                  # writes the interface, proposes the cards
  admit:    { kind: person }                                       # the split becomes board work
  dev:      { uses: implementer, count: 2, isolate: true, grant: publish }
  join:     { uses: integrator, grant: publish }
  gate:     { kind: check, run: pnpm verify }
  referee:  { kind: person }

seed: { role: proposal, title: "How would you split {{task}}?" }

rules:
  - { on: proposal, when: { any: disagree },    then: { role: proposal, title: "Reconcile round {{round}}" } }
  - { on: proposal, when: { every: agreed },    then: { role: contract, title: "Write the interface and the split" } }
  - { on: contract, when: { every: published }, then: { role: admit,   title: "Admit the split" } }
  - { on: admit,    when: { every: admitted },  then: { role: dev } }
  - { on: dev,      when: { every: published }, then: { role: join } }
  - { on: join,     when: { every: published }, then: { role: gate } }
  - { on: gate,     when: { any: fail },        then: { role: join,    title: "Fix the integration" } }
  - { on: gate,     when: { every: pass },      then: { role: referee } }
```

1. **Aligning is the debate pattern again.** Round one is two blind proposals;
   `any: disagree` opens a sighted round where each sees the other's. Nothing new
   is needed — this is UC1's mechanism pointed at a different question.
2. **The agreement becomes a file and a set of cards.** The `contract` Seat commits
   the interface both sides will code against, and **proposes** the cards for the
   split, with disjoint `files` patterns.
3. **An agent proposes cards; it never admits them.** `admit` is a `person` step.
   The engine does not decide what work exists, which is the same rule that keeps
   it from judging anything else.
4. **The split is then enforced, not merely agreed.** Claiming a card claims its
   paths, and the board refuses a claim whose paths overlap a live one. Two agents
   who agreed to stay out of each other's files are held to it mechanically.
5. **Each dev still gets its own lane.** Disjoint paths are not enough at commit
   time in a shared working tree, and both will want to run the thing they built.
6. **Integration is a step, not an accident.** With disjoint paths the merge is
   usually mechanical, but lockfiles and generated output are not, so it is a Seat
   with a `check` behind it rather than a script nobody watches.

### UC6 — one agent builds a game, two play it, the match decides

*The judge is a program.* A maker ships a playable game with a headless referee;
two players compete; the result is mechanical.

```yaml
name: Build it then play it
roles:
  maker:  { uses: game-builder, grant: publish, isolate: true }
  gate:   { kind: check, run: pnpm verify }
  player: { uses: game-player, count: 2, isolate: true, grant: publish }
  match:
    kind: check
    run: node script/match.mjs --a $A_BRANCH --b $B_BRANCH --best-of 5
    exits: { 1: a-wins, 2: b-wins, 0: draw }
    otherwise: no-contest
  referee: { kind: person }

seed: { role: maker, title: "Build the game, with a headless referee" }

rules:
  - { on: maker,  when: { every: published },       then: { role: gate } }
  - { on: gate,   when: { every: pass },            then: { role: player, title: "Play to win — {{n}} of {{count}}" } }
  - { on: player, when: { every: ready },           then: { role: match } }
  - { on: match,  when: { any: [a-wins, b-wins] },  then: { role: referee, title: "Merge the winner" } }
  - { on: match,  when: { any: [draw, no-contest] }, then: { role: player, title: "Again" } }
```

1. **"Who won" needs no new mechanism.** A `check` role already maps exit statuses
   to outcomes, so `exits: { 1: a-wins, 2: b-wins }` is a referee that seats
   nobody, costs nothing and cannot be talked round. A best-of-five is the
   script's job, not the engine's.
2. **The desk can only witness what a program reports.** This is the constraint the
   whole use case turns on. If the game has no way to run a match and report a
   result, the winner is an agent's claim — and a rule may not read a claim. So the
   maker's brief must require a headless referee, which makes step three
   witnessable at all. The first deliverable is what makes the last one honest.
3. **The players are isolated lanes**, so each can run the game without fighting
   the other for a port, and neither can read the other's strategy.
4. `no-contest` is a distinct outcome from `draw`, for the same reason a stopped
   card has a named reason: a match that would not run is not a match that tied.

### UC7 — two agents compete in a web game

*UC6 with a browser.* The difference is entirely about what isolation has to
cover.

```yaml
roles:
  player: { uses: web-game-player, count: 2, isolate: true }
  match:
    kind: check
    run: node script/web-match.mjs
    exits: { 1: a-wins, 2: b-wins, 0: draw }
    otherwise: no-contest
```

1. **A lane has to be more than a worktree here.** Two Seats driving the same web
   game need a browser profile each, or they share the game's session and are
   playing as one player; and a port range each, or the second dev server never
   starts. Both belong to `isolate`, not to the flow author's shell script.
2. **The browser is already every Agent's tool.** Plugin tools reach every runtime
   over the same MCP surface, so no player needs a vendor-specific driver.
3. **The result still has to be reported by a program.** Either the game writes a
   result file, which is `diff` evidence at a revision, or a headless referee
   drives both sessions and exits with a code. An agent saying "I won" is not
   evidence, and this design does not let a rule pretend otherwise.

## What this replaces

| Today | After |
| --- | --- |
| Room as a roster you drop sessions into | Goal; membership derived from assignment |
| `Plan` inside a Room | The Goal itself |
| The standing room | A binding on the Project |
| `FlowRole`'s seven fields | `uses` + `count` + `seats` + `isolate` + `grant` |
| `seat:` naming the worker in a flow file | `uses:` names the Agent; `seats:` only overrides its seating |
| `seats: [...]` was the only way to vary a round | `seats: [...]` varies the model; `uses: [...]` varies the Agent |
| `when: { every: published }` | `evidence:`, with answers still allowed except at `merge` |
| `handoff` prose as the review contract | A findings ledger with stable ids |
| `abandoned` | A named stop reason |
| `FlowSeatRecord` discarded with the run | An immutable Seat record that outlives the Goal |
| No commit is linked to the session that made it | A ref observer, reconciled by patch-id, with capture health |
| A waiting role polling for work | A binding the desk fires |
| `isolate` means a worktree | A lane: checkout, port range, browser profile |
| Settings › Agents (the installed CLIs) | Settings › Runtimes; Agents becomes the roster of who |
| `agents/*` wire verbs, mixing a registry with two install verbs | `acp/*` for the registry, `runtime/installs*` for the machine |
| `~/.harnessdesk/agents.json` | Unchanged — it faces ACP, where the word is right |

## Decisions taken, and why

- **A binding belongs to the Project and names what to open.** Putting the stream
  on an Agent breaks as soon as a source should open a *team*: three reviewers with
  three bindings would open three Goals for one pull request.
- **The round is the publication unit.** It is the only way to have reviewers who
  are both blind and staggered, and staggering is what happens in practice when
  models queue.
- **Intake belongs to the Goal and its Project, not to a flow file.** A Goal with
  no flow still needs work to arrive; a trigger inside a flow file would give
  intake only to the rooms that happen to run one.
- **Answers survive everywhere except `merge`.** Requiring evidence for every
  transition would make any loop with nothing mechanical to check — draft, then
  critique — impossible to express. Requiring it for the irreversible step costs
  nothing that matters.
- **Finding ids are assigned by the host, not derived from code position.** A
  derived id drifts across a rebase, and an id that drifts is worse than no id: it
  silently reopens findings that were fixed and closes ones that were not.
- **The container is called a Goal.** `Task` and `Workspace` are the obvious words
  and both are spent — `Task` on the background-task panel and on cards,
  `Workspace` on checkouts. `Plan.goal` is already this field and `wrapped` is
  already this state, so the merge renames almost nothing.
- **One new vocabulary, not a set of them.** Every new noun is a word the reader
  has to learn before any sentence using it means anything. Two new nouns and one
  merge is the budget.

## The YAML in this document is the model, not the interface

Every flow above is written as a file because a file is how a policy gets
reviewed, diffed and shared. **It is not how a person should have to declare
one.** Nobody reads this design and concludes that the answer to "have three
reviewers look at every pull request" is *write YAML*; the file is what the
desk stores, the same way a commit is what git stores.

So the order of work is deliberate, and stated here so the intermediate state
is not mistaken for the destination:

1. **The foundation.** The nouns and the ledger: Agent as a directory, the
   seat resolution, the Goal merge, the immutable Seat record, Evidence with
   staleness, the findings ledger, the reduced flow engine, bindings for pull
   requests. At the end of this, everything in this document works and is
   declared in files.
2. **The interface.** Making the common shapes reachable without writing a
   file at all — pick the Agents, pick the shape, start; a round of three
   reviewers should be two clicks, and the file it wrote should be visible
   afterwards for anyone who wants to edit or commit it. This is also where the
   zero-configuration front door belongs, which is the one thing every
   comparable product has and we currently answer with an editor.

The foundation has to come first because an interface over the wrong nouns is a
rewrite, and the nouns are what this document is for. But a foundation that
only a YAML author can reach is half a product, and the second phase is not
optional polish.

## Not in this design

- Sources beyond `pull-request`, `issue` and `schedule`. Those three are one
  shape; anything else — an inbound mention, a failing check, a webhook — is
  shaped to fit but not specified here.
- A capability taxonomy that resolves "a strong reasoning model" to a seat.
  Ordered candidates plus an honest refusal covers it without inventing a
  classification we would then have to defend per model.
- An orchestrator Agent that assigns work on the merits. The person is the
  referee, and a flow is their policy written down. Nothing in this design
  summarises, judges or decides — a judging *step* like UC2's is a seated Agent
  the author chose, not the engine.
- Expressions in rule templates. One level of the finished round's evidence, and
  no more, so "can this rule ever fire?" stays answerable by reading.
- Line-level attribution. A commit or a diff resolves; a line would need blame
  intersected with the diff evidence.
- Per-Agent credentials or session stores. Both already have a plane.
- A shared semantic index across Agents. It is a real gain and a separate
  decision from this noun model.

# HarnessDesk — Vision

> Revise this when the market changes shape, not when the plan changes.
>
> This file is the promise and the position. The competitive reasoning behind
> them — the market map, the rival-by-rival comparison, the moat and the risk
> — is analysis of other people's products and is kept out of the repository.

---

## The vision

**Software work should not belong to an agent vendor.**

A developer should be able to hand a piece of work to whichever agent is best
for it, let several work on it together when that produces a better answer,
move it between their own machine and a server, and supervise all of it from
wherever they are — without rebuilding how they work around each vendor's
client.

The agents come and go. The best model changes every few months. Work starts
because a person asked, or because a pull request opened, a build failed, a
timer fired. It runs on a laptop, in a vendor's cloud, or on infrastructure a
team controls.

What should not change is who is in control of it: the work's context, its
rules, its tools, its history, its cost, and the evidence of what happened.

And as more of the work is done by agents, the answer to *why did this change?*
must not disappear inside one vendor's conversation history. Who did what, on
whose instruction, under which rules, checked by whom, on what evidence — that
is a record about your software, not about somebody's product, and it should
outlive whichever agent happened to produce the diff.

Stated once: **work goes to the right agents, under your rules, from anywhere —
and stays understandable afterwards.**

---

## The promise

Two sentences that outrank every roadmap item — and the ambition above them
too. A checkbox can be quietly un-checked under schedule pressure, and so can
an ambition, in the ordinary way that plans change. These cannot: everything
above is what this is trying to become, and everything below is how, but if
either ever requires breaking one of these two sentences, the sentences win and
the plan changes.

**Everything HarnessDesk can do on your machine keeps working without a
HarnessDesk account, permanently.** There will be hosted things — a service is
where this is going, not a possibility being kept open — and an account is the
price of the feature that genuinely needs a server, never a gate placed in
front of features that already work locally. "Continue locally" is a
permanent door, and choosing it costs nothing you had before.

**What is local, and what it takes to move any of it.** Agent credentials, API
keys, vendor sessions, source, terminal output, diffs, transcripts, browser
state and audit logs are local by default. Anything that ever syncs does so from
the smallest explicit allowlist, written as an allowlist, chosen by the person
whose data it is — never as a default, never as the price of an unrelated
feature, and never silently. **A lane whose server keeps a second copy of any of
it revises this document first, in public, before it ships any code.** That is
the order, and it is the whole of the mechanism: the promise moves before the
product does, or the promise was never worth anything.

The promise is not that nothing will ever leave this machine. It is that
*nothing leaves without you choosing it*, and that choosing not to costs you no
capability you already had.

---

## The one line

**HarnessDesk is where your agents work — whoever made them.**

A harness is the agent. A desk is where *you* work and where your tools sit.
Not one agent's window: the place all of them report to.

Said less warmly, because the category matters: **HarnessDesk is a control
plane for coding agents that you own.** Context, policy, history, tools,
coordination, cost and evidence live here — independent of which agent does
the work, where it runs, and which surface you are watching it from. The agents
are replaceable. What is around them is the product.

The macOS app is the first surface onto that, not the definition of it.

---

## Why this exists

A developer's machine today, unedited:

```
codex · claude · gemini · cursor-agent · dsh · deepseek-tui · openclaw · clawhub
```

Eight agents. Eight histories, eight permission models, eight config
directories, eight sets of credentials. No shared context between them, no way
to compare them, and no single answer to "what did the agents do in this
repository this week."

**A model vendor has little reason to fix this**, and every reason to fix it
only as far as its own agent stays the default. That is not a prediction about
what any of them will build — DeepSeek's own harness drives Codex today — it is
about whose interest the layer above the agents serves. A shell built by a
model vendor is a shell with a preferred worker, however many others it can
also run.

---

## What we promise

Five things, each worth more when the layer above the agents belongs to
nobody who makes one.

### 1. Every agent, one desk
One window, one history, one search — across Codex, Claude, Gemini, and
whatever comes next. Adding or changing a worker should not fragment the work
around it.

### 2. One set of rules
One permission policy, one approval surface, one audit log, whichever agent
asked. Today *N* agents means *N* policies and no coherent audit trail. Nobody
is standing on this.

### 3. No lock-in
History, workspace configuration, and extensions survive switching agents. The
best model changes every few months. That should be a dropdown, not a migration.

### 4. Agents that check each other
Two agents on one task, diffed. One reviewing the other's work, and a third
asked when they disagree. HarnessDesk can route, compare and arbitrate across
vendors without making any of them the privileged worker. The point is not more
agents; it is **independent work with visible provenance**.

### 5. Work does not stop at the laptop
Local is the default, not the boundary. Some work has to continue after the lid
closes. Some begins from a pull request, a webhook or a schedule rather than
from somebody typing. Some belongs to a team rather than to one developer, and
some has to be watched from a phone.

So there are two ways work starts here, and they are equals: **a person asks**,
or **an event arrives** — a PR opens, CI fails, a timer fires — and the policy
you already wrote decides which agents pick it up. A review that runs three
vendors' agents against one pull request and posts what they agreed on is the
same product as the window on your desk, and it should not need that window to
be open.

Work may run on this machine, on infrastructure you control, in a vendor's
cloud, or on ours. What must stay coherent across all four is the part that is
actually HarnessDesk: identity, policy, context, history, audit, cost and
provenance follow the work wherever it runs. An account is the price of the
things that genuinely need our infrastructure, and never a gate in front of
what already worked without one.

**The promise above governs every word of this**, and it is asking for two
different things.

The *first* time HarnessDesk itself becomes a place your working data lives is
a change of kind, not of degree, and it revises this document in public before
it ships. **This paragraph is not that revision.** Naming a direction is not
the same as deciding to be that.

After that, each lane is a change of degree, and amending a vision for every
execution topology is a rule people route around rather than follow — your own
Coder workspace, a vendor's cloud, a connected repository and an enterprise's
VPC are four different data movements and none of them is a new principle. What
each one owes instead: **before it can be switched on, it states exactly what
leaves this machine, where it is kept, for how long, and how you turn it off
and have it deleted** — and no new lane may quietly widen a boundary you
already agreed to. Those live in
[`docs/data-boundaries.md`](docs/data-boundaries.md), one section per lane, and
that document is where a reader checks what is true today.

**Almost none of this is built.** It is written here because the shape is
decided, and because a promise about servers is worth more before there is a
server than after.

---

## How it stays deep

The obvious failure mode for a neutral shell is the lowest common denominator —
supporting everything badly. Capability negotiation is what avoids it: each
backend declares what it can do as self-describing data, and the interface
renders that faithfully rather than an intersection. Full depth on Codex's
app-server when Codex is selected; full ACP everywhere else; one code path. How
that is held is in [`docs/architecture.md`](docs/architecture.md).

---

## The one thing this cannot become

**HarnessDesk decides who does the work, so it must never be a candidate for
that work.**

That is the whole of the rule, and it is about self-dealing rather than about
models. The moment there is a HarnessDesk coding agent that could receive the
work it hands out, every routing decision it makes carries a structural
conflict of interest, and *owned by no model vendor* is a sentence it can no
longer say.

What the rule deliberately does **not** settle: HarnessDesk orchestrates. It
routes work, compares what comes back, asks one agent to check another, and
acts on the answer. Doing that well may one day want judgement of its own —
whether that runs on an agent you already pay for, or on something built here,
is open and this document does not close it. An orchestrator is not a
competitor; a coding agent of our own would be.

Two habits worth naming, which are weaker than rules and stronger than
nothing:

- **Do not compete on being the best client for one vendor.** They write the
  protocol and ship first, and a feature that only helps the person who uses
  one agent is a feature their own client will have sooner.
- **The editor and the terminal serve the agent.** There is an editor plane
  and there is a terminal, and both exist because supervising an agent needs
  them — not because this is on its way to being a place you write code by
  hand.

Neither of those forecloses anything. If a version of this is genuinely better
because it does the opposite, do the opposite and change this page.

---

## Who it is for

**For:** developers running more than one agent; teams that need one policy
and one audit trail whichever agent asked; anyone who expects to switch models
again; and anyone who wants work to start from a pull request or a schedule
rather than from a person typing.

**Least useful to** someone who uses exactly one agent, interactively, alone,
and does not care what it cost or what it touched. For that person, that
agent's own client is better today — they write the protocol and ship first.
The moment any one of those four things stops being true, this is the thing
that helps.

That is a narrower exclusion than it used to be, on purpose. Policy, audit,
cost and event-triggered work are worth something with one agent too; it was
the multi-agent framing, not the product, that made them sound like they were
not.


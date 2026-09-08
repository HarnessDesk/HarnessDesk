# Where your data actually goes

[VISION.md](../VISION.md) makes a promise about this: everything is local by
default, nothing leaves without you choosing it, and choosing not to costs you
no capability you already had. That is the rule. **This page is what the rule
comes to in practice** — one section per lane, each saying what leaves this
machine, where it is kept, for how long, and how to switch it off and have it
deleted.

Two things follow from the promise and apply to every section below:

- **A lane states its boundary before it can be switched on.** Not in a
  changelog afterwards, and not in a settings screen you have already agreed
  to.
- **No new lane may quietly widen a boundary you already agreed to.** Turning
  on one thing is never consent for the next thing.

---

## Local — the default, and today the only one

Nothing leaves. Agent credentials, API keys, vendor sessions, source, terminal
output, diffs, transcripts, browser state and the audit log are files on your
disk, under `~/.harnessdesk` and your own repositories. The host binds a
loopback socket the renderer talks to; nothing listens on a routable address.

**Retention:** yours. Deleting the folder deletes it.

---

## Vendor clouds — already happening, and not ours to promise about

When you run Codex, your prompt and the context it gathers go to OpenAI. The
same is true of Claude Code and Anthropic, Cursor and Cursor, and every other
agent you sign in to. HarnessDesk does not change that, cannot change it, and
does not pretend to: **you chose that agent, and its vendor's terms govern
what it does with the work.**

What HarnessDesk owes you here is honesty about *which* agent is about to
receive something — which is why the composer names the agent and the model
before you send, and why the audit log records which one ran.

**Retention:** the vendor's, under the vendor's policy. Not ours to state.

---

## Everything else — not built

There is no HarnessDesk server. Nothing syncs, there is no account, and there
is nowhere for a second copy of your work to be.

The vision names lanes this project intends to grow into — work that outlives a
closed laptop, a team's shared audit trail, work that starts from a pull
request. **Each one appears in this document, with the four answers above,
before it can be switched on.** The first of them is also a change of kind
rather than degree, and revises VISION.md in public before it ships.

Until then, a section here would be a description of something that does not
exist, which is the one thing a document like this must never contain.

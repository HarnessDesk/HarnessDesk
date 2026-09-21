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
output, diffs, transcripts, browser state, the audit log, and what the desk
observed — every Seat it kept and every fact it recorded — are files on your
disk, under `~/.harnessdesk` and your own repositories. The host binds a
loopback socket the renderer talks to; nothing listens on a routable address.
To see a card's pull request and its CI, the desk asks your forge with your
own `gh`, in the card's checkout — the same tool, and the same account, the
desk already publishes with.

**Retention:** yours. Deleting the folder deletes it.

### Goal backups carry history, not authority

A HarnessDesk backup includes Goal documents, receipts, migration metadata and
lane descriptors after pending Goal writes settle. It does not include browser
cookies or storage, browser profile directories, worktree contents, live Seat
ownership, port reservations or the machine's lane preferences. On restore,
Goals are stamped as imported read-only history, operation journals are cleared,
and lane descriptors become released archives with no Seat or browser binding.
Nothing restored starts an agent, reserves a port or replays a wrap.

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

## Local provenance

Capture reads available refs and Git objects for registered projects on this machine. Its journal, immutable patch fingerprints, original Seat links and known history gaps stay beneath the project's folder in the host's evidence directory. It retains neither raw patches nor another transcript or brief body. It contacts no remote and never fetches a missing object.

**Retention:** observations remain until the corresponding local evidence data is removed; disabling capture keeps existing history. Workspaces › a project › Provenance turns capture off for that project on this machine, including its linked checkouts. The preference lives in `provenance-preferences.json` in the host state directory, outside the repository.

A backup may carry the versioned, size-limited historical sidecar. Restored records are marked historical; imported cursors, health and preferences do not activate capture or authorize new local associations. No provenance data leaves unless the person chooses to export or share it.

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

## Insight observations

Insight reads agent-owned transcript corpora and foreign database snapshots;
it never writes them. Source identifiers emitted to the renderer are opaque
and do not contain transcript paths. Historical turn observations live beside
the host transcript, not in evidence or receipts. They are absent for old
transcripts rather than inferred from current configuration.

---

## Local — the default

Your work does not leave. Agent credentials, API keys, vendor sessions, source, terminal
output, diffs, transcripts, browser state, the audit log, what the desk
observed — every Seat it kept and every fact it recorded — an Agent's own
declared skills and MCP servers, a person's local approval of an Agent-local
bundle, and every retained project-memory citation, are files on your disk,
under `~/.harnessdesk` and your own repositories. Reviewing a repository's
`AGENT.md` and the bundle beside it never runs anything on its own — it only
ever produces bytes a person reviews before they are trusted to load. The
host binds a loopback socket the renderer talks to. Managed chat ownership
paths, including canonical aliases, are stored in local preferences and sent to
connected desktop clients as a versioned snapshot; the push carries no other
preferences. A failed write can leave that ownership in memory until restart;
backup import can replace it. Local phone access adds a
LAN listener only when explicitly enabled, as described below.
The desktop cache snapshot request may return a conversation already held by
the host, with its local revision, sequence and transcript identity. It is not
available on the limited client surface.
To see a card's pull request and its CI, the desk asks your forge with your
own forge login in the card's checkout. Publication uses the separately pinned
host gateway described below. A flow's check command may read
`HARNESSDESK_FLOW_CONTEXT`: bounded, host-derived JSON naming the revision,
checkout and lane ports a round's own subjects are — never an arbitrary
environment map, and never anything that was not already visible in the
checkout the command runs in.
When a conversation reaches its usage limit and carries on with another agent,
the desk copies its recent text into a new conversation with that agent, which
then goes to that agent's vendor (see [Vendor clouds](#vendor-clouds--already-happening-and-not-ours-to-promise-about));
this is on by default and is turned off with **Use other agents too** in
Settings › Permissions.

`harnessdesk mcp` speaks only to the MCP client that started it, over standard
input and output, and to the desk's local socket. It makes no network request.
The number of starts MCP clients have made today is kept in
`client-starts.json` in the desk's state folder.

**Retention:** yours. Deleting the folder deletes it.

The app does ask the network a few questions of its own — whether a newer
build exists, what a model costs, which agents the registry lists. None of
them carries your work; each one is listed
[below](#what-the-app-itself-asks-the-network-for).

### Git publication and its local record

The host gateway uses the person's forge credentials to push an exact commit
and tree to an approved, pinned repository. Pushes send Git objects and an
explicit branch refspec and lease. Pull-request creation, updates, reviews,
merges and comments send their requested fields and text to that pinned forge
repository. The first repository push and rewrites require approval; owned
branch continuations are bound to the recorded requester and head. Settings ›
Permissions chooses Ask, Always or Never for steering an agent's own writes,
with project overrides, and controls recording of observed outside heads.

Pins, private mirrors and append-only Git records stay in the host state
folder. Records retain requester, operation, repository, branch or PR, head,
approval, time and outcome; command observations omit bodies and URL userinfo.
Outside attribution comes from remote observation. Disabling outside recording
stops those observations being recorded; gateway writes remain recorded.
Existing local records remain until removed with their state. Published Git
objects and forge text follow the remote service's retention rules.

For a pull-request review, the host reads the PR number, head, destination
ref and destination commit from the pinned GitHub repository. Without a pin,
it reads the explicit GitHub origin proposal for an informational review;
that review cannot authorize an automatic merge. Before an automatic
review-backed merge it reads the PR and destination branch again. After a
merge submission, and when reconciling an uncertain submission, the host asks
GitHub's GraphQL API for the PR state, merged flag, merge-queue entry and
auto-merge request. These on-demand reads name the repository and PR number;
they use the existing host forge login. No review text or local journal is
sent with these reads. The observation is point-in-time and is not an atomic
lease on the destination branch.

When a detached conversation omits the PR number in view, checks, review or comment, the host reads that conversation's intact successful creation records locally and asks the pinned GitHub repository for each recorded PR's number, state and head branch. The outbound request names the repository and PR number and uses the host's existing forge login; the local journal and conversation identity are not sent. Follow-on plugin view and checks reads explicitly name the pinned repository on github.com through the existing shell grant; the review-link API read also names github.com as its hostname. This is on demand, with no background polling. Only a unique open matching creation is selected; the capability returns minimal selection metadata, and the existing tool reads and write checks still apply.

Settling review threads adds three GraphQL requests to the pinned GitHub repository, all on the host's existing forge login and all on demand. Before a settle, and when a plugin lists them, the host reads the pull request's review threads: one fixed query naming the repository and PR number as variables, returning the signed-in login, up to 100 threads with their id, path, line, resolved state, and each comment's author login, author type and body, and whether more threads or comments exist. A fixed thread is resolved with `resolveReviewThread`, which sends only the thread id. A declined thread is answered with `addPullRequestReviewThreadReply`, which sends the thread id and the one-sentence answer with the desk's marker line before it. Review text read back stays in memory for the call; only the first comment, bounded, goes to the plugin. `review-threads.json` in the host state folder keeps, per repository and PR, the repair rounds in which each bot reviewer's threads were settled and the ids of threads the desk answered. It holds no review text and stays until removed with the host state. A copy that cannot be read is renamed `review-threads.json.corrupt-<time>` beside it and kept for the person to inspect or remove.

### Optional local phone access

`HARNESSDESK_PHONE_LINK=1` enables a LAN WebSocket listener. Settings › Phone
issues a code containing the desk's public key, local endpoints and an
enrollment secret that works once for ten minutes. The phone proves its key;
the person allows or declines it on the desk. Pairing requires no account link
and sends nothing to the account service. Session traffic is encrypted between
the paired phone and this desk.

A paired phone can receive the Lead thread and redacted work projections,
page active and archived session metadata, and read their redacted transcripts.
It also receives up to 50 sorted, scrubbed admitted project names for starting
a session, including projects with no sessions yet; ambiguous names and the
folders the desk makes for no-folder chats are omitted, and no project root
paths are sent. A session with no title of its own is named, as on the desk,
from the scrubbed first line of its opening message.
Command output tails are limited to 40 lines, 300 characters per line and 8 KB
per step. Diff hunks carry at most 400 lines per file and 1,500 per turn,
300 characters per line; totals remain complete. Both are scrubbed like
transcript text, with absolute paths rewritten to project paths and
key-shaped strings and addresses redacted. A serialized thread is capped at
512 KB, retaining recent entries and bounded recent hunks so it fits the relay.
With Run it can create a session in an admitted project or a fresh chat folder,
send text to an active ordinary session, and interrupt a supported running
turn. These actions reuse the desk's host methods without changing session
permissions. New sessions may choose a model and effort from the default
runtime's own catalogue; the phone receives its model names, descriptions,
effort choices and fast-tier capability, never a hard-coded model list. It
also receives up to eight agents a session can start on, default first. Each
has an opaque runtime id, the adapter's own scrubbed name and that agent's
model list; none carries a path or account. A snapshot never starts an agent
for this. An agent other than the default shows the models the desk already
holds, or none if the read is slow or fails. A start may name one of those
agents; its model and effort are checked against that agent's own catalogue. It can also send to the Lead, stop or resume
it, answer its cards and permitted worker questions, and request required
checks. Approval decisions require Answer, as does setting or turning off the
Lead's spending limit; the phone never changes the Lead's other settings,
permissions or key. Read, Run and Answer grants bound its
surface. Lead worker cards can carry complete bounded request details, including
extra permissions. Saved approvals expose target descriptions and counts; each
automatically allowed file change adds its exact bounded diff to that rule’s
retained entries in `savedApprovals`. The paired phone receives this bounded
history, including read-only revoked rows and an uncertainty flag for unacknowledged dispatches; it is excluded from the Lead provider conversation. Each paired phone also gets a push key of its own when it pairs, inside the
encrypted session, and again on every later sign-in, so a phone that did not keep it has it again; the desk seals
that phone's pushes with it (see the account section) and no service ever holds it. The desk identity, paired-device keys and push keys, grants, revocations and port
live under `phone-link/` in the local state folder. Removing a phone closes its
connection and requires pairing again; starting without the opt-in closes the
LAN lane. Account sign-out and deletion do not remove this separate registry.

### Optional Lead provider requests

Lead requires the startup opt-in `HARNESSDESK_LEAD=1`, a configured provider key
and a runtime whose permission model blocks the network for its restricted
child. The desktop app's bundled Node is downloaded from nodejs.org when the app
is built or started from source, never by the installed app. Source startup
uses the same pinned SHA-256 verification and continues if the fetch fails. Its host sends model requests containing
the project root, system instructions, conversation, approved contract and tool
results to the configured provider transport. When asked to manage project chats,
these results can include their titles, state and redacted transcript projections.
Chat reads are bounded to 12,000 serialized bytes, with separate counts for
omitted raw source turns (`omittedSourceTurns`) and projected phone entries
(`omittedPhoneEntries`); partial text still sets `truncated`. The phone wire
does not serialize this projection metadata.
Desk-wide read-only tools can also send summary counts, titles, project display
names and states across every project, plus cached account allowance windows,
balances, reset/run-out timestamps and their basis, freshness/errors, running
session totals and cached spend. Allowance is projected field by field from the
Dashboard cache without requesting a vendor refresh; account addresses,
identifiers and credentials are omitted. Accounts share a presentation name and
are distinguished by plan and ordinal. Each account also says how many minutes old its
reading is and whether the last refresh failed, and the summary names the account
to use first with its window, what is left and its reset (`pacing`); all of it
comes from the same cache. A paired phone's usage rows carry the same
`refreshFailed` flag and, when an allowance is about to be lost, a `pacing` entry
(the row's id and name, the window, what is left, the reset and the read time);
no account address travels in either. The phone's agent, allowance and session
rows (`PhoneWorkAllowance`, `PhoneSeatUsage`, `PhoneSessionRow`, `PhoneAgentLabel`,
`PhoneAgentChoice`) also carry an optional `brand`: the key of the mark the desktop
draws for that agent (`brandForRuntime`), lower-case letters and digits only, never
a label or an account. Skill-use counts are a separate read.
For transcript reads and chat actions, only ordinary sessions in the selected canonical project are available; Team
seats and other projects are refused. Chat state notifications contain ids and
state, not transcript bytes. Ordinary delegated chats use the desk's saved session
permissions and their agent's existing connection and spend. Provider credentials stay in the
host; the child asks through a bounded provider-send port. Workers retain their
own agent connections. Lead's journal, plan decisions, allowances and worker
observations stay in the desk's state folder, as does its work ledger,
`lead/work.json`: work titles, project display names, chat, Team and pull
request references, host-written stage facts (including whether the person or the Lead stopped a chat, with the turn it stopped, recorded as the stop is sent and kept at most a minute), and the Lead's own notes, at most
256 items and closed items for 30 days. It also holds the reminders the Lead set: each one's text (at most 200 characters), whom it is for, the item it belongs to, its due time and whether it is set, fired or cancelled, and for a fired one whether the Lead's message about it was written (`delivery`: said or missed, with `deliveredAt`), plus the key of its last wake and whether it was retried (`wakeKey`, `retried`, kept in the file and never sent); at most 20 are set at once, and an ended one is kept for 7 days. Reminders ride the same Lead request block and the same phone board, scrubbed, and nothing else. A ledger file that cannot be parsed is renamed beside it as `work.json.corrupt-<time>`, never sent anywhere. Up to 3 KB of the open items rides each
Lead model request; a paired phone reads the same board, scrubbed.
Presence is kept in `lead/presence.json` in the same folder: for each window or paired phone an opaque device id, its short label, when it last looked and which digest it dismissed; the spans of the last few digests dismissed on any device, each with the journal revision and spend where its digest was built (no device name), the revision and spend where each pending digest ends, and which brief was dismissed; the clock and answer receipts (option label, device label, time) for asks that set one; the morning brief setting; and the day's observer spend. Nothing in it leaves the desk except the digest itself, which a paired phone reads and the optional summary call sends to the provider the Lead already uses: the digest's item titles, facts and counts (at most eight items), under the Lead's key, nothing else from the thread. Those titles now also come from the desk itself and from what the person or the Lead kept and set: the titles of desk Teams and chats that came to need the person or finished, the text of notes kept in memory, the text of the person's reminders that fired, and the names of settings applied, each clipped to the digest's title length. The morning brief's push still carries counts only (needs you, reminders, done, stopped), never a title, a note or a reminder's text, and a brief with nothing those counts cover pushes nothing. A host of another version reads the record leniently: unknown digest fields are left out and only a digest it cannot read is dropped; a host older than this change does not know the new digest fields and sets the file aside, starting presence empty (seen marks, asks' clocks and the brief setting), which loses no work or thread. Phones read the digest through the same view and ignore fields they do not know. The morning brief rides the phone link's `notices` topic as a title and body capped at 80 and 240 characters. Stop ends the active request and
owned work without deleting files; disabling the startup opt-in leaves the
journal on disk. The desktop probes its embedded runtime first, then its bundled or locally
fetched Node. If no candidate passes, Lead reports unavailable before sending
a request.

Autonomy is kept in `lead/autonomy.json` in the same folder: the full version history of each of the three rule sections the person edited (their own words, up to 3000 characters a section and 20 versions), what the person has acknowledged of a changed default, the deadline of the goal in hand (the goal's id and two times), the history of the person's changes (the last 64: the time and, for each, a mode moved from and to, a rules section and the version saved, or the deadline set or cleared; no words of the rules), and the ids of the live runs the Lead started on its own, which the host counts against its cap. The modes, the sections in force and the deadline are also in the Lead's journal. Nothing in the file leaves the desk except through the Lead's own request: the sections in force are part of the standing instructions of a new conversation epoch, so the provider the Lead already uses receives them under its key, nothing else from the file. The file also keeps the Lead's last 16 proposals to change a mode or a rule section, each with its words (a line to add, or a section's new words, up to 3000 characters), its state, the place in the conversation it was made (the Lead's journal position and the person's latest message), the shipped default's version when it was made over unedited words, and its last 8 events with their times; and the person's last 32 Noes, each the proposal's id, a key for the change (the kind and mode, the section and the added line, or a hash of a section's whole words), the time and the person's message position. A proposal's words leave the desk only as the person's own section once they apply it, and the Lead's own requests carry each proposal's state, times and up to 200 characters of its words. A paired phone reads the modes, the sections in force, the newest five saved versions of each edited section with their words and the shipped words, the deadline and the 32 newest changes, and the proposals, with the Lead's words scrubbed like the work board, and can change a mode and apply or decline a proposal, except that a section's whole new words, and a line the scrub changed, are applied at the desk; it cannot edit the words.

The host keeps the Lead's provider conversation in the Lead state folder:
`context.jsonl` (the turns and tool results as sent, bounded at 2 MB, desk
context of each moment replaced by a one-line stub and model reasoning never
stored) and `context-checkpoints.json` (the latest eight summaries, oldest
first; a summary that fails the reply screen keeps its place without its text).
The summary's section of the person's words is built on the desk from the
person's messages in the Lead's journal, never from what the model wrote or
from an earlier summary's text, and is stored and served as data (each
message's reference and text); the model's own text before its first section
is dropped. The approved plan is stored once, as the host sent it, and sent
again after a summary replaced the part that held it. When the
conversation fills, or the person chooses Summarise now, the host sends the same
conversation to the same provider with one more instruction and stores the
summary it writes; if that fails, the host builds one from the conversation
itself without a request. Each request marks up to four places the provider may
cache; the provider's cache read and write counts are kept in the wake ledger,
and the spend of a summary request is filed marked as compaction.
`lead/context/read` gives the window and a paired phone (read tier) the
context-use and cache facts and the kept summaries' text; it changes nothing.
`lead/context/use` gives the Lead about itself and a paired phone (read tier)
four numbers: the window's size, the latest request's prompt size, that as a
percent, and when the conversation was last summarised, with how long ago in
the desk's words ("2h ago"). No conversation text.

`lead/inbox/read` gives the window and a paired phone (read tier) the one list
of what waits on the person: the Lead's own row with a count, an open question,
waiting Teams and chats, and the kept notices. It is built on the desk from what
the desk already holds and sends nothing anywhere. Every title and body passes
the phone scrub first (titles cut to 160 characters, bodies to 300, and paths on
this machine, addresses and key-shaped strings replaced), on the window as on the phone; ids,
kinds, times, counts and project display names go as they are.

The Lead's memory is kept in the same folder. `lead/memory-store.json` holds the notes (each at most 400 characters, at most 400 in all), the proposals waiting for the person (at most 24), a normalised copy of the proposals the person declined (at most 200, each with the place in the conversation where it was declined, so the same one is not offered again until the person says it again), the Lead's last 40 proposals with what became of each (waiting, kept, kept in the person's words, declined or forgotten, the entry it became, the date, up to 8 dated events such as proposed or asked again, and its words, which Forget and Forget all take out), the date of the last Forget all, the last 40 versions for Undo, whether the Lead may keep its notes without asking, and the day's tidy spend. `lead/memory-conversation.jsonl` is the search copy of the Lead's conversation: the person's messages and the Lead's replies, each cut to 4,000 characters and dated when the desk first saw it, the latest 4,000 kept, and the ids of passages Forget took out (no text). Both are written with owner-only permissions. A store that cannot be read is renamed `memory-store.unreadable-<time>.json` beside it and never sent anywhere. `lead/memory.json`, where earlier versions kept the Lead's memory lines, stays in place and is read once to carry its lines across. Core, at most 6 KB, rides the Lead's model requests in its standing instructions; search results, at most 2 KB, ride the request that asked for them. Search runs on the desk. Once a day the tidy sends the observer model the Lead's own notes (at most 80, each quoted with its id, kind and date) under the Lead's key, and nothing else: the person's notes never leave the desk for it, and a tidy that would cost more than what is left of its daily cap is not sent. Forget removes a note from the store and from every saved version of it, including the notes a tidy merged into it, and drops the passages of the search copy that quote it (its words, however spaced, cased or styled, or nearly the same words); a passage that says it in other words stays searchable. Forget all removes every note, proposal and version and empties the search copy. Neither touches the Lead's journal, `lead/<thread>.ndjson` and its sealed segments, which are kept: its `memory-core` records hold each Core the Lead was given and its `memory-epoch` records the Core an epoch began with, note text included, its checkpoints carry the same, and the conversation a note came from stays in its message records. A paired phone reads the inbox and the counts (read tier) and can keep or decline a proposal and forget one note (answer tier); it cannot propose, search, add, edit, move, undo, forget all or change automatic keeping. Memory never goes into a worker's prompt.

### An armed trigger polls the same forge, on its own schedule

Once a project's trigger is explicitly armed on this machine, the desk polls
that forge — as the same signed-in person, with no new credential minted —
without a person asking each time, which is a different boundary from
reading a card's pull request on demand, and the arming review says so before
the switch takes effect: what it reads, how often, and that a fork's contents
are never read for anything beyond deciding whether to open a read-only
review. What it reads becomes bounded, validated facts a firing acts on, held
locally in this machine's own trigger consent, cursors and admission journal
(`~/.harnessdesk`) — never a second copy of the forge's own data, and never
free text from a PR or an issue treated as anything but information. Pausing
or disarming stops the polling immediately; deleting the state folder deletes
the consent and everything it recorded, the same as any other local file.

A mention trigger also reads the repository's issue comments, the issue or
pull request a comment is on, the account behind a named person or bot, and
the comment author's permission, all as the same signed-in person. Its
decisions, the comment's first 280 characters as an excerpt (left blank when
the comment looks like it holds a credential, on the desk and on the phone),
a digest of the comment's text (so Re-evaluate can tell it was edited), its
observe/act mode and its work threads (with the asking comment's URL and the
Lead work item the thread is on) are kept in `triggers-mentions.json` in
the state folder, at most 500 decisions and 256 threads. With the Lead on, an
accepted thread is also an item in `lead/work.json`, linking that comment's
URL, the issue or pull request reference and the thread's Teams; nothing
about it leaves the machine beyond the Lead's work cards described above. A
comment that stops the Lead's goal is recorded in the Lead's journal by its
URL, on the stop it caused. Who may ask is read
from the forge at most once in five minutes per account. While a work thread
has no pull request, the issue it follows is read on each sweep to see
whether it closed. With the Lead
enabled and a key configured, each comment that passes the trigger's rules is
sent once, as data, to the Lead's provider for a one-sentence assessment: the
trigger id, its handle and what it opens, the repository, the thread's kind,
number and title, and the comment's author and text. A comment that looks
like it contains a credential is never sent, and at most 200 are sent a day.
Each such request is held against the Lead's spend limit before it is sent:
a reserve, then a settle at the usage the provider reports (or the whole hold
when that cannot be known), are written to the Lead's journal like the Lead's
own requests. With no Lead goal open, or the limit reached, nothing is sent.
The paired phone reads the decisions list (`phone/triage/list`) read-only, with
the armed mention triggers beside it: each one's id, project folder name,
repository, mode on this machine, `from`, and its named people and bots (forge
logins the triggers file already names).

A trigger armed for `@harnessdesk` requests on pull requests also reads, as
the same signed-in person, one repository-wide list of conversation comments
updated since the comment window opened, and never since before the earliest
trigger that asks was armed
(`issues/comments?sort=updated&direction=asc&since=…`, paged), whatever number
of pull requests moved; the reviews (`pulls/{n}/reviews`) of those pull
requests the source's existing list read shows as updated, every page, and
once more, five minutes later, of one read within five minutes of its update
— from the page that held the last review it listed, and the whole list again
only when that review has moved off its place or the list showed a draft, at
most 20 pull requests a poll and the rest on the next;
the inline comments of each review newly submitted there
(`pulls/{n}/reviews/{id}/comments`); and, for a comment on a pull request that
list did not show, or one whose reviews are read again after it left the list,
that one pull request (`pulls/{n}`). An issue's comment in the list is dropped
unread. Every comment that asks — and only those, on issues and pull requests
alike — has its edit history read in one GitHub GraphQL query per poll (per
issue, for an issue trigger) of at most 100 comments: a fixed query that sends
only the comments' node ids, as their REST answers named them, and reads back
for each its kind, `lastEditedAt` and `includesCreatedEdit`; it changes
nothing, and it counts against the same signed-in person's GraphQL rate limit,
about one point a read. With
`from: collaborators` the author's permission is read once per author in a
read, only for a request the forge says was never edited — after its edit
history is read, so an edited request never costs that read. What it keeps beside
the trigger's cursor is only what it handled inside its windows — comment,
review and pull request ids with a time, and for a pull request awaiting its
second read the count and last id of the reviews it listed, at most 2,000,
dropped as the windows move — and the time of the newest comment a complete read covered, and each
request as an admission fact: its comment or review URL, the author's account
digest, whether the forge says it was never edited, and the words after
`@harnessdesk`, clipped like every other body. Those words, the thread's title and its links
are sent to the Lead's model provider when the request is handed to the Lead,
inside the untrusted-context fence, on the same terms as every other Lead
request; words that look like they hold a credential are replaced before they
are sent. Nothing is posted back to the thread.

**Retention:** yours. Deleting the folder, or disarming the trigger, stops it.

### Goal backups carry history, not authority

A HarnessDesk backup includes Goal documents, receipts, migration metadata and
lane descriptors after pending Goal writes settle. It does not include browser
cookies or storage, browser profile directories, worktree contents, live Seat
ownership, port reservations or the machine's lane preferences. On restore,
Goals are stamped as imported read-only history, operation journals are cleared,
and lane descriptors become released archives with no Seat or browser binding.
Nothing restored starts an agent, reserves a port or replays a wrap.

### Memory citations and Seat attachment history restore as history, never as a grant

A backup also carries every retained project-memory citation (the exact
cited bytes, the source Goal's receipt and the Seats that were there) and
every Seat's frozen attachment history. It never carries a person's local
attachment approvals, a staging directory, a gateway token, an MCP server's
address, or any other live capability state — none of those travel, and
restoring a backup never grants one. An imported Seat attachment epoch is
always marked restored and never shown as currently loaded; an imported
citation can satisfy only the one dependency edge it originally created,
never authorize a fresh Goal. One damaged object in an otherwise-good backup
is refused and counted, never silently dropped from a total that then reads
as complete.

---

## What the app itself asks the network for

Local is not the same as offline. Apart from the agents themselves, the forge
reads above, and what you open yourself — a page in the browser pane, a
`git fetch` from the Git panel — the following are its maintenance requests, read from the host and shell on
2026-10-25. The optional account and Lead requests are listed in their own
sections.
None of them carries source, a prompt, a transcript, a diff, or anything the
desk observed. Each maintenance read fails quietly: an answer that does not come leaves the
last good copy, or nothing, in its place.

- **App updates.** The packaged app asks its release feed — the project's
  GitHub releases — 30 seconds after launch, every four hours after that, and
  whenever you choose **Check for Updates…**. The request is for the feed
  itself; an update it names is downloaded and installs when you quit.
  `HARNESSDESK_NO_UPDATE_CHECK=1` in the app's environment turns this off
  entirely, and `HARNESSDESK_UPDATE_FEED` points it at another feed. A build
  from source never checks unless it is given a feed.
  (`packages/desktop/electron/app-updates.mjs`)
- **Agent update advisories.** For each agent that names its npm package, the
  host reads that package's `latest` tag from `registry.npmjs.org` — at most
  once a day per package, remembered in `update-checks.json` in the state
  directory — so it can say an agent is behind. It sends the package name and
  nothing else, and installs nothing. The same `HARNESSDESK_NO_UPDATE_CHECK=1`
  turns it off. (`packages/server/src/updates.ts`,
  `packages/server/src/bootstrap.ts`)
- **Model prices.** The usage ledger fetches the public, keyless price
  catalogue at `models.dev` at most once a day and keeps a copy in the state
  directory's cache. The request carries no account and no usage.
  There is no switch for it today; prices you set in `pricing.json` take
  precedence over the catalogue but do not stop the fetch.
  (`packages/server/src/ledger/pricing.ts`)
- **The ACP registry.** When **Add a runtime › Browse more…** lists it, or the
  desk checks whether an agent added from it has a newer version, the host
  reads the registry document from `cdn.agentclientprotocol.com`, asking again
  at most every six hours. Adding a binary entry downloads that agent's archive
  from the address the registry names; an `npx` or `uvx` entry's runner fetches
  its package the first time the agent starts. `HARNESSDESK_ACP_REGISTRY_URL`
  points the host at a registry of your own.
  (`packages/server/src/acp-registry.ts`)
- **What an account has left.** For an agent you have added whose vendor
  publishes the figure only on its own servers, the host asks that vendor —
  Cursor, Gemini Code Assist, GitHub Copilot, Cline, OpenRouter, DeepSeek —
  with the credential that agent already holds on this machine, read-only and
  never refreshed or written back. The credential goes only to the vendor that
  issued it; what comes back is a quota or a balance, kept on this machine. For
  Cursor, whose dashboard is the only record of per-request usage, the ledger
  also reads those events from the same account. A reading is asked for after
  that agent finishes a turn and when the last one has gone stale; an agent
  with no credential to read is asked nothing. Removing the agent stops it.
  (`packages/server/src/usage/`)
- **A skill from a repository.** Adding or previewing a skill from a GitHub
  address fetches that one repository over HTTPS with `git`, anonymously —
  your credential helpers and `.netrc` are cut off — within 64 MB and 60
  seconds. Only when you ask. (`packages/server/src/library-sources.ts`)
- **Test connection on an MCP server.** Only when you click it on one copy of
  a server, the host starts that server from the declaration on disk — never
  from anything the window sends — asks it to initialize and list its tools,
  and stops it, within 15 seconds. A local command runs in its own process
  group with the variables it declares on top of a minimal environment (no
  HarnessDesk variables, a proxy without its user name and password, in the
  project folder for a project's server). The same environment, and the same
  group, serve a tool call or listing an approved attachment server makes. The
  environment is `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, the locale names
  and every `LC_*`, every `XDG_*`, `TZ`, `TMPDIR`, `TEMP`, `TMP`, the proxy
  names (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and their lower-case forms),
  the certificate names (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
  `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`), and on Windows
  `SystemRoot`, `windir`, `ComSpec`, `PATHEXT`, `USERPROFILE`, `APPDATA`,
  `LOCALAPPDATA` and `ProgramData`; no credential, token or agent socket is
  among them; a remote server is asked at the
  address it declares, with the headers it declares, no redirect followed,
  and its session ended afterwards. A server the project's own file declares
  shows its exact command or address first, with the variables that decide
  what starts. What comes back is a tool count and the server's name;
  variable and header values never appear in the answer, and a server that
  asks for sign-in is not signed in to. (`packages/server/src/mcp-test.ts`)
- **Plugins, on request.** The built-in **web** plugin fetches a page only
  from hosts you have added to its allowlist, which starts empty; a plugin you
  install from npm is downloaded when you install it.

**Retention:** the caches and readings above are files in `~/.harnessdesk`,
and deleting the folder deletes them. What the far end keeps of a request is
that service's policy, the same as any request your machine makes.

---

## Vendor clouds — already happening, and not ours to promise about

When you run Codex, your prompt and the context it gathers go to OpenAI. The
same is true of Claude Code and Anthropic, Cursor and Cursor, and every other
agent you sign in to. HarnessDesk does not change that, cannot change it, and
does not pretend to: **you chose that agent, and its vendor's terms govern
what it does with the work.**

A gateway account you add is the same boundary one step closer: its
conversation's model requests leave through a loopback process on this machine,
to the provider you named, with the key you gave it.

What HarnessDesk owes you here is honesty about *which* agent is about to
receive something — which is why the composer names the agent and the model
before you send, and why the audit log records which one ran.

**Asking another agent.** When a Flow lets a seat use `ask_agent`, the
question, the optional context, and whatever files the asked agent reads in
the caller's checkout go to that agent's vendor, the same as any conversation
on that agent. The desk adds no endpoint of its own. The conversation is
deleted from the agent's history after it answers, where the agent allows
deletion (`deleteSession`). The answer is kept only in the caller's
transcript; the audit log records which agent was asked, how the ask ended
and its sizes in bytes, never the words.

**Retention:** the vendor's, under the vendor's policy. Not ours to state.

---

## HarnessDesk account — only after you choose Sign in

The host sends its public key and desk name to the configured HarnessDesk
service (`app.harnessdesk.app` by default). The browser shows that name and a
short code matching the desktop. Linking requires an explicit approval on
that page. The host polls the result, proves its key to obtain a desk session,
and reads account name, email, picture URL and linked-phone metadata. The
host fetches the picture over HTTPS without browser cookies or a referrer,
accepting only a bounded raster image at a public address. It passes image
data to the renderer; the renderer keeps its local-only image policy. No prompt, file, transcript,
agent credential or project path is sent through this lane; a push to a linked phone travels sealed, as described
below, and the service cannot read it.

The desktop host's complete account request inventory is below. Paths are
relative to `https://app.harnessdesk.app` by default. JSON requests carry
`Content-Type: application/json`; authenticated rows carry the renewable desk
token as `Authorization: Bearer …`. Host JSON requests have a ten-second deadline; picture downloads have a
five-second deadline. Both refuse redirects. The browser handles its own sign-in session; its cookies
never become the desktop's desk token.

| Request | What it carries | When |
| --- | --- | --- |
| `POST /v1/desk/challenge` | Empty JSON object | Before starting a sign-in or obtaining a replacement desk session |
| `POST /v1/desk-link/start` | Desk public key, desk name, challenge and signature proving the desk key | After choosing Sign in, once the challenge arrives |
| Browser opens `GET /link#code=…` | Verification URL with the short code in its fragment; the fragment is not part of the HTTP request | After creating the pending request, or choosing Open page again; the person approves the named desk in the browser |
| `POST /v1/desk-link/poll` | The pending request's poll secret | While approval is pending, at the service's interval clamped to 1–30 seconds; also during best-effort unfinished-sign-in cleanup on Cancel or startup |
| `POST /v1/desk/session` | Desk public key, challenge and signature proving the desk key | After approval or whenever the saved desk session has at most 60 seconds left; it follows a new challenge |
| `GET /v1/desk/account` | Desk bearer token; no body | After approval, on restoring an existing sign-in and while signed in at intervals of 1–60 seconds, bounded by session renewal; transient background failures retry after 30 seconds |
| Picture `GET` to the returned HTTPS picture URL | Raster accept header; no cookies, credentials or referrer | When account metadata names a picture not already cached; the host validates the public address and bounded image before supplying local image data |
| `POST /v1/desk/rename` | Desk bearer token and new desk name | When Rename is confirmed while signed in; a signed-out rename only saves locally |
| `POST /v1/links/revoke` | Desk bearer token, desk id and phone device id | When Unlink is confirmed in Account; followed by an account refresh |
| `POST /v1/desks/revoke` | Desk bearer token and this desk's id | On ordinary sign-out, or best-effort cleanup of an approved but unfinished sign-in; local-only sign-out makes no account request |
| `POST /v1/account/delete` | Desk bearer token and an empty JSON object | After confirming Delete account; session renewal may first obtain a challenge and session |
| `POST /v1/invites` | Desk bearer token and an empty JSON object | When Show code or New code is chosen in Settings › Phone while signed in, Reachable from your phone is on and the phone link runs; the one-time invite goes into the pairing code only |
| `POST /v1/links/revoke` (queued) | As above | After a phone the account linked is removed in Settings › Phone; while the account cannot be reached, the device id waits in `relay-unlinks.json`, in the phone link's folder under the HarnessDesk home, and is sent once it can |
| `POST /v1/push/send` | Desk bearer token; the phone's device id, its push key's number (`kid`), a 12-byte nonce, the sealed push, priority `high`, and a collapse tag (22 characters of a SHA-256 hash of the item's Inbox id) | When something newly appears in the Inbox as needing you, while signed in with Reachable from your phone on and the phone link running: one request per phone the account linked to this desk that is also paired here with Read. An item is pushed once, and not again if it returns within ten minutes; what already waited when pushing began is not pushed. The desk sends at most 30 a minute, 12 a minute per phone, holds off for a minute after the service says too many, and leaves a phone alone for ten minutes after the service has no push token for it. A failure is logged and dropped |

The sealed push is AES-GCM under that phone's own push key, bound to its device id and key number, and at most
2,048 bytes before sealing. Inside it is exactly `{"v":1,"title","body","kind":"needs-you","ref"}`: the title is the
conversation's or Team's name, or the Lead's name for the Lead and its questions (at most 80 characters); the body is
one line (at most 120 characters) saying what it waits on: the Lead's question, how many things the Lead waits on, or
for a conversation the request of its newest open approval (the command, scrubbed as the phone's transcript is; a
single file's name or a count of files; a permission's summary; the question asked), otherwise "Waiting on you"; and
`ref` is the Inbox's own id for the item (`ask:<id>`, `lead`, `chat:<agent>:<session>` or `team:<id>`). The account
service checks that the phone is linked to this desk, passes the sealed push to the phone's push service with a fixed
visible alert ("HarnessDesk", "New activity"), and sees which phone, when and how large, never the content. Source:
`packages/server/src/phone-push.ts`.

While signed in with Reachable from your phone on, and the phone link running,
the host also keeps one connection to the relay the desk session names
(`wss://relay.harnessdesk.app` by default):

| Request | What it carries | When |
| --- | --- | --- |
| Relay `GET /v1/challenge` | Nothing | Before each relay connection |
| Relay `WSS /v1/desk/{deskId}` | The relay's own token from the desk session (the account API refuses it), the challenge, and a signature of it with the desk key | Held open while the conditions above hold; a small `ping` every 20 seconds; after a drop it reconnects with growing, randomised waits up to five minutes; a refused token is renewed once, and a second refusal stops it |

Over that connection the relay passes each phone's frames to the desk and back.
They are the same end-to-end encrypted session as a phone on the same network:
the relay sees which linked device connected, when, and how many bytes cross,
never the content. The desk paces its frames under the relay's limit. A phone
that connects through the relay must prove the device key the relay names as
linked, and the session is pinned to the desk key from the pairing code; a new
phone still waits for **Allow this phone?** on the desk.

After initial load, reading ordinary account status returns host state. The
initial load refreshes an existing sign-in or cleans up an unfinished one.
Reachable from your phone opens the relay connection above when the desk is signed in and the phone link runs; it is off until turned on. A fresh signed-out desk
does not begin the account lane until Sign in is chosen. A restored sign-in
refreshes its metadata, and cleanup may contact the service for a previously
unfinished request. Source: `packages/server/src/harnessdesk-account.ts` and
`packages/server/src/account-picture.ts`.

The browser's account session stays in the browser. The host's private desk
key, session and cached account details are encrypted using the desktop's
existing OS keystore cipher. Ordinary preferences retain the desk name and
phone-access choice. The app cannot sign in when encrypted storage is
unavailable. Each service origin uses a separate sealed file, excluded from app backups. An unreadable identity is kept and reported; a new sign-in
cannot silently overwrite it. Interrupted approvals are cleaned up on
Cancel or startup using the desk key, best effort.

**Retention:** the cloud keeps the account's desk registration and phone-link
revocation records; signing out revokes this desk and its links rather than
deleting the cloud account. Settings › Account can unlink a phone or sign out
of HarnessDesk. Sign-out clears the local key, token and cached account
identity and stops account polling. If the cloud cannot be reached, the
confirmation offers **Sign out on this desk only**: it clears the local
identity while the desk stays linked until unlinked from another device.
An already-revoked cloud identity does not prevent local sign-out. A local
preference prevents a legacy copy from restoring a signed-out identity.
Settings › Account also offers **Delete account…**. Its confirmation removes
the cloud account and unlinks every desk and phone. The host clears its local
identity after the cloud confirms deletion or rejects its credentials as no
longer authorized. Other failures keep the identity; an offline attempt must be
retried when connected. The service retains anonymous desk and link generation counters
and a hash of the deleted account id to reject old credentials; neither
contains the deleted profile or device registrations. Agents and local work
on this Mac are unaffected.
Agent accounts and all local work stay available. Turning Reachable from your
phone off closes the relay connection.

## Account transport boundary

Signing in does not enable hosted execution or work synchronization, and opens
no relay connection until Reachable from your phone is turned on. Local phone
pairing and agent/provider connections have their own boundaries above.

## Local provenance

Capture reads available refs and Git objects for registered projects on this machine. Its journal, immutable patch fingerprints, original Seat links and known history gaps stay beneath the project's folder in the host's evidence directory. It retains neither raw patches nor another transcript or brief body. It contacts no remote and never fetches a missing object.

**Retention:** observations remain until the corresponding local evidence data is removed; disabling capture keeps existing history. Workspaces › a project › Provenance turns capture off for that project on this machine, including its linked checkouts. The preference lives in `provenance-preferences.json` in the host state directory, outside the repository.

A backup may carry the versioned, size-limited historical sidecar. Restored records are marked historical; imported cursors, health and preferences do not activate capture or authorize new local associations. No provenance data leaves unless the person chooses to export or share it.

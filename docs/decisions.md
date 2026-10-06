# The decisions this is built on

The choices that shape everything else. Each is
stated as it stands today, not as it was argued — what the code does, and what
it costs to keep doing it. Where a decision has a rule a reviewer can apply,
the rule is the last line of its section.

---

## Content names share one medium weight

The owner's 2A decision on 2026-10-03 changes content person and agent names
from 14px/600 to 14px/500. Chat senders and inline `MemberName` status names
already read the `member` role; its weight now reads `--hd-member-weight`
in the foundation rather than a fixed semibold class. Tile headers retain
their 13px/500 row role, and list navigation retains 13px/400.

The accompanying 3A decision keeps two default running sizes: 13px for chrome
and 14px for reading. 12px remains for meta facts and existing compact
controls; headings, readouts and documents keep their named larger roles.
The written line pairs now match the Desk foundation's 20px lines for both
13px and 14px; no size or line token changes.

Roll back: set `--hd-member-weight` back to `600` in
`packages/ui/src/design/foundation/tokens.css`.

**The rule:** content names read the member role; its weight is decided once
in the foundation.

---

## An outside client uses its own door and an explicit surface

The command line and outside tooling read a desk and start Flows through a local unix socket.
The socket's file permissions are the credential: its directory is owned by
the user with mode `0700`, and the socket and discovery pointer have mode
`0600`. The pointer describes the desk; it carries no token. Windows does not
open this door yet. The window continues to use its token-gated loopback
WebSocket.

The pointer is published by an exclusive temporary-file write and an atomic
rename. A failed startup closes and awaits the listener and its connected
clients before returning.

The door speaks the host's wire, but answers only the entries in
`CLIENT_METHODS`, each naming its tier: `read`, `run` or `answer`. `read` and
`run` are granted by default; `answer` is off until the per-desk preference
or scripted-desk environment switch grants it. A connection says hello before calling or subscribing;
the door checks the surface and granted tier before validating the method's
params. The command line lists desks, status, Teams and runs, and watches
their changes. Catalogue/source/preview calls use `read`; opening a project
and starting or stopping a Flow use `run`. `team/intent` names its tier per
action beside the method table: abandoning requires `run`, and answering
a live person card requires `answer`. All other actions, tool approvals
and settings remain outside the client surface. A client cannot supply
answer attribution: the door adds its stated name at the host's board mutation,
which validates the frozen role and declared outcome before the first await.
The first answer preserves its context and every waiting subscriber sees
resolution. It is the first answer *saved*: the board reads an answer before
it is durable, and a failed save gives the card back, so a later answer, a
retry included, waits for how that save turns out before it is decided. An
identical window decision retry then remains a quiet no-op; clients and
changed answers receive `alreadyAnswered`, or take the card if the save failed.

A Stop ends the run, then cancels what it had not sent. The second is a write
of its own after the run is stopped for good, and it can fail, so a Stop on a
run that already ended is answered with that run unchanged but still does it
again: asking twice finishes what one could not, and a run that settled around
an unfinished batch can have its unsent comments cancelled too.

A start redeems a single-use preview token that freezes source, inputs,
seat overrides and attendance. Those choices survive in the execution and
receipt; they do not rewrite the Flow's file. An unattended start reuses the
trigger's ceiling policy, question deadline and late-answer path. Socket
ownership authorizes the local user's processes; tiers restrict verbs.
The Node client's Seat environment markers guard against accidental spending,
but removable markers are not authentication.

A subscription selects topics and an optional Team, run or project scope.
The door sends that selection's current baseline followed by its changes;
waiting also includes the run and board context it needs. A new subscription
replaces the previous one. The client marks a fresh baseline after reconnect
or an acknowledged subscription change with `gap`, so consumers can replace
their observation rather than combine separate selections.

State snapshots queued behind a subscription or received during its baseline
collection are reconciled into that baseline: a read supersedes earlier
snapshots of its item, and the latest snapshot received during or after that
read supersedes it. Notices and approval
events retain their order. A refused replacement preserves the old selection
and its queued changes.

Connections, calls, refusals and closes are attributed as client entries in
the desk's audit file. The window's audit query keeps its session-only
contract. The library's core depends on the protocol alone; its Node entry
owns discovery and the socket transport, and the command line uses that
library. The layering and reachability gates hold those boundaries and count
the command line's actual calls as a person's surface.

**The rule:** a method reaches an outside client only through a client-surface
entry that names its required tier; the outside door never exposes the
window's whole wire.

---

## The command line reaches a person's PATH through a launcher the app owns, and nothing else

"Install command-line tool…" in the HarnessDesk menu puts one small file,
`harnessdesk`, in a folder the person already owns and already has on the PATH
their login shell builds: `~/.local/bin`, then `~/bin`. That PATH is asked of
the login shell, because an app opened from the Dock inherits launchd's and not
theirs. It is never `/usr/local/bin` and never a folder that needs an
administrator, so the item never asks for a password; and it never writes into a
package manager's or a version manager's folder, which the manager rewrites and
which moves under a version change. When neither folder is on PATH it installs
in `~/.local/bin` anyway, and the dialog says where the file is and gives the
one line that puts that folder on PATH, in the person's own shell's words. No
shell file is edited: those are the person's.

The launcher is a POSIX script that runs the command line bundled in the app on
the app's own runtime with `ELECTRON_RUN_AS_NODE=1`, so no separate Node install
is needed. It records where the app was when it was written. When that is gone
it looks in `/Applications` and `~/Applications` and then asks Spotlight for the
bundle id, so an upgrade or a move never strands it and it never has to be
rewritten. Arguments reach the program as the shell's own argument list and
never as part of a string, so a quote, a `$` or a newline in one is only a
character in it. Nothing in it is a credential: a local client has none.

A `harnessdesk` that is not ours is never touched. Ours is a file whose second
line is the marker, and nothing else is: not a script that quotes the marker
further down, not a link, not a folder. A first install stops at anyone else's
`harnessdesk` in either folder, because two commands of one name shadow each
other and which one wins would depend on an order the person never chose. A
second run of the item offers to remove the launcher, and an install over our
own launcher replaces it, so a launcher an older build wrote follows a newer one.

Neither acts on a name that was only checked. Checking a file and then renaming
over its name, or deleting it, leaves a window in which another process can put
something of its own at that name, and what it put would be overwritten or
deleted. So the file is taken first, by renaming it to a name only the installer
knows in the same folder, and then checked as what is held: opened without
following a link, a regular file, our marker, and the same device, inode, text,
size and mode as the one that was looked at. Non-zero birth and change times
are compared in nanoseconds too, with the change time checked before the
rename because the rename itself changes it. File numbers can be reused and
timestamps can be coarse, so neither stands in for the text. Only then is it
deleted, or its replacement linked
into its name (a link refuses a name that has been taken). Anything else is put
back, and the dialog says the launcher changed and was left as it is; if it
cannot be put back because the name was taken again, it is kept beside it and
the dialog says where. Restoration uses only an atomic hard link to a free
name; if the volume cannot do that, or the held object is a link or a folder,
it stays held rather than falling back to a check followed by a rename. Every
failure after taking the file attempts that recovery, including inspection
and deletion errors. The menu reports whether the command was restored and
names any retained file. The price is that a replacement leaves the name without a
file for the moment between those two steps. The look itself is one open that
follows no link and waits on no pipe, so what is read and which file it was are
the same file.

The alternatives were a copy of the command line in a system folder, which
needs an administrator and goes stale at the next update, and a package-manager
install, which puts a second copy of the program beside the app and has to be
kept in step with it. Windows has no launcher yet: its door is a named pipe and
its installer is a change of its own.

**The rule:** the app puts its command line on a person's PATH with one file in a
folder they own; it never overwrites a file that is not its own, never edits a
shell file and never asks for a password.

---

## The Team overview is derived from held facts, with no reader of its own

The overview model turns plain Seat, card, Run, approval and Insight data into
rows. It reads no component, store, clock or cache, so the later shared client
selector can keep the same exported contract. Needs you precedes Unread,
Working and Idle; unread marks remain the window's own. A Run's stall does
not make every Seat blocked, and a graph dependency is an idle Seat's card
fact rather than a request for the person.

A person's unanswered card waits only while its own round is open in a
running or stalled Run. A hand block retains its Seat through the blocking
agent's latest card lifecycle signal when release clears the claim, or through
the Run's explicit seat/card journal. A later lifecycle transition supersedes
the block; stop capture and other metadata updates do not. A refused claim's
conflict signal leaves ownership unchanged. Neither a shared role name nor
matching session ids across runtimes establish ownership. Completed cards
retain the completing agent through the latest card lifecycle signal, including
manual cards and cards from earlier Runs after the host clears their claims;
refused claims and metadata capture leave that attribution intact.

Cost comes from the Seat's own Team-scoped Insight partition, in money only
for a metered runtime with known rate provenance, otherwise in recorded turns.
The Run adds money only from those eligible Seat partitions; historical
Seats use their recorded runtime identity and supplied metering capability.
Its turn count remains the Team's recorded total. An unavailable figure stays
null. The doing line uses the shared tool-name
lookup with only a tool and a path; commands, queries and environment values
stay in the transcript. Its caller owns the displayed line and its 2.5-second
hold. This model adds no screen or read method; those follow in the
[approved Teams/Runs plan](https://github.com/HarnessDesk/HarnessDesk/pull/1272).

The Teams page uses the same Overview facts. A Run settling does not settle
its Goal's dependencies or follow-up cards; only quiet work with nothing
remaining folds into Ready to wrap. Hide and read marks bind to the observed
Team change in machine preferences, so a later lifecycle or attention change
returns hidden work without deleting it. Usage refreshes do not count as a
new revision. Known waits order the page; an absent state timestamp remains
unknown rather than borrowing the Run's age.

**The rule:** one plain-data contract derives the rows; no overview fact is
invented to fill a missing observation.

---

## A Run's Flow is drawn from the document it froze, by a layout that is a function

A Run holds the Flow it started with, so the Flow tab draws that document and
never the file as it is now. *Open the file* reads the file beside it, found
by the name the Run froze, because a Run keeps no catalogue id or place of its
own. The window says it is the file as it is now and that the Run keeps its
revision, and a name the catalogue no longer holds says so and reads nothing.

Where each step goes is a pure function of the document, not a decision the
component makes while it renders: steps run left to right in the order their
rules reach them, a loop falls under the line, and a Flow's own
`layout.positions` win when it carries them. Edges are derived from the cards'
boxes, so a hand layout reroutes them and never leaves a line where a card
used to be. A rule to a step the file does not define is skipped in the
drawing, because there is nothing to join it to, and is still named in the
list. The older format of Flow is drawn too, without positions it never had.

The Flow tab takes the whole pane, and the inspector steps aside while it
shows. The inspector explains a row of the timeline and the Flow has none on
show; and beside it the drawing would have only the part of the pane the
inspector leaves, which at an ordinary window is under the width the drawing
needs, so the list would be the only view.

The drawing is for the eye and the list is for everyone. The drawing is hidden
from assistive technology and, below a narrow width of its own container, from
view; the list of steps and rules says the same and is then the view. The
container decides and the window does not, because a Run sits in a pane of any
width.

Its curves and arrowheads are data geometry, as a chart's marks are:
attributes on SVG elements that take their colour from `--hd-*` tokens, and
recorded in the design audit's list of such modules. Everything else in it —
cards, tiles, words, rows — is composed from the design system, so a palette,
density or faces change reaches it, and the screen that mounts it draws no
appearance of its own. The one part added to the system for it is
`Card variant="raised"`, the registry card with its soft shadow, for a card
that stands on a canvas of its own.

An Agent step says what its seats ran under only when the Run recorded it. A
seat runs at the narrower of its Agent's own ceiling and the grant the Flow
gives the step, so once a Run has seated the step the card reads the seat's
record, in the words the Seat record uses — the level it ran at, and whether
the runtime *held* it or only *asked* it of the agent — and not the grant,
which an Agent with a lower ceiling never reached. Where a step's seats differ
it reads the floor of them: the narrowest level, and *asked* if any was only
asked, because the weaker answer is the one a person must not miss. A step
with no seat, or with any seat whose record this window does not have, says its
grant and nothing more, rather than speak for a seat it cannot see.

**The rule:** the Flow tab shows what the Run froze; where things go is a
function of the document; the list says everything the lines show.

---

## The window says what an answer or an abandon will do from the Run's own Flow

The window's `team/intent` reply is `null`: a command-line abandon gets
`{ role, nextRole }` back because the client door waits for the engine to open
the next round, and the window does not. So what an abandon, or an answer to a
person's step, will do cannot be read from what the host returns, and the
person has to be told before acting. The window reads the Run's frozen Flow
instead. `followOf` in `@harnessdesk/protocol` picks the first rule of the
card's role whose answers hold for the round, reading a card with no answer as
the engine does: it satisfies neither `every` nor `any`, and a rule with no
restrictive guard follows any round that has cards. A host test runs the
engine's own `decide` against the same table, so the two cannot drift apart
unseen.

The sentence follows what the engine does around the rule. Nothing follows a
Run that is not running or a round that is over. A round decides only once its
cards have all finished, so abandoning one of several says the round stays
open (a card the board does not hold counts as unfinished). A rule that also
reads evidence is said to depend on it and not to fire. A card abandoned where
every rule needs an answer ends the Run without a next step, which reads Needs
you: the plan's wording, that the rule after the role still fires, is only the
common case, and the code decides.

A review step, a person role whose rule reads a review fact, is not answered
with a word: it records the attempt it answers for, which only the board's
picker does, so the Overview and the inspector send it there. Every other
answer, and every abandon, is the request the board's menu makes, argument for
argument; a person's note is the card's context package. An answer given in two
places is therefore one request, and the host refuses the second as already
answered. An approval answered from the Overview sends the decision the docked
card sends and shows the command and its working folder, or the other scope it
approves, beside its choices, so a yes is never given blind.

**The rule:** the window says what an answer or an abandon will do from the
Run's own Flow, read as the engine reads it, and it sends no request the board
does not.

---

## The host runs a declared check for an agent; an agent is never given the network

A Seat that only reads — a reviewer, a tester, an acceptance check — can ask
the host to run one of its flow's own declared checks through `run_check`, by
name, on the committed change its card was handed, and learn whether it
passed. Codex's sandbox refuses a child process a listening socket, so a test
that starts a real server failed in every Codex-seated review while passing on
the host's check, and reviewers could not tell a broken change from their own
sandbox. Turning on the sandbox's network access would let the child bind —
and would also open outbound network to everything the agent runs, which is a
far larger grant than "the suite may start its own server".

A host that runs commands on an agent's behalf is itself a way out of the
agent's sandbox, so the tool is held to what a review needs and no more. Only
a Seat whose grant cannot write may call it: a Seat that can write could put a
test in its tree that reads secrets or calls the network, have the host run
it, read what it printed, and repeat. The check never runs in anybody's
working tree: the host cuts a fresh detached checkout at the handed commit
(the card's seating's base, one of the commits it was handed, or its
checkout's committed `HEAD`), with hooks off, and removes it afterwards, on a
timeout or an abort too. Cutting the tree has its own three-minute limit,
separate from the thirty seconds for Git reads, and a pause or stop reaches
that write through the check's signal. A failed write removes and prunes its
partial checkout immediately; a timeout names the limit rather than showing
Git's progress. Retained Flow base-check snapshots use the same write limit
and cancellation — so a writer's uncommitted edits in a shared checkout
are never what runs. The agent names a declared check and never writes a
command. It gets three runs a turn and ten a card, one at a time, and none
while the run is paused or not live.

Its result is recorded on the card as advisory (`advisory: true`, `counted:
false`): the board shows it apart, and no rule's check guard reads it, for or
against. Otherwise a Seat could re-run a flaky suite until it passed, or
supersede a failing check card, and open a rule for a commit whose committed
code fails. What a rule needs is still decided by the flow's own check card. A
repository's own named checks file is not offered: each of those needs a
person's approval on this machine, which an agent cannot give.

Rule: when an agent's sandbox refuses what a declared check needs, the host
runs the check on the committed change, for a Seat that cannot write, as
advisory evidence; the sandbox is not widened.

## The host commits for an agent; an agent is never given `.git`

A Seat whose grant can commit (`edit` and above) commits its card's own work
through `commit_work`, which the host answers: it commits, in the Seat's
checkout, the paths dirty now that were not dirty when the card was claimed,
with the agent's message. A sandbox that keeps `.git` read-only — Codex's
workspace sandbox does — is left exactly as it is. Widening it to the git
directory would let the agent write `.git/config` and `.git/hooks`, and the
next git run outside the sandbox — the host's own, the person's, a
publishing Seat's — would run whatever it put there with that process's
access; in a lane the common directory is the main repository's own `.git`.
There is no narrower grant that still commits: the index, its lock, `HEAD`
and `config` all sit at the root of the git directory.

That commit runs git with `core.hooksPath=/dev/null`, `core.fsmonitor=false`,
`core.sshCommand=ssh` and signing off, with every filter driver the
configuration names switched off by name, with `GIT_CONFIG_NOSYSTEM=1` and
`GIT_CONFIG_GLOBAL=/dev/null`, and with none of the host's own `GIT_*`
variables. The agent supplies no flag, no `-c` and no path: the paths are
the ones git's own status names, passed as literal pathspecs through a file,
and the supplied message is written to a file and preserved, at most 8000
characters before the desk's attribution is added. Work a filter would touch — an LFS-tracked file, say — is refused
in one sentence and nothing is committed, because with every filter off it
would go into history raw. A submodule is never looked into: it is its own
repository. And the tool refuses while another open card whose Seat may
commit works in the same checkout, since "changed since my claim" would then
include that card's work too; isolating the role is the way through.

When a merge is in progress, Git requires a commit of the whole index rather
than a pathspec. `commit_work` concludes the resolved merge with both parents,
without staging any more work. It refuses before writing when any path still
has conflicts or a staged path was already dirty at the claim, naming those
files so the person's own edits cannot enter the merge. An untracked directory
at claim protects its descendants, and a rename's literal source is checked
against the saved display spelling, including quoted names and literal arrows.
The message, attribution, identity and hardened Git configuration are the same as for an
ordinary card commit. (#1351)

Git the host runs on its own in a checkout an agent can write — evidence
reads, status, cutting a lane, diffs — carries a narrower floor
(`git-hardening.ts`): no hook, no filesystem monitor, no external diff, the
default ssh, and no signing. It does not switch filters or textconv off: a
filter the repository configures still runs when a host status re-reads a
stat-dirty file, and host diffs pass `--no-ext-diff --no-textconv` themselves.
Verbs a person triggers — bringing a branch home, the git client's commit,
checkout and worktree verbs — run with the person's hooks, as their own git
would; a hook path a repository sets (husky's is a tracked folder) is one an
agent can edit, which is why nothing automatic runs hooks.

The author is the checkout's configured identity, read the way git resolves
it — `user.name` and `user.email` across system, global and repository
configuration — and handed to the commit as `GIT_AUTHOR_*` and
`GIT_COMMITTER_*`, because the commit itself runs with global configuration
off. A checkout with no configured identity is refused in one sentence; the
desk never makes one up.

The person owns both the author and committer identity. Only `commit_work`
adds `Co-authored-by: HarnessDesk Agent <agent@harnessdesk.app>` through
Git's `interpret-trailers --if-exists=addIfDifferent`, which owns placement,
trailer formatting and deduplication. A quoted line in the body or after
Git's divider or scissors cutoff does not count. Trailer processing reads
no repository configuration except the comment prefix: `core.commentChar`
and `core.commentString` are read with the person's system, global and
repository configuration, then passed explicitly to the isolated parser.
`trailer.*` settings can run commands, so the parser runs with
`--git-dir=/dev/null` and system and global configuration off. Git 2.32 or newer
is required; an older or unrecognized version is refused before staging.
The text lives in one constant in `card-commit.ts`; a Seat never has to type it,
and a person's hand commit is untouched. Settings for the trailer's wording
are left for a later decision.
(#1277)

Rule: an agent's sandbox is never widened to a git directory; a commit it
needs is the host's, run hardened.

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

## DeepSeek runs on DSH's own ACP server, and its tools arrive with the session

A board call is attributed by a caller token the host mints for one session
and puts in the environment of the one tool bridge that session's agent
spawns. The token is the only thing that ties a call to a seat, and it is why
an agent in one conversation cannot finish another conversation's card. So
the tools have to arrive *with the session*: a tool server composed once into
an agent and shared by all its conversations carries no token, and every
board call through it is refused as unattributed. That refusal stays; the fix
is never to guess the caller.

DeepSeek used to reach the tools only that way, through a
`dsh-mcp-client` entry in its composition, because the ACP server we built for
it, `@harnessdesk/dsh-acp`, refused session tool servers, and DSH's own server
was then too thin to use. Both changed. DSH's own `dsh --profile acp` has taken
session `mcpServers` since 0.1.2-alpha.1, mounting each on that session's own
agent, and on 0.1.7 it is the server that works: it carries messages,
reasoning, tool calls, context usage and model and effort options, and is
versioned and tested with DSH itself. Our bridge reads DSH's internal event
stream, and on 0.1.7 that stream moved under it — no assistant text reached
the wire. What ours still adds (streaming, replay, plans, titles) is
presentation the desk can live without or derive: it keeps its own transcript,
and reads the plan from `todo_write`.

So DeepSeek is a template on DSH's own server. Our bridge took session tool
servers too from 0.6.0, for a desk pinned to an older DSH, and was otherwise
not where DeepSeek support grew.

Our bridge (`@harnessdesk/dsh-acp`) was removed from HarnessDesk's code,
references and docs on 2026-09-25, once every desk could reach DSH 0.1.7.

**The rule:** a seat's tools arrive with its session, or its board calls are
refused; they are never shared and never attributed by inference.

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
the right takes the conversation's width while it is open — a second half that
the entry below amends: the panel now covers the conversation only when fewer
than 400px would be left beside it. Three things were chosen rather than
defaulted:

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

## The reading column is protected: the sidebar gives way first

*Scope: the same renderer; this amends the entry above.* A window wider than
720px could still squeeze the conversation: at 720px, a 240px sidebar and a
280px right panel left it 198px, two words a line. Measured beside two
reference apps, one keeps its sidebar and hides its side panel, the other puts
its sidebar away and keeps the pane — and neither protects the reading width.

So the window keeps a 400px reading column (`MIN_READING`), and things give way
in a fixed order:

- **The sidebar goes first.** It loses its column below 720px, as before, and
  also whenever its width, a drawn right panel and 400px do not fit. It then
  takes exactly the floating form the entry above describes — the same state,
  the same Escape, the same way back — so there is one narrow sidebar, not two.
  The sidebar's own width counts even while its column is put away, so the
  line does not move when it is toggled.
- **The panel goes second.** It covers the conversation only once fewer than
  400px would be left beside it, no longer merely because the window is under
  720px: at 700px a 280px panel and a 419px conversation stand side by side.
- **A seam cannot undo it.** While two columns stand, the right seam stops
  where the conversation would drop under 400px.

Every predicate reads committed sizes, never a drag in progress, so a line is
not crossed under the pointer. The 1px divider between two columns is counted
as well: with the arithmetic done on sizes alone, the live window measured the
conversation at 398px, never the 400 it promised. So a 240px sidebar and a
280px panel keep their column from 922px; at 900px the sidebar floats and the
conversation keeps 619px beside the panel; from 680px down the panel covers it.

**The rule:** navigation gives way before the thing being consulted, and the
thing being consulted before the work; the work never stands beside anything
narrower than 400px.

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

## Provenance capture does bounded work and leaves nothing behind

Capture runs for as long as the desk does. A history of N commits offers about 63 ranges to each (every first-parent suffix of up to 64 commits), and reading one costs Git processes, so a pass that read them again on every wake kept one desk's host busy for hours over a repository that had not changed: a range it could not read, or a history longer than 64 commits, was enough to keep the pass from ever being skipped. A pass now does a bounded amount of work, and only when something it reads has changed: a commit or ref move, a fact, a Seat. A range that could not be read (an object pruned, or never fetched) waits for such a change; it never starts a pass by itself and never takes the place of a range not yet tried.

What the reader keeps is what Git can never contradict. An object id names its content, so what Git said about one stays true; but an object that is missing now can be fetched later, so a miss is never remembered. Speed does not buy back a check: the metadata, pointer and object-format checks run before any kept answer is served, once for a batch of reads rather than once per read, and a check that fails empties everything kept.

Capture's record of where it is, the checkpoint, says what is new or says nothing. Every scan used to append a whole checkpoint, however little it had found, and every health update read every checkpoint ever written, so a desk that stayed up grew larger and slower with each scan, idle or not (a checkpoint over a history of a few hundred commits runs to hundreds of kilobytes). A scan that finds nothing new now writes nothing, though it still moves its own clock, and the checkpoint in force is read without reading those it superseded.

The private view capture reads through is a folder in the state directory. Whoever makes one removes it on every path they control (the reader closing, an admission abandoned half way, the process exiting), and at startup the views no live handle owns are swept, which is all that can be done about a process that was killed. A view's name carries its process id, so one desk never sweeps a view another running process is using.

**The rule:** capture does bounded work, and none when nothing it reads has changed; it keeps only what Git cannot contradict and writes only what is new; and a view it makes is removed by whoever made it, or by the next start.

## A Goal is finite; Seats and receipts are the authority

Rooms accumulated three competing truths: a member array, the conversations
the host happened to hold, and Seat evidence. Goals keep the useful surface —
board, channel and roster — but make the durable records authoritative. An open,
non-restored Seat establishes membership. Assignment and Release are serialized
host transactions; the renderer refreshes the resulting Goal instead of
splicing a member into local state.

Isolated Goal work receives a durable lane: retained checkout, disjoint port
block and, by default, its own persistent browser partition. The host injects
the lane environment into each agent invocation that can take it per session.
A lane depends on its checkout, never on a variable in the agent's process: the
cwd is the confinement and the browser partition is found by it, while the
ports are a reservation the standing order states either way. So a runtime that
cannot take the variables is seated in its lane all the same, and told the
values; refusing it refused every isolated Seat on any ACP agent but the desk's own bridges. A round's
cards still start together — every Seat is durable before any is handed its
card — so a Seat that will not open stalls its round, and the stall names the
siblings it held back and the way on. Wrapping takes a reviewed
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
one folder is refused against a folder that replaced it. On macOS, every open
below the root uses `O_NOFOLLOW_ANY`, which refuses a link at any component.
On Linux, every open walks each component with `lstat`, refusing links and
non-directory ancestors, then uses `O_NOFOLLOW` for the final name. An exclusive
create may have a missing final name; its ancestors still have to pass the
same checks. Both paths enforce the static-tree threat model above, without
claiming to prevent a same-user process swapping paths. Other platforms refuse
writes. A file is replaced by writing a synced sibling,
checking that the target still holds the previewed bytes (or already holds
the new ones), renaming the sibling over it and syncing the folder. It is
never truncated in place, a person's edit since the preview is kept, and a
crash leaves the old bytes or the new ones, which the update journal, written
the same way, can replay.

**The rule:** no fs call on a project path bypasses the confined tree, and no
write there happens without checking every component for links, with the
macOS kernel flag or the Linux component walk.

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

## A trigger's vocabulary is closed, and arming binds the whole file

A project's `.harnessdesk` folder can declare that a pull request, an issue
or a schedule opens work — but it declares from a fixed, finite vocabulary,
never an expression, a template or a name that reaches a command, an
environment variable or a ceiling. The alternative — letting a declaration
name anything a flow already could — would make a cloned repository able to
choose what runs on someone else's machine the moment they armed it, which is
exactly the trust boundary a clone does not cross for any other file today.

Arming does not consent to "this trigger" as a name; it consents to the exact
bytes of the file, the exact resolved flow, every Seat and command that flow
would open, and the forge account and repository bound at that moment. A
comment-only edit to the file, a Seat's ceiling changing, or the bound
account signing out all invalidate the arm before the next firing, and
re-arming shows a fresh preview rather than assuming the old one still holds.
Money follows the same discipline in the other direction: a budget is an
observed stop threshold the desk watches spend against, never a pre-charge or
an invoice, because no vendor here exposes a real one — a turn already in
flight can still spend past the limit before its meter reports and the stop
takes effect, and arming and Settings both say so rather than promising a
number this design cannot back.

**The rule:** nothing a trigger declares can become a command, a path, an
environment key or a ceiling, and no dependency an arm was shown — file
bytes, flow, Seats, commands, account — may change without invalidating it.

## An arm binds what runs, not whether it can run now; a pause holds, a budget stops

An arm is consent to content: the file, the flow, each Agent, each command,
the seats each role would try and the ceiling it needs, and the forge
account and repository. It is not a promise that a seat can be taken this
minute. The first cut bound the seat plan's outcome — which candidate won
and whether it held its ceiling — so a runtime that was down for a minute,
or a sign-in that blinked, turned every firing in that minute into "changed
since armed" and consumed it for good. Availability is now read again at
dispatch (the firing waits, named, until a seat can be taken), and a read
that cannot be made while answering a fact is no answer at all: the fact is
kept and offered again.

The same split decides pause and the daily cap. A pause, or a cap lowered
below what is already committed, is a gate that lifts on its own, so it
holds work — turns and checks interrupted, nothing recorded — and lifting it
continues that work. A reached budget is not a gate: it is recorded, and a
run it stops lets go of and interrupts every Seat, so nothing started under
it keeps spending unmetered. The arming preview seats roles under the
unattended policy for the same reason the binding excludes availability:
consent has to describe what will actually run.

**The rule:** bind content, recheck the world at dispatch; hold for what
lifts on its own, stop for what does not.

## Whose comment fires a trigger is the project's to say, and never the desk's own

A trigger that reads issue comments started work for anyone who could
comment, which on a public repository is anyone. The owner's decision
(2026-09-24) is a closed, bounded `from:` — `me` by default, the account the
arm is bound to; `collaborators`, anyone the forge says can write to the
repository; or `anyone`, which the arming review warns about in plain words
— because it is a product setting every user needs, not a constant. Authors
are compared by the forge's numeric account id, digested the same way the
arm binds the signed-in account; a login or a display name is never trusted,
and an author or a permission that cannot be read never fires. The desk
posts to the forge as that same account, so a comment it posted itself would
pass `me` and fire again, a loop: everything the desk posts — a tool's
comment, review or description, and every finding publication — opens with a
marker line of the desk's own, any comment whose first line is exactly such a
marker (the reconciliation rule, never a looser match) is skipped in every
mode, and the id of every comment the desk posts is remembered across a
restart, so a comment whose marker was edited away is still the desk's.

## The front door's shapes are ordinary files, and its two clicks are a property of the dry run, not a wizard

The front door names no use case in product code. "Fan out," "Review,"
"Compare," "Relay," "Investigate," "Align" are six ordinary flow files that
ship with the desk, read through the same `flow/catalog` a project's own
Flows page already lists; a seventh, `mechanical-contest`, ships unordered on
purpose, as the thing a person copies rather than one of the labelled six. A
shape earns its place in the front door's own order and its context list
(a branch, a pull request, a diff, a plain project) from `layout.frontDoor`,
metadata the engine never reads and a person can edit like any other line in
the file. The alternative — a `kind` the front door itself switches on — would
have made "add a starting point" a code change forever, for something a
project should be able to do by writing a file.

Two clicks is what the plan promises, and it holds only because nothing
between choosing a shape and pressing Start is allowed to ask a question the
dry run itself does not already answer. A wizard, a confirmation step, or a
second dialog to fill in what the dry run could have shown would each be one
click away from three, quietly. What a click *does* buy — typing the
sentence a Goal starts with, or building a shape from nothing in *Your own
shape* — is not counted against the promise, because it is work a person
chose to do, not a gate the front door put in the way of work they had
already decided on.

**The rule:** a shape is a file, ordered and gated by its own metadata, and a
click that is not choosing a shape or pressing Start is a defect, not a
feature, in the two-click path.

## Starting a team requires a held ceiling; an asked one is a refusal shown, not a downgrade

Phase 3's watched conversations tolerate a runtime that can only be *asked* to
hold a ceiling — the standing order carries the limit, and the person is
trusting the runtime to keep to it, because a person is watching. The front
door starts a team that may run unattended for rounds at a time, with nobody
necessarily reading every turn as it happens, so that same tolerance would be
consent obtained under a materially different risk than the one it was
designed for. A front-door run instead requires every Seat it ever opens —
including a later or a recovered round — to *hold* its ceiling: the runtime
must accept the control and read it back, or the candidate is passed over
before it is given a brief, a tool or a card.

This is why a fresh install with a runtime that can only be asked shows an
honest refusal — a candidate name, a reason, a fix — rather than starting
under a weaker policy and calling that success. The temptation the other way
is real: silently relabelling an asked seat as held would make more desks
pass the "two clicks from empty" demonstration, at the cost of the sentence
that requirement is supposed to prove. A person can still explicitly widen a
shape's own grants, or seat something asked-only by hand elsewhere — this
decision governs only what the front door starts *for them*, by default,
without them having read the file.

**The rule:** a front-door run's requirement for held Seats is policy layered
onto the existing seating path, not a second enforcement mechanism, and it
never quietly becomes an asked run to make a demonstration succeed.

## A shape's `layout:` is a shortcut a person can trust to be inert

`layout.frontDoor` and `layout.positions` are the same reserved key the
engine has always ignored, extended for two new readers: the front door's
ordering and context list, and the graph's node positions. Both are read
defensively — an unknown role, a value outside a stated bound, or a shape the
reader does not recognise is dropped with a reason, never trusted, and never
mistaken for a reason to stop reading the rest of the file. The alternative,
trusting `layout:` enough to let it fill an input, choose a grant or route a
round, would turn a canvas position into an attack surface: a cloned
repository's own file could then shape what runs by shaping where a node
happened to be drawn.

Because nothing here can grant, seat, guard or route, the ordered editor and
its graph can share one document with no risk that arranging a shape visually
changes what it means: moving a node is exactly as consequential as
scrolling a text file, and the render call that produces a shape's exact
bytes (`authoring/shape/render`) never once inspects `layout:` to decide
whether the result is valid.

**The rule:** `layout:` may only ever offer a shortcut to a surface that
already trusts nothing else in the file; the day it grants something is the
day it needs to be a different key.

## A review works at the commit it resolved, in checkouts of its own

A "Review…" of a branch, a pull request or a diff used to guard only its
Start: the resolved head and base were bound to the token, and then the run
opened its Seats in the project's own checkout — whatever happened to be
checked out — starting with a step that could edit it. The target decided
whether Start was allowed, not what was reviewed.

Now the resolved target travels from the token to the run (`target`), the
run's Goal is pinned to its head (`Goal.at`, set by the host alone), and
every Seat of a pinned Goal gets a lane cut from exactly that commit — the
phase-6 lane an isolating role already gets, with its own ports and browser
profile. Before a Seat is handed any work, git is read fresh in its
checkout; a Seat anywhere else is released and the run stops with the
reason. The shipped `review` shape reads only, is offered only for such
starts, and the edit-first shapes are offered only for a plain project. A
working tree has no commit to pin, so its reviewers read the project's own
checkout and the token binds its snapshot. A reused Goal was never pinned,
so a review of a committed change starts a Goal of its own.

The alternatives were a single worktree for the whole Goal, or pinning by
instruction alone. A single worktree would be a second checkout plane beside
lanes, with its own recovery; an instruction is exactly the kind of claim
that is worth only its recording. Lanes already had recovery, retention on
wrap and a registry.

**The rule:** a run that says what it reviews works there, and proves it
before any work is handed out.

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

One identity per attachment, taken from one read: a skill's is SHA-256 over
its whole bundle, a server's is SHA-256 over `canonicalMcp` of the spec that
would run (never the Library's 16-hex display digest). The same identity
gates the review, the approval, preparation, staging, the runtime's receipt
and the gateway. The host stages what it approved — the exact bytes under
`attachments/staged/skill/<digest>/`, the exact spec under
`attachments/staged/mcp/<digest>.json` — and a runtime is handed that staged
copy, never the Agent's or the Library's own folder, which can change after
a person looked. The bundled bridge re-reads the staged folder with the same
bounds, hashes what it copies, and reports that hash; anything else is not
loaded. A review is for the runtime `agent/seat` will actually choose, at the
Agent's own ceiling, and the grant covers any Seat at or below that ceiling —
a narrower Seat is less authority. An external server still needs a Seat that
may merge, so the default (`edit`) seating of a merge-ceiling Agent loads its
skills and says why its servers did not. A server's review shows the command,
arguments and environment that will run (a credential's value is shown only
as set, and approving a review that hides any value asks the person to say
they know what it is — a value that changes what the server does can hide
behind a name that looks like a credential), and its command runs only
when the Seat lists or calls its tools, through the desk's gate, in an empty
host-owned folder — never the Seat's checkout, whose own configuration could
change what an approved command resolves to.

**The rule:** trust and classification are host-computed from what was
actually read, never taken from a repository's own claim about itself, and a
runtime that cannot honor a Seat's declarations fails that seating in its own
words rather than falling through to a different one nobody announced.

## A person may seat an Agent above edit, asked or held, by choosing it

An Agent whose ceiling is `publish` or `merge` was always seated at `edit`
from the app, so the one Seat decision 13 lets load an external MCP server —
one that may merge — could only be opened by a flow or a direct wire call.
The Agent's page now offers *Start at a higher ceiling…*: a choice of level,
up to the Agent's own ceiling and never past it, confirmed in a dialog that
names each level's meaning and how the runtime that would take the seat
keeps to it, in the words a ceiling chip already uses. `edit` stays the
default, and the plain *Start* never asks.

The owner's decision (2026-09-25) is that a level the runtime can only be
*asked* to keep is offered too — labelled "asked, not held" — and not only a
level it holds. No shipping runtime holds `publish` or `merge` today, so a
held-only offer would leave the path this exists for unreachable. It is the
same tolerance a watched conversation already has, and it follows the same
setting: an asked level is offered only while this Mac's
`unheldCeilings.watched` seats an unheld ceiling, and under `refuse` it is
shown and not offered, with the reason. This is a watched, person-chosen
Seat; it changes nothing the front door or a trigger starts, which still
require a held ceiling.

**The rule:** a ceiling above `edit` is only ever the person's explicit
choice, never past the Agent's own, and an asked level is labelled as asked
and offered only where this Mac already seats one.

---

## The builder edits one Flow policy; canvas identities belong to its document

The pure model in `packages/ui/src/lib/flow-builder/` holds the existing
`FlowPolicy`, a position for every role, and canvas identities separate from
the names a person edits. One role is one step node and one rule is one edge,
including parallel rules and a rule whose endpoint is missing. Renaming a
role keeps its canvas identity and updates seed, rule endpoints, isolation
predecessors, split providers and check guards that name it. Renaming a rule
keeps its edge identity too. Identities survive edits and undo within the
draft; opening a file creates a new editing session.

Positions stay in the shape's existing `layout.positions`, keyed by role
name, because the host already round-trips that metadata and the engine
ignores it. Reading a file does not write an automatic layout: missing
positions take `flow-layout`'s placement, and saved coordinates win exactly.
A move or an explicitly placed new step writes the draft's positions while
keeping other layout keys, including the front door's shortcuts. Unreadable
layout is reported and retained on read; a deliberate layout edit replaces
only the part it edits.

A fan-out is an ordinary Agent role with several seats, never a fourth engine
kind. A note is an annotation under `layout.builder.notes`, with text and a
position; it opens no round and accepts no rule. Notes are excluded from the
step, rule and seat facts. An Agent with no explicit seats still takes its
Agent's own preference, so the local unseated advisory means no Agent is
named, not no seat override is written.

The page can create a document from the host-read policy and its original
source, draw `documentGraph`, and fold canvas positions back with
`graphDocument`. Semantic edits use operations so rule order and references
stay together. Undo and redo retain document snapshots, including source
provenance. Deleting a step deletes rules that reference it as an endpoint,
split provider or check guard; it never weakens a guard by removing only one
clause. Other steps remain to be reconnected. Deleting the starting step
leaves a missing-start problem rather than picking a different entry point.

`sourceRequest` returns the original bytes until the document is edited,
preserving formatting and comments exactly. After an edit it requests the
host's existing shape render; that deliberately normalized output replaces
formatting and comments, as in the ordered editor. There is no YAML parser
or writer in the model. The local problem list is a structural advisory for
the header and cards, never a validity verdict; Save and Dry run still need
the host's render and compiler. No builder screen is mounted by this model.

**The rule:** one policy determines what runs; layout only determines what
is drawn; the host determines whether the draft can be written or started.

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

The frozen filter survives everything a conversation outlives. A Seat keeps
what it decided at open in machine state (`attachments/frozen/`), and a
resume, a load, or a reconnect after its runtime restarts hands the runtime
that same filter — revalidated against the staged copies, the approval for
the runtime build now running, and the Seat's ceiling — then appends the
reopen's receipt as a new epoch. A reopen whose runtime can no longer keep
unapproved content out is refused; one it cannot record is closed. A fork is
refused outright: it would be a new conversation on the runtime's defaults,
and it is not the Seat. No session method accepts `attachments` from a
client; only `agent/seat` sets it.

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

Retention is for project memory only. `goal/cite` keeps the reach phase 5
gave it — any committed document at a full revision may be cited — and
retains a snapshot only when the path is a memory file; any other citation is
checked at its revision and waits on its source like any other dependency.
The plan narrows what memory is (decision 1), not what a Goal may cite.
Memory is read from an ordinary checkout or from a linked worktree, which is
what every Agent lane is: `.git` → `gitdir` → `commondir` is followed hop by
hop, each reached through no link, the gitdir must be one its repository
registered under its own common directory, and its back-pointer must name
this very checkout — anything else is refused. A backup's index is a claim:
a link is accepted only when the archive it names carries that exact
citation, and restored history never replaces or collides with a citation
this desk registered itself.

**The rule:** retention happens before the Goal mutation that references it,
a citation is data a person carries on purpose, and no archived or restored
record may authorize dispatch, membership or tools by itself.

---

## A ceiling chip's tone is a report, not a warning

Most runtimes have no control that holds a ceiling at all, so `asked` is the
ordinary state for nearly every seat and every built-in Agent — not a
warning about this particular one. `ceilingTone` returns neutral, always;
`held` and `asked` are told apart in the chip's own words and its hover
explanation, never in its colour.

**The rule:** a ceiling chip's colour never carries a fact its words do not
already say.

---

## A question waits for a person unless nobody is here, and an answer is never too late

A Seat's question used to be cut off after twenty seconds on every flow run.
That deadline was written for unattended work, where nobody will ever
answer, but it applied to any Seat of a running run — including one a
person had just started and was watching in its room. The walk that found
it saw the person answer on the room's own card, a few minutes in, to a run
that had already stopped.

So the deadline belongs only to a run a trigger started. There, how long a
question waits is a machine setting (Settings › Permissions, `unattendedQuestionWait`):
five minutes by default, from stopping right away to waiting until the
person is back. It is never a trigger's, a flow's or a repository's to set,
for the same reason the unattended ceiling policy is not: nothing an event
carries may decide how long unattended work runs without a person. A run a
person started has no deadline; its Seat waits for the answer.

When the wait does run out, the run stops first and the turn is interrupted
second, so the turn's end cannot hand the card straight back. An answer
that arrives later is still an answer: the run goes back to running,
durably; the Seat is reopened the way a relaunch reopens one; consent and
spend are read again after that reopen; and the question is closed as
answered — never as a refusal, which would hold the Seat's messages to its
teammates — right before the turn that carries the answer is sent. An
answer no run is waiting for any more is refused rather than put into a
turn that is over. What the desk remembers of a stopped question is held in
memory, so after a restart the question's card is gone and the Seat is
handed its card again instead, as any relaunch hands it.

**The rule:** only unattended work is timed, by the person's own setting;
an answer that comes late is delivered, never dropped and never read as a
refusal.

## Seats that may commit in one round are isolated by the file, never by the desk

Every Seat of a round is seated and handed its card at once. Without
`isolate: true` they all work in the one checkout, and two that may commit
there — `edit` and above, after the Agent's own ceiling caps the grant — move
each other's HEAD: each one's commits land on the other's branch, and nothing
downstream can tell whose work is whose (#1014).

The desk could isolate such a role on its own. It does not, because a flow file
is what a person reads to know what runs: a round that quietly took worktrees,
branches and ports the file never asked for would make the file a partial
account of the run. So the dry run refuses the shape, in one sentence that names
the role and both ways out — `isolate: true`, or a grant of `read` — and the
start, which redeems only a fresh dry run, refuses it the same way. Only the
width of one role counts, because a round opens exactly one role and the next
opens only after it closes.

The same issue fixed what a review round is. An Agent that produces both diffs
and reviews — the requirements analyst, which writes positions and later
accepts against them — reviews only where its ceiling cannot commit. Seated to
commit, it is writing, and its round is a plain one: it opens no review series,
owes no structured review, and is never stopped by a findings ledger it did not
read.

Blindness does not follow that line on its own. A review round stays blind by
default, but making every plain round with several cards blind would hide
ordinary parallel work from itself for no reason. So a plain round is blind
only when its role says `blind: true`, which is what the analysts' first,
independent positions ask for. It takes two Seats that may commit to be
refused, because one writer beside readers has the tree to itself.

**The rule:** refuse a committing shared tree with the fix named, never isolate
behind the file's back; and a round belongs to the review series only when its
Seats are there to judge.

## A card's checkout holds the work it is handed, and a new lane is how

*Issue #1053.* Walking UC1, the tester after an isolated `dev` was seated in
the Goal's own checkout, still at the commit the run began at. Its order named
the dev's newer commit, it ran the tests where it sat, and it answered
`request-changes` about code it never had, round after round. Isolated debate
analysts had the same gap: "the other analyst's position is unavailable in
this checkout". Checks never had it, because #1041 runs each check card in its
predecessor's own lane at a head journaled when the round opens; and a judge
reached its competitors only through `review_candidates`, which names a
revision but not where it is.

Three ways to give a card that work were open. Seat it in the predecessor's
own lane: a lane belongs to one Seat, its ports and browser profile with it,
and a reader sitting in a writer's tree would have its own diff measured
against the writer's commits (#1042) and its claim compared against the
writer's paths (#1026); and a second card of the round could not share it
without meeting #1024's refusal. Bring the commit into the card's checkout:
for a card that is not isolated that is the person's own checkout, which the
desk never moves without asking. Or cut a fresh lane from the predecessor's
commit: the lane allocator already cuts a pinned run's lanes from one commit,
so this is the same seam with a different base, and each card still has a
tree of its own. We took the third.

Several predecessors at different commits have no one commit to cut from. A
merge could conflict, and a merge base holds neither side. Every lane is a
worktree of the one repository, so every commit is already reachable by id
from any checkout of it; what the card lacked was being told. So the card
keeps the checkout its role gives it, and its order names each predecessor's
card, commit, branch and folder. The plan — base, or the list — is decided
once, before any Seat opens, and journaled beside the round, so a retry seats
and briefs exactly as the first attempt did.

Work that cannot be reached does not seat the card on stale code: a
predecessor whose Seat cannot be read, whose checkout is gone or has no
commit, or whose work is uncommitted stops the round before its card opens,
naming the card and the predecessor. A card sharing its one predecessor's own
tree — neither isolated — already holds that work, dirty or not, and is left
exactly as it was.

This adds lanes a flow file does not spell out, which #1024 declined to do for
committing siblings. The difference is what the lane is for: #1024's would
have hidden a refused shape, while this one is the only way to give a card the
work its own order names, and it never shares or moves anyone else's tree. It
is not hidden either: the dry run computes the same rule from the file alone
(`rolesAtPredecessor`, beside the `handedCheckout` the run seats by) and marks
each such Seat, so the start screen says what runs. For that, a run cuts a
lane only for exactly one predecessor card; several are always named, even
when they happen to share a commit, so the file decides and the run agrees.

A reading Seat still gets the whole lane — ports and a browser profile — since
the browser tools are read-level and its own shell may run the project's tests
on `PORT`. What it does not do is hold them: a lane opened only for a reader
is marked `reading`, and is let go the moment its Seat closes, or left
retained for a person when a port is still in use. A UC4-shaped loop therefore
holds one reader's ports at a time, not one per round.

**The rule:** one commit handed is a lane cut from it; several are named in
the order; work that cannot be reached stops the round, never a Seat on stale
code.

## An agreed split is recorded by the agent that agreed it, and each card owns its own part

*Issue #1015.* A pair build (the design's UC5) has two developers agree a
split of the files, then work in parallel held to it: claiming a card claims
its paths, and the board refuses a claim whose paths overlap a live one. It
was never enforced. A round's `files:` was one list, so both sibling cards got
the same paths, and the host's own claim for an opening Seat never asked the
board's file rule at all, so both were seated on fully overlapping paths.

Two ways to give each card its own paths were open. The flow file could list
one `files` per card, but then the author decides the split and the agents
only follow it, which is the opposite of what the shape is for. Or the round
that agreed the split records it, and the next round reads it. We took the
second, as the smallest version of it: the agreeing card finishes with
`complete_claim`'s `split` — one list of path patterns per card of the later
round, in card order — stored on that card, and a rule's `then` says
`split: <role>` to give card n the n-th list of that role's latest round. No
package or answer text is parsed: a split in prose is one nothing can hold
anybody to. The board refuses a split whose lists overlap as it is recorded,
while the agent that wrote it can still fix it.

Where a flow asks for a split and none is usable — the agreeing card recorded
none, two cards recorded different ones, or it has the wrong number of lists —
the round stops before any card of it exists, and says which. There is no
fallback to a shared list: that is exactly the agreement going unenforced. For
the same reason the dry run, and with it the start, refuses a flat `files:` on
a round of more than one card. That rule, and the checks on `split`, belong to
the compiler, as #1024's did: recovery re-parses every saved run's text on
launch, and a parse refusal would block a run saved before this rule with a
false "could not be read". And the host's claim for an opening Seat, and a
person's assignment, now ask the same file rule an agent's claim does, naming
the paths and the card that holds them. Paths are compared case-folded, since
on a case-insensitive volume two spellings are one folder, and folding can only
find more overlap. A round refused at a claim interrupts and lets go of the
Seats it already opened, whoever started the run: a Seat left in its first
turn would pick up its claimed card while the run stood stalled.

**The rule:** the agents agree the split and record it as data; the board
holds each card to its own part; a split nobody recorded stops the round
rather than seating everyone on the same paths.

## A mixed check result still reaches the judge, and a race seeds two from the file, not the entry point

*Issue #1032.* Two gaps in `comparison` (the design's UC2), both seen on a
real run. First, its one rule from `verify` to `judge` read `every: [pass]`:
when both competitors delivered but the check passed for one and failed for
the other, no rule matched, and the round that closed with no rule to open
from it is exactly how this engine already stops a run for a person — so the
run stopped, but before a judge ever got to weigh in, on a result the shape
was supposed to let a judge decide. Second, the shipped file named its
`competitor` role with `uses: [implementer]` and no `seats:` or `count:`, so
its width defaulted to one card. `/race` never noticed, because it always
substitutes two explicit seats into that role before starting it — text
surgery on an ordinary file, never a second execution path. Starting the same
file from the generic Flow-start dialog skipped that substitution and opened
one competitor, silently giving a "race" with one runner.

Both fixes stayed in the file, because the rule language already said what
was wanted. `to-judge` now reads `any: [pass]`: it fires once every
competitor's check has finished and at least one passed, with every
competitor's own check card still on the board as the judge's evidence —
mixed or all-passing looks the same to the rule, and the judge sees which one
failed either way. Only when nothing
passed does no rule fire, which stops the run for the person exactly as it
already did, and says so by naming each card and what it answered — the
existing "no rule continues from it" message is plain enough on its own; it
needed a way to be reached on purpose, not a rewrite. The design's UC2 walk-
through carries the identical shape and got the identical fix, checked to
compile clean against the real shipped Agents.

For the seed, the smaller change was making the file say what it always
meant: `competitor` now declares `count: 2` alongside its one `uses:`. A
generic Flow-start reads the file exactly as `/race` does — through the same
compiler, no dialog-specific path — so it now opens two cards from either
entry point, both seated on the role's own default Agent when nothing more
specific is asked for. `/race`'s own substitution is untouched: it still
strips `seats:`/`count:` and writes two explicit seats for whichever two
attempts a person chose, which is a real second value on top of a file that
already seeds a race on its own. Nothing needed to ask the generic dialog to
recognize `/race`'s marker and refuse — the file's own declared width
already answers the question every entry point asks it.

**The rule:** a round's routing reads the outcomes it actually has, in the
weakest guard that still means what the shape wants (`any`, not `every`, for
"at least one usable result"); and a role's width is the file's own fact, not
something only one entry point happens to supply.

## A Flow can choose a fetched base without moving the person's checkout

A lane cut from the project's current `HEAD` inherits a stale checkout. The
Flow pilot worked around that by making a new clone for every Team (#1244).
An optional v2 `base: { remote: origin, branch: main }` now fetches a configured
remote when Start is pressed; omitting `branch` fetches its advertised default
`HEAD`. The preview explains the fetch and the managed lanes without making a
network request. Failure refuses the start before any Goal or Seat opens.

The fetched commit is frozen in the run and retained under a per-run Git ref,
so simultaneous starts cannot overwrite each other's base and a later remote
move cannot leave recovery depending on an unreachable object. Every Seat
uses the existing lane allocator, and the host checks its actual `HEAD` before
handing it work. A later card handed one predecessor's commit starts from
that work, preserving the dependent-checkout contract. Checks without a
predecessor use a retained managed detached checkout of the frozen base so
their evidence stays readable. The run journals the fetch intent before Git
runs, then the completed pin before adoption. Recovery reuses that pin offline;
an intent without a pin is uncertain and refuses with a reason, never fetching
again automatically. A conclusively aborted start that adopted no Goal or
round removes its own per-run ref. Successful runs keep their refs.

Updating the person's checkout would disturb their branch, index and draft
work. Requiring an Agent to fetch in its brief would leave the starting commit
to an instruction rather than the host. Both are avoided by using the same
commit-pinning seam as review starts. An existing Goal or explicit review
target cannot also take a remote base: they already own their starting place.
Flows without a base keep their existing semantics.

**The rule:** a declared remote base is fetched once and pinned before work
starts; a stale cached ref never substitutes for a failed fetch.

## A seat whose agent asks before every MCP tool is explained to its person, never answered for

Claude Code's bridge is ours, so it can say which MCP server asked, and the host answers a flow seat's request for the
desk's own board tools (the bridge's structured claim, never a title). Gemini CLI is not behind a bridge of ours. Its
permission request for an MCP tool carries a title such as `list_intents (harnessdesk MCP Server)` and nothing that
names the server or the raw tool: the structured fields the protocol allows for that (`_meta`, `rawInput`) are not
filled, and a server the client supplies in `session/new` has no `trust` field. A title can be imitated, and a
trusted folder's own Gemini settings can define a server with the same name, so answering "allow" on a title match
would hand a stranger the desk's board. The desk therefore doesn't answer, and it doesn't write Gemini's settings
either (the agent owns its own world).

What the desk does instead is say it, in the product's plain words. The permission card, only when the request names
one of the desk's board tools in the exact form, says what the agent wants to do with the board, and that the desk
can't confirm which server is asking. "Allow once" stays the filled choice; the agent's own grants stay quiet and
apart, so a lasting grant is a deliberate click. The adapter types each grant from the agent's own option ids (one
tool for this session, a whole server for this session, beyond the session) and declares the words, so the card reads
data and never parses English. Where Gemini offers no lasting grant, the card says how to turn that on in its settings,
and the setting key sits in a hover title, not in the line. The flow preview warns, before a run, that the first time,
this agent asks once for each HarnessDesk tool it uses. A server-wide session grant keeps the agent's own explicit label, so a broader grant is never
softened to read like the narrow one.

This is a workaround, and it only makes the prompts understandable: they remain. What would remove them is for the
agent to say which server asked, or to let a client trust the server it supplied, for that session only. That is asked
upstream in google-gemini/gemini-cli#29595; the card and the warning can go once it lands.

**The rule:** when an agent can't prove who is asking, the desk explains the question and the choices and leaves the
answer to the person; it answers for the agent only on a claim made by code the desk ships.


## A check retry is a fresh consent to one card, and a launch survives only in its recorded group

The Flow pilot found a check that answered `no-pr` had no way back: reopening
its board card left the run settled. Restarting instead left a detached check
alive, while the retry either refused the checkout that check had changed or
held the person's request until the whole command ended. (#1245)

A finished or interrupted check on a running or stalled run uses the same
consent dialog from its own card. A stopped or settled run refuses the retry
and asks the person to start a new run. Its preview binds the frozen command,
card, attempt, checkout and the
revision there now. A moved checkout after the preview refuses; the same
checkout changed by the old check can be explicitly approved. Starting reopens
that card, preserves previous evidence, and returns at launch. Completion stays
in the run's queue and advances an unanswered final round normally; a check
from an earlier round never duplicates its already-created downstream rounds
or changes their run's state and reason. Only the current final check round
can restart routing. A retry admitted before its run ends stays counted as
busy work; Stop aborts it inside the queue as well as before it, and wrapping
waits for the command, evidence and card completion to settle.

A detached shell waits at a launch handshake until the host has synced its
exact pgid and leader identity in a host-owned journal. Startup stops only those
recorded groups before recovering runs, rejects signalling a reused leader,
and refuses to proceed if cleanup cannot be established. A live group with no
matching leader identity keeps its journal and refuses startup; the supervisor
holds that identity until the whole group is stopped, even after the command
finishes. Recovery failures refuse startup independently of Seat-record reads.
Live completion and timeout cleanup use the same proof as startup: an EPERM
probe alone cannot establish that a group is gone. Uncertain cleanup retains
the launch journal and refuses a check result or evidence of completion.
Retry admission also reads that host-owned journal, by the recorded card and
verified process identity, and refuses another attempt while its cleanup is
unresolved. It never signals an unverified group or identifies one by its
command text. Old records without a card identity conservatively block a retry
until cleanup is established.
Concurrent retries wait for their live siblings before routing the round.
Children outside the recorded group are outside this guarantee.
Interrupted work still needs fresh
consent, since killing a process cannot undo its effects.

The attempts a retry leaves are read from the evidence the engine already
wrote, not from the card's operation: an operation is one record a retry
replaces, and `evidence/board` keeps only the latest fact of a question, while
each attempt is a durable `check` fact on the card. `flow/check/attempts`
(`{ run, card }`) lists them oldest first with the Flow's own word for each —
its `exits` entry for the status, else `otherwise`, which is how the engine
answers a completed check's card, and a test holds the two together. It reads
the store and nothing else: no token is minted and no result is judged against
git. An attempt exists once its result is recorded; a retry still running, or
one the desk interrupted before it could keep what it printed, is the card's
operation until then. The refusals the Run and the check already say (the check
is not waiting; the run has settled or stopped) are one function in the
protocol, held to the host's own sentences by tests, so the window can keep a
control disabled with the host's reason on screen; every other refusal comes
from the host's preview, in the consent dialog, whose answer stays disabled
while no token has been minted.

The existing statechart already expresses a retry: `otherwise: retry` plus a
rule back to the check, or an unconditional final rule for every non-landing
outcome. `retry` remains an ordinary outcome, never a reserved command with an
unbounded implicit loop; the run's round and progress budgets still apply.

## CJK font fallback follows the document language

*Owner decision: 2026-10-03, typography 5B.* A Chinese-first list made the
Japanese review sample use Hiragino Sans GB for five glyphs and PingFang SC
for two on macOS. Each language now has a foundation token: Simplified Chinese
is PingFang SC, Microsoft YaHei, Noto Sans CJK SC; Traditional Chinese is
PingFang TC, Microsoft JhengHei, Noto Sans CJK TC; Japanese is Hiragino Sans,
Yu Gothic, Meiryo, Noto Sans CJK JP; Korean is Apple SD Gothic Neo, Malgun
Gothic, Noto Sans CJK KR.

The old `--hd-font-family` value was `'Geist', -apple-system,
BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB',
'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif`.
The new value is `'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI',
var(--hd-font-cjk-fallback), 'Helvetica Neue', Helvetica, Arial, sans-serif`.
The fallback token defaults to SC, TC, Japanese, Korean. `:root:lang(zh-Hant)`
and the Traditional region tags zh-TW, zh-HK and zh-MO put TC first;
`:root:lang(ja)` puts Japanese first; `:root:lang(ko)` puts Korean first.
Regional subtags follow the same rule. Each keeps the remaining lists in
their default relative order. Components still read `--hd-font-family`;
Latin stays Geist first, and code keeps its existing separate stack. No size,
weight, line or trim value changes.

[The per-glyph measurement](typography-cjk/measurement.md) records matching
document/sample languages in both themes, on the catalogue and preview.
Every Japanese glyph now uses Hiragino Sans on macOS. Windows face names are
included and their computed order is tested, but Windows rendering was not
measured.

**One-line rollback:** set `--hd-font-family` back to `'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif` in `packages/ui/src/design/foundation/tokens.css`, then regenerate the token snapshot, native foundation and design documentation.

**The rule:** the interface language chooses its CJK fallback in the
foundation; no component chooses a language's face itself.


## Wrapping ends dispatch, while the receipt keeps conversations readable

Closing a Seat ends membership. It does not erase the conversation or turn it
into new work: a receipt now captures each Seat's own session pointer along
with its name. Older receipts resolve a conversation only from that Seat's
kept answer, and otherwise keep its name without a link. The rail, Overview
and sidebar all read that same list, and it is a list of conversations as an
open Team's is: a receipt keeps every Seat, and a conversation seated twice is
named once — where its first Seat put it, by the last that held it — because
each of those surfaces keys a row by its session. The Run inspector keeps every
receipt Seat by Seat ID, so earlier rounds and cards retain their own details,
conversation action and usage. Cost is read by Seat ID even when the receipt
kept no conversation; a usage report may supply the runtime for source-qualified
money, and otherwise known turns remain visible. A Seat with no conversation
has no session to share, so each is its own row, and the rail says no Agents
were kept only when it lists none. Receipt opens in the pane's scrolling
body, so the record never pushes its own navigation away. A narrow pane opens
on that body, not on the Agents list. An open Team with no Run has nothing to
read first, so it starts on the list; a wrapped Team always has its receipt,
and one a person made, which never had a Run, is no exception.

The renderer uses one wrapped-state rule for dispatching controls and
conversation composers. The host refuses sends, steers, queued dispatch,
reviews and compaction before reopening the conversation and again once it is
open, and a queue draining after a wrap at delivery. A review or a compaction
puts work into a conversation as surely as a send does, so they sit behind the
same barrier, and the conversation menus that offered them show the same
reason instead. Closed Seat history and receipt pointers preserve that refusal
after restart. Run history remains a read; wrapping and deletion keep their
existing lifecycles.

The host asks that question before every send, steer and delivery, so it is a
lookup and never a scan of the desk's Goals: a send on a desk with three
hundred wrapped Teams costs what it does on a desk with three. The Goal store
keeps the conversations its wrapped receipts name, built at the one place a
document enters the store, so it holds for a Team wrapped in this process, one
read back at the next start and one a backup brought. The Seat book answers for
a conversation's Seats, and a Goal's standing is read in place, so a Team
that is mid-wrap refuses from the moment its wrap begins, before any receipt
exists. A dispatch asks twice — before it reopens the conversation and once it
is open — and a send already held by a dispatch is not fenced again. The
renderer treats a Team as wrapped once it reads `wrapped`, the host as soon as
a wrap begins, so a send from a composer that has not heard yet fails with the
same reason instead of being disabled beforehand.

Three things follow from a conversation belonging to a wrapped Team. Stop is
the one control that stays on while a turn is running in it: stopping is not
new work, and the host leaves `turn/interrupt` open for exactly that. It
stands alone in the corner — the refused send is drawn only while nothing
runs, because the composer's send track is one coin wide and clips a second,
which would leave a Stop that is on and cannot be pressed; the placeholder
already says why nothing can be sent. Choosing a conversation is not sending to one, so the Assign dialog does not
list a conversation a wrapped Team keeps, and a host asked to seat one anyway
says it belongs to a wrapped Team — "This Team is wrapped" would point at the
Team the person is in. A skill is a message into the open conversation, so the
palette withdraws an agent's skills there, as it withdraws any entry it cannot
run.

A Run that ends wraps its Team, so a Team can wrap under a person who already
has a question open. That question reads the Team's state live rather than the
data it opened with — a run's own view still says it is decidable — and stays
on screen with its final action disabled and the reason beside it: closing it
would throw away what was typed, and leaving it armed would offer what the host
then refuses. This implements PR 18 of the approved Teams/Runs plan.


## The Flow's travelled route reads the Run's recorded causes

The Run's rounds record the full cause key `after:<round>:<rule>`. The overlay
compares that key with the frozen Flow's rule and both its source and destination,
so a later answer or check retry cannot redraw history as a route the Run never
took. A seed, trigger continuation or externally opened round has no recorded
rule and invents no edge. Loops count those recorded traversals; checks count
recorded results from the separate attempt read. An unfinished operation has
no per-attempt identity or start time, and its result may already be readable,
so adding one would sometimes count the same result twice. Working says that
the check is unfinished; the count changes when a result is recorded.
Incomplete or unavailable history remains unknown.

The overlay leaves the blueprint's geometry intact. Its state marks are a
specialized data view in `design/ui/flow-step`: node rings, completion and duration
badges, seated faces and a baton on a measured curve. The strict audit records
that boundary by module, exports and consuming area. Every surface still composes
Card, Chip, IconTile and Text, and every colour and cadence comes from the
foundation. A new route waits for the baton to finish its previous curve at the
faded end; unchanged snapshots keep both its element and animation phase. Reduced
motion removes the animations and follows new routes immediately.

Step and row selection share the Run's round numbers, so a repeated step selects
all of its history while the inspector keeps one selected row. The Flow retains
the whole pane, and its accessible step list carries the same state and selection.

**The rule:** a Flow overlay says what the Run recorded, including what it does
not know; it predicts no future route and offers no execution control.

## A Run's publication and a review round are separate facts

The Run's `finding/run.publication` folds every posting it holds. It belongs
on the Overview strip, Run header and Findings summary. Its ending keeps the
reason for attention without repeating the aggregate chip. A review
row reads only its own `FindingRunView.rounds` record; a missing record or
`none` never inherits the aggregate. The round budget and Goal-owned open
finding counts cannot establish a new Run's publication.
An empty release decision for work with no review, finding event or posting
operation reads `none`; closing an author or check round does not create a review.
For a local round, the Run's current pull request binding determines whether
it is Not posted, including reviews kept before binding. A posted round keeps
its recorded target.

The Teams page and Overview pass the same confirmed Run read into the shared
selector. A bound, posting-enabled local review, partial posting or uncertain
posting needs the person. A first read still pending establishes nothing;
`finding/changed` invalidates it too, and an older answer cannot replace the
newer read.

`finding/publications` supplies actions, not successful publication states.
Both the Findings pane and inspector use one action hook for post-again,
skip, backfill and host refusals. Backfill keeps its stamped preview and asks
for confirmation; copy remains available when posting is refused. A late
action answer belongs to the visit that submitted it, even if the person
left that Run and returned before it answered.

**The rule:** chips follow the host's recorded state, actions follow its
offered door, and a person presses before a posting is sent.

## Finished Seats release handles and idle runtimes release retained tools

Measured 2026-10-04 on codex-cli 0.160.0 with
[`script/probe/mcp-release.mjs`](../script/probe/mcp-release.mjs): a fresh,
isolated `CODEX_HOME` configured one tiny Node MCP server answering only
`initialize` and `tools/list`. Starting one thread created one child.
`thread/unsubscribe` answered `unsubscribed`; one second later that child was
still alive. After the app-server exited, the child count was zero. No turn
was run, and the person's agent configuration was never read or changed.

`CodexSession.close` already sends that unsubscribe. The host's
`#restSeats` calls it for completed Seats, including Flow Seats, once their
held-card history says all their work is done and their conversation has no
turn, approval, queue, pending dispatch or running task for `SEAT_REST_MS`.
But its resume-and-idle-stop capability guard excluded the Codex adapter,
which had no `stopForIdle` implementation. Closing a thread alone would not
have freed its retained tools anyway: the runtime process owns their lifetime.

`CodexRuntime.stopForIdle` now participates in the existing host reaper.
It refuses while a conversation handle or an integrated terminal is open,
preserves its observed catalogue, project defaults, account and cached
history, then stops the app-server. It reports `idle`, retaining its learned
capabilities and sign-in. The host's stop barrier blocks new operations until
exit, and its single-flight `#ensureStarted` restarts for new work; the normal
resume path reopens the same conversation and reapplies its frozen attachments.
Observed reads stay cached while idle. A history page, project defaults or
skill list that was never observed restarts through the same host barrier;
`canReadWhileIdle` distinguishes a missing snapshot from a real empty answer.
Concurrent reads, including account status, join any restart already in flight
before asking the adapter, so handshake time cannot erase their answers.
Runtime-backed filesystem, process and extension calls, and hook reads, use
that same stop/start barrier and count as activity until they finish. A live
filesystem watch, like a terminal, keeps the process until unsubscribed.
Account activity and rate-limit reads wait for those barriers too. Passive
history, catalogue and usage reads protect their in-flight calls without
resetting the runtime's quiet interval: a read spanning its deadline delays
shutdown only until it finishes. Dashboard usage polls keep the last observed
rate limits and account activity readable while idle, without restarting the
process or refreshing their recorded observation time. New account
notifications invalidate those usage observations.
Deleting, archiving, renaming or updating a conversation invalidates retained
history pages of every size and side. A page fetched across such a change is
not retained; an unobserved page is read afresh through the host barrier.

Both existing intervals stay ten minutes: a finished Seat first releases
its handle after its quiet interval, then a wholly unused runtime stops after
its idle interval. A Seat that never held work, or one still holding unfinished
work, keeps its handle. A continuously working shared runtime retains finished
threads' children until a quiet opportunity arrives. This chooses the measured
release boundary without interrupting work or changing any configured server.

## One family of tables

Tables, lists and settings rows centre the face and the control on the whole
row, however many lines the copy takes. This reverses the first-line pinning
recorded in ListRow and Settings: it needed separate height boxes and negative
vertical nudges and made controls float above the other cells. One centre
survives a wrapping sentence and gives every arrangement the same anatomy.
The system, catalogue and preview change together; individual screen content
follows separately. The windowed Git pitch and its table-row button stay 26px.

Each decision has its own token. Values are comfortable / compact; unchanged
values apply to both. To roll back a token independently, set it to the value
in this table's rollback column in both density scopes. To restore the previous
anatomy, revert this commit, including the alignment census's row-centre rule.

| Token | Value | Rollback |
| --- | --- | --- |
| `--hd-table-head-h` | 40px / 32px | Set back to 32px. |
| `--hd-table-head-size` | `var(--hd-text-sm)` / `var(--hd-text-xs)` | Set back to `var(--hd-text-xs)`. |
| `--hd-table-head-ink` | `var(--hd-secondary-foreground)` | Set back to `var(--hd-muted-foreground)`. |
| `--hd-table-row-min` | 56px / 40px | Revert this commit; previous cells had no shared floor. |
| `--hd-table-row-min-bare` | 44px / 32px | Revert this commit; previous cells had no shared floor. |
| `--hd-table-cell-x` | `var(--hd-inset-row)` / `var(--hd-inset-dense)` | Set back to `var(--hd-inset-dense)`. |
| `--hd-table-edge` | `var(--hd-card-padding)` / `var(--hd-inset-row)` | Set back to `var(--hd-inset-dense)` for tables; revert this commit for the former separate row insets. |
| `--hd-table-face` | 32px / 24px | Set back to 24px for table faces; revert this commit for the former private 34px settings tile. |
| `--hd-table-face-radius` | `calc(var(--hd-face-radius) * 4 / 3)` / `var(--hd-face-radius)` | Set back to `var(--hd-face-radius)`. |
| `--hd-table-lead-gap` | `var(--hd-space-3)` / `var(--hd-space-2-5)` | Set back to `var(--hd-space-2)` for tables; revert this commit for the former 24px settings gap. |
| `--hd-table-name-size` | `var(--hd-text)` / `var(--hd-text-sm)` | Set back to `var(--hd-text-sm)` for table names. |
| `--hd-table-fact-size` | `var(--hd-text-xs)` | Revert this commit; the former value was already 12px. |
| `--hd-table-sentence-size` | `var(--hd-text-sm)` / `var(--hd-text-xs)` | Set back to `var(--hd-text-xs)` for lists. |
| `--hd-table-line-gap` | `var(--hd-space-0-5)` | Set back to zero for lists. |
| `--hd-table-end-gap` | `var(--hd-space-3)` / `var(--hd-space-2)` | Set back to `var(--hd-space-2)`. |

## Messages follow what caused them — 2026-10-04

Runtime information arriving at launch is neither a failed action nor a reason
to interrupt a conversation. Its structured facts belong in the Inbox, while a
notice scoped to one session belongs in that transcript. Only user-action
results open toasts. Standing conditions retain the existing policy and outlets.

Runtime information is retained in host preferences before clients connect.
Content keys are exact serialized class, kind and content, independent of event
identity and time. Occurrence IDs make replay idempotent; repeats update count
and last time without resetting read state. Cleared information keeps its
content memory, so another runtime start cannot raise it as new. Kind-level
mutes remain available in Notifications and the expanded Inbox row. Counts
outlive the bounded retained history, so muted traffic cannot reset a visible
row’s count. Older queued events do not recount retained startup information.
Windows offer individual runtime occurrences to the host, which merges them
with its current read, clear and mute memory; a cached window cannot replace
that memory while receiving background messages. Every merge, including a replay
or a refused occurrence, returns the current Inbox and policy to the window.
Reads, clears and policy edits carry their prior snapshot so the host applies
only the changed rows or kinds, retaining other windows’ edits. A late response
cannot undo a newer local action.

For a standing Inbox row, `id` names the condition and `at` names its
occurrence. Content-keyed runtime rows instead keep the same row as their
count and last time advance. The host keeps the latest standing occurrence
time after a row is cleared:
the same or an older copy stays cleared, while a later occurrence is admitted
unread. A read or clear from a window whose snapshot predates that occurrence
cannot change it. These receipts are host-owned and bounded, with live rows
retained ahead of recent cleared ids. If a cleared receipt is eventually
evicted and its kept key has also been released, a very delayed insertion can
be admitted again.

Host-created transcript notices survive richer reads of their own turn and
unmatched synthetic notice turns survive cold reads. They never get copied
into unrelated fork turns or preserve work turns removed by rollback. Repeated
conversation updates are counted within the turn they accompany.
Retrying errors preserve live state; an error already carried by a failed turn
uses that turn's existing explanation.

## A comparison gates the subject its review selected

*Issue #1382.* A judge could select one attempt while raising blockers on
another, and the keep step waited forever on work nobody would repair.
The evidence guard already selects the one subject every required reviewer
chose; the findings gate now uses that same selection. It subtracts only
readable, locally raised blockers attributed to the unselected checkouts.
A selected subject’s blockers, findings from elsewhere, damage and pending
exceptions still hold the rule.

The alternative was to close the other findings as “not kept”. A selection
is about which attempt continues, not whether a claim was correct, so the
findings stay open. The accepted route’s durable review evidence explains
**Not kept** in their list and detail; no new lifecycle event or verdict is
invented. An ordinary single-subject review excludes nothing.
The explanation is tied to the claim’s raising review round and immutable
checkout, including advisory claims outside the frozen blocking set. Later
reviews of the kept attempt do not replace that accepted selection. The open
list and any open detail reload when a route’s evidence changes, while
routine Run updates keep their paging positions. A detail keeps the person's
typed reason and discards reads superseded by that selection. Downstream
gates honour the same accepted selection even after their dependency walk
contains only the kept attempt.

A reviewer can also correct a mistaken claim before finishing its raising
card: a reasoned withdrawal is allowed there. Confirming or rejecting a
repair still needs a later review of the raising Agent. The same ownership,
revision, sequence and open-card checks apply to both paths.

## A runtime wears the face shape — 2026-10-05

The owner chose the face shape for runtimes: a runtime is who does the work
in these lists, and one meaning keeps one shape everywhere. Settings,
setup, Add a runtime, gateway rows and the runtime card all follow the
person's Faces setting — square corners by default, round when chosen.
Accounts keep their rings; plugins, skills, files and sections keep their
square tiles.

**The rule:** a runtime is a face, and its corner comes from the Faces
setting wherever its mark appears.


## Bare Settings rows keep their own block inset — 2026-10-05

A row without a description, mark or face uses 8px block insets and the
ordinary 12px inline edge. A 28px button then composes to the table family's
44px bare pitch; the 12px block tier would make it 52px. In the synthetic
Appearance page, switches measure 44px under either tier, while segmented
controls measure 46px at 8px blocks and 54px at 12px blocks. The floor is not
a ceiling: a taller control or wrapping content can grow the row.

The full-row and bare-row predicates name the same three slots. A face without
a description is still a full row, so its tile keeps the 12px tier in both
densities. The container-inset guard checks both padding and visible content
for each predicate; no row is omitted and no tolerance changes.

Roll back: remove the bare-row padding override and return all Settings rows
to the row inset tier, accepting the resulting larger control rows.

**The rule:** only a Settings row with no description, mark or face earns the
8px block inset; every Settings row keeps the 12px inline edge.

## Library gives the identity room before comparing columns — 2026-10-05

Content-sized State and Loaded by columns protect their facts but can spend
almost all of a narrow table's width. The four-agent preview uses 283px for
those columns; at a 720px Settings window, the list is 378px wide and Skill
had only 95px including insets. At a 900px window the list is 558px wide;
even balancing the remaining description measure left a two-word line.

Below 600px of list-container width, Library therefore uses the table family's
list rows: name and command on the title line, a two-line wrapped description,
state on the meta line, and whole loading faces and the chevron in the trail.
The definition keeps the full description one click away. At 600px the table
has about 293px of identity text beside those trailing facts; the identity
cell also keeps a 192px floor. This reads the container, like Teams, so both
the standalone Library and the Settings page respond to their own space.

In that earlier Library repair, the header's markup, relevant PageHead styles
and Settings reading measure were unchanged from main; its narrow blurb was
pre-existing and outside the repair. #1424 later changed the header's wrapping
and text basis.

Roll back: remove the container observer and narrow ListRow composition from
SkillList/SkillRow, accepting the former crowded identity column.

**The rule:** switch a comparison to its list form before trailing facts
consume the width its identity and sentences need.

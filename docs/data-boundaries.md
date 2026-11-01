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
To see a card's pull request and its CI, the desk asks your forge with your
own forge login in the card's checkout. Publication uses the separately pinned
host gateway described below. A flow's check command may read
`HARNESSDESK_FLOW_CONTEXT`: bounded, host-derived JSON naming the revision,
checkout and lane ports a round's own subjects are — never an arbitrary
environment map, and never anything that was not already visible in the
checkout the command runs in.

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

When a detached conversation omits the PR number in view, checks, review or comment, the host reads that conversation's intact successful creation records locally and asks the pinned GitHub repository for each recorded PR's number, state and head branch. The outbound request names the repository and PR number and uses the host's existing forge login; the local journal and conversation identity are not sent. Follow-on plugin view and checks reads explicitly name the pinned repository on github.com through the existing shell grant; the review-link API read also names github.com as its hostname. This is on demand, with no background polling. Only a unique open matching creation is selected; the capability returns minimal selection metadata, and the existing tool reads and write checks still apply.

### Optional local phone access

`HARNESSDESK_PHONE_LINK=1` enables a LAN WebSocket listener. Settings › Phone
issues a code containing the desk's public key, local endpoints and an
enrollment secret that works once for ten minutes. The phone proves its key;
the person allows or declines it on the desk. Pairing requires no account link
and sends nothing to the account service. Session traffic is encrypted between
the paired phone and this desk.

A paired phone can receive the Lead thread and redacted work projections,
page active and archived session metadata, and read their redacted transcripts.
With Run it can create a session in an admitted project or a fresh chat folder,
send text to an active ordinary session, and interrupt a supported running
turn. These actions reuse the desk's host methods without changing session
permissions or model settings. It can also send to the Lead, stop or resume
it, answer its cards and permitted worker questions, and request required
checks. Approval decisions require Answer. Read, Run and Answer grants bound its
surface. The desk identity, paired-device keys, grants, revocations and port
live under `phone-link/` in the local state folder. Removing a phone closes its
connection and requires pairing again; starting without the opt-in closes the
LAN lane. Account sign-out and deletion do not remove this separate registry.

### Optional Lead provider requests

Lead requires the startup opt-in `HARNESSDESK_LEAD=1`, a configured provider key
and a runtime whose permission model blocks the network for its restricted
child. The desktop app's bundled Node is downloaded from nodejs.org when the app
is built, never by the installed app. Its host sends model requests containing
the project root, system instructions, conversation, approved contract and tool
results to the configured provider transport. When asked to manage project chats,
these results can include their titles, state and redacted transcript projections.
Chat reads are bounded to 12,000 serialized bytes, with separate counts for
omitted raw source turns (`omittedSourceTurns`) and projected phone entries
(`omittedPhoneEntries`); partial text still sets `truncated`. The phone wire
does not serialize this projection metadata.
Only ordinary sessions in the selected canonical project are available; Team
seats and other projects are refused. Chat state notifications contain ids and
state, not transcript bytes. Ordinary delegated chats use the desk's saved session
permissions and their agent's existing connection and spend. Provider credentials stay in the
host; the child asks through a bounded provider-send port. Workers retain their
own agent connections. Lead's journal, plan decisions, allowances and worker
observations stay in the desk's state folder. Stop ends the active request and
owned work without deleting files; disabling the startup opt-in leaves the
journal on disk. The current desktop's embedded runtime is below the child
floor and reports Lead unavailable before sending a request.

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
agent credential or project path is sent through this lane.

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

After initial load, reading ordinary account status returns host state. The
initial load refreshes an existing sign-in or cleans up an unfinished one.
Reachable from your phone only saves a local preference; it sends no request. A fresh signed-out desk
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
Agent accounts and all local work stay available. The phone-access switch
only saves a preference in this build; no desktop relay connection is opened.

## Account transport boundary

Signing in does not enable hosted execution, work synchronization or a relay
connection. Local phone pairing and agent/provider connections have their own
boundaries above.

## Local provenance

Capture reads available refs and Git objects for registered projects on this machine. Its journal, immutable patch fingerprints, original Seat links and known history gaps stay beneath the project's folder in the host's evidence directory. It retains neither raw patches nor another transcript or brief body. It contacts no remote and never fetches a missing object.

**Retention:** observations remain until the corresponding local evidence data is removed; disabling capture keeps existing history. Workspaces › a project › Provenance turns capture off for that project on this machine, including its linked checkouts. The preference lives in `provenance-preferences.json` in the host state directory, outside the repository.

A backup may carry the versioned, size-limited historical sidecar. Restored records are marked historical; imported cursors, health and preferences do not activate capture or authorize new local associations. No provenance data leaves unless the person chooses to export or share it.

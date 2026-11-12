# The decisions this is built on

The choices that shape everything else. Each is
stated as it stands today, not as it was argued — what the code does, and what
it costs to keep doing it. Where a decision has a rule a reviewer can apply,
the rule is the last line of its section.

---

## The Lead's own context: answered from the journal, summaries bounded in turns, wakes with a cause — 2026-11-12

A sitting found the Lead retelling its settings in unrelated replies, summarising its conversation on nearly every exchange, a silent "desk change" under replies where it spoke, and a reset of 21 days 3 hours said as 22 days.

- **Answered is read from the journal (#2170).** The child stores the Lead's reply itself and returns a result without the words, so the host's check of the result never saw an answer and the settings mark never moved. The host now notes the journal's seq when the request leaves and counts the request answered when a reply the model wrote, not proactive, was stored past it. The checkpoint instruction leaves settings, rules and memory status out, because a summary that tells their story opens every later request with it; the instructions and the memory note say the desk status is reference and is never restated unless the person asks or a line says it changed; and a pending proposal says when it was proposed. Rejected: calling the mark from the supervisor's reply path, which would move it for replies to requests that never read the settings.
- **A summary is bounded in turns as well as tokens (#2171).** Pressure is the largest of tokens, bytes and turns, and the kept tail was sized only in tokens: with short exchanges a sixth of the window is well over a hundred turns, so a summary landed just under the line and the next exchange crossed it again, each time a new epoch and a cold cache. The tail now keeps at most 55% of a request's turns, the next soft line is never nearer than the hysteresis above where a compaction landed, and an idle prune that would lower the pressure by less than 0.05, or an idle compaction whose folded turns, less a checkpoint at its full length, carry less than that, is skipped and spends no epoch; a skipped look waits for the hysteresis, never below the usual line. The hard line, the provider's too-long answer and Summarise now still always compact.
- **A wake needs a cause (#2172).** The child's minute tick, which lets a quiet run be called stuck, recorded a silent desk-change wake every time it found nothing, and the collapsed ledger showed only the latest wake. A batch is now recorded only when it found something: a tool continuation, a look that woke, a chat change, a desk wake owed or a decision the person's Observe recorded. Prose notices and Team changes that wake nothing add no row. Evidence that arrives with no run or card event keeps its one row on purpose, as the sign the child read the desk again. A blocked batch records when it runs; collapsed, the ledger shows the latest wake that made a model turn.
- **The Lead quotes the Dashboard's countdown (#2174).** The countdown formatter moved from the UI into `packages/protocol` (`countdown.ts`, beside `elapsed.ts`); `lead/usage/summary` adds `resetsIn` and `resetPassed` per window and `readAge` per account, and the tool description says to say them as written and never round. Rejected: telling the model to round down, which still leaves two surfaces with two rules.

**Rule:** what the Lead said is read from the journal, never from what a request returns; a compaction must leave the conversation well under the line it crossed or not run; a wake is recorded only when something caused it; a time the Lead is told is in the words a screen shows.

## The Lead reads its settings as they stand, the device per message, and no ids — 2026-11-12

A sitting applied a rule line from the Lead's proposal, edited the line away in Settings, and asked again: the Lead said the line was already in force, and on later turns volunteered "corrections" about its settings that nobody asked for. On the desktop, after it proposed a change, it told the person to press Apply on the phone, the device of an earlier message. Its prose named proposals by ids such as "s1" and "s3", which Settings also showed ("Applied from proposal s3"), and at a narrow width the Work rail drawn over the thread hid What happened?.

- **The settings status is the state now, not the proposal history (#2165).** `<desk-settings-status>` gives every mode's value and every rule section's version and current words, each with its last change and who made it: the person's Apply on a proposal, an edit, a restore or a reset in Settings. Applied proposals are no longer listed; only those still waiting or declined are. It tells the Lead that something asked for is in force only when the value or the words say it, and otherwise to propose it again, and that the block is reference, not news: a change is mentioned when the person asks or when its line says it changed since the Lead's last reply. That mark moves only once the Lead's reply to the person is stored, never on a failed request, a wake or a proactive turn, and the autonomy file keeps it across a restart. The rules in the standing instructions change only at the next epoch, so a section's words ride the request when they differ from the ones the epoch's instructions hold, which the child records beside the epoch when it builds them (never the settings the host reads, which can move before the child builds or after a restart); the block sits after the cache mark and is billed every request, so a section the instructions already hold, or one never changed, is one line, modes at their default share one, and the whole stays within 2.5 KB. Rejected: dropping applied proposals from the status alone, which would still leave the Lead unable to tell a line the person removed from one never applied; and a rule that the Lead must reread the rules each turn, which is a reply script, not a capability.
- **Each person message keeps the surface that sent it (#2166).** The `<person-device>` block was desk context of the moment and was stubbed once stored, so a tool continuation (after `autonomy_propose`, say) wrote its reply with no device in view and fell back on an earlier message's. The journal now stores `surface` on the person's own message, and the history line after the message's reference names it, so every request, continuations included, reads each message with its own surface. That line replaced the block rather than joining it: two sources for one fact, and the block was the only place the device's own name reached the model. The instructions say an earlier reply was right for its own message's surface: never correct it, never write "on the other device". `surface` stays out of the thread the window and the phone draw.
- **No proposal ids in the Lead's words (#2167).** The proposal's result reaches the Lead without its id, the notes say "your earlier proposal" instead of naming one, and the settings and memory statuses list proposals without ids. A memory entry keeps its tag (`tag m2`), since its desk-memory line and a plan step's title use it, and the status says never to say a tag to the person. Settings shows "Applied from Dex's proposal" (the Lead's chosen name) where it showed the id; the id stays in the data. The phone draws its own ledger line from `proposal`, so its wording is the phone's to change.
- **What happened? is a top-bar tool (#2168).** At the foot of the rail it sat under the Work list, and a narrow window draws the rail over the thread, so the rail covered both the button and the card it brings. It is now a top-bar button beside the rail toggle, shown once the thread has a message, with a spinner and Reading… while the desk answers.

## A prompt link fills a draft and nothing else — 2026-11-11

An OS `harnessdesk://` launch was only a focus hint: the shell read neither the URL nor argv, so nothing an OS launch supplies could authenticate the desk or act in it ("Desktop account sign-in uses explicit browser approval and host polling", 2026-10-24). That rule now has exactly one exception, `harnessdesk://new?repo=…&prompt=…` with optional `pr` and `flow`. It brings the app forward and fills a new chat's draft in the project it names. The person reads the draft and presses Send.

- **Why one route is safe.** Its only effect is text in a composer, which is where a pasted prompt would have gone anyway. It never sends, starts a run or a Flow, attaches anything, or changes a permission ceiling, a setting or an account. The repository must already be a project on the desk; a link cannot open, clone or trust a folder, and an unknown one gets "Open this repository first" with the repo as text. The marker over the composer ("From a link — review before sending") stays until the first edit or the send. A draft already typed there, its words or any chip it carries, is set aside to Restore, never overwritten, and the link's draft replaces text and chips together. The words go to the new chat's own composer, never to the conversation the pane is leaving, and the newest link wins: one still waiting on the host when another arrives stops where it is.
- **One strict parser, in the shell.** `packages/desktop/electron/prompt-link.mjs` accepts only scheme `harnessdesk:`, host `new`, an empty path or `/` as written (read before URL parsing resolves `/send/..` to `/`), and no credentials, port or fragment. It caps the URL at 16 KB and the prompt at 8000 characters, refusing a longer prompt rather than cutting it. It strips NUL, the other control characters except newline and tab, and bidirectional overrides, so the draft reads the way it will be sent. `pr` is a positive integer and `flow` a slug, and repeating one of the four refuses the link. Unknown parameters are ignored, never read: ignoring one cannot make the app do anything, and a newer link still fills a draft in an older app. Rejected: refusing links with unknown parameters (a refused link turns silently into a plain focus, which tells nobody more).
- **Taken once, never pushed.** A link waits in one slot in main; the app window's renderer takes it over `harnessdesk:prompt-link-take` once it can resolve projects, and a nudge carries no data. A cold start (macOS `open-url` before the window, or the first instance's own argv on Windows and Linux) is kept until then; taking empties the slot, so a reload or a crossed nudge never delivers twice. On Windows and Linux only an argv element starting with `harnessdesk://new` is read, and only the first.
- **`pr` and `flow` are words.** The composer has no way to attach a pull request or choose a Flow, so the marker says them as plain text and nothing acts on them.
- **Not in the browser build.** A `?new=` query on the UI's own address was considered and left out: that address carries the desk token, so a shareable link would either carry a credential or not open at all.
- **Still refused.** Every other host and path — `return` among them — and every other argv element remain a pure focus hint: never parsed, logged or passed on. No route reads a token or a code.

**Rule:** a `harnessdesk://` launch may only fill a draft, through `parsePromptLink`; anything that would act on the desk is not a link's to do.

## A seat that hits its usage limit is replaced, never moved — 2026-11-11

Carry-on (continuing a conversation on another account or agent when a turn hits a usage limit) applies to Team and Flow seats as well as chats, with the same rule and the same `carryOn/decide`. A seat's question is never a card over a composer: it goes on the Team's own `usage limit` notice for that member, as Switch, Wait until reset and Stop.

A `SeatRecord` is bound to its conversation and its label, and a run stalls a seat that comes back under a different label. So a switch opens a replacement seat for the same card, in the same checkout and lane, with the same role, card, blind setting and binding. Only the conversation and the label change. The round lists both seats in order, the old one closed with `limit`, and a review guard asks only the seat that is working now. A sibling account of the same agent resumes the same thread; any other agent is seated with its brief and gets the handoff packet as its first work message. A blind reviewer's packet leaves out the recent turns, so it reads nothing of the work it must judge independently.

Each candidate goes through the independence check in both directions before it is opened: a reviewer cannot move onto the provider of the work it reviews, and a writer cannot move onto the provider of a seat that must be independent of it, or leave a step still to come with no independent candidate. A refused candidate is skipped, with its reason in the incident's note. When none passes, or the run is at its budget ("Run budget reached"), the seat stays stopped with its `limit` notice.

While an incident is live, the seat's own recovery (re-arming the card, retrying a release) does not run, so the card is never handed back underneath the question. When the incident ends stopped, that recovery runs as it did before.

Rejected:

- **Changing the seat's conversation in place.** The run's journal, its evidence and the `#sameSeat` check all rely on a seat keeping its conversation; a moved seat would read as one that silently changed agents.
- **A carry-on card in the Team view.** The notice already says the member stopped; a second surface would say it twice.
- **Letting the seat's recovery run beside the question.** Both would hand the card out, once to the stuck account and once to the replacement.

**Rule:** a seat is carried on by a replacement for the same card that passes the run's independence check; the old seat stays in the round, closed with `limit`; and nothing hands the card back while the question is open.

## The Lead's child and its host check one argument table, and a stop says where it happened — 2026-11-10

The Lead's child asks the host to write to the journal over a framed pipe, one named operation at a time. Two places checked how many arguments each operation may carry: the frame decoder, with a cap of two for most operations, and the host's dispatch, with an exact count. When the child began journaling the memory Core each conversation epoch reads (three arguments), only the dispatch was taught the new count. The decoder refused the frame, the host stopped the child as a broken protocol, and because the record is written on the first request of every new epoch, every request after a summary failed before it was reserved. Each Resume started a child that stopped at the same place, and nothing anywhere said why.

Now one table in `child-ipc.ts` gives each operation its fewest and most arguments, and both checks read it. One test calls every operation at its full count and one more; another drives every call the child makes and checks what it sends against the table. Every failure that stops the child is logged once by stage (`frame rpc memoryEpoch`, `rpc appendReply`, `stdin`) and code. The failures the child catches and carries on from (a reply it could not store, a lost subscription) reach the same log over a `failure` frame. Its stage must be one of a fixed list. Its code must be a `lead-…` code, a system code (`ENOENT`) or a class name, which are the only shapes the child's reducer produces; a free-form message, which can carry a path, a key or the person's words, is never one. A diagnostic never owns the child: a malformed `failure` frame is dropped and logged as `lead-failure-invalid`, never treated as a broken protocol. Each child logs a given stage and code once, and at most 20 distinct reports; past that, one `lead-failures-suppressed` says the rest were dropped.

When the child stops twice in a row with the same exit reason after the same logged failure, the wait becomes `lead-child-exited-again`: a setup wait with no Resume, which says the desk log names the step. That is true by construction, because an exit that logged nothing (the process was killed, the desk went away, startup timed out) is never called a repeat and keeps Resume. Any answer from the provider, whatever its status, starts the count over, because the child got past every step before the request; so does any request that comes back to the host, and so do switching the Lead off and on and changing its key. The host latches its wait when the child exits, while the request that was waiting on the child fails on its own path, and either can land first: a request failure never overwrites `lead-child-exited-again`, so the wait that names the cause stays in both orders. A message from the person still resumes the Lead and sends the request again.

Rejected:

- **Reaching the dispatch without a frame check.** The frame check is what stops a child from reaching an operation it was never given; it stays, and reads the same table.
- **Stopping Resume after N tries.** A count says nothing about why. The same stage and code twice is the repeat a person can do nothing about by resuming.
- **Letting the child name its own stages and codes freely.** The child runs model-driven code; whatever it may write reaches the host log, so a report is held to names the host already knows.
- **Letting the last writer win.** Whether the exit or the failed request lands first depends on timing; a wait that changes with it would say "stopped again" one time and "request failed" the next for the same stop.
- **Putting the stage in the person's notice.** The wait is a closed set of reasons a surface translates; the stage is a developer's name and goes to the log, as the `-again` refusals already do.

**Rule:** an operation's argument count is declared once, in `LEAD_RPC_ARGS`; a failure that stops the child or is caught by it is logged by a known stage and a code-shaped name, a malformed report is dropped rather than fatal, only a repeat of the same logged stop withdraws Resume, and nothing that lands after it overwrites that wait with a vaguer one.

## The Lead withholds a credential-shaped piece instead of refusing the whole request — 2026-11-10

Before a Lead request leaves the machine the host checks the whole body for anything shaped like a password, key or token, and refuses it if one is there. The conversation that body carries is stored, so a refused piece was in every request after it: one config line a worker printed, read back by the Lead, stopped the Lead for good. The child now runs the same check block by block before it builds the body, and puts a one-line notice in place of each piece the host would refuse: a text keeps its place, a tool result keeps its correlation, a tool call keeps its id and loses its arguments. Reasoning is signed and cannot be edited, so a reasoning block that screens is dropped from an earlier assistant turn, which the provider does not need again, and kept in the latest one, whose tool loop needs it. The body the host checks is then the one the child counted and reserved, built once. What cannot be withheld piece by piece — the instructions, memory and rules every request starts with — is not sent at all, and reserves nothing. The child tells the host what it withheld as counts (turn, block kind, how many) with the first send of a request, and the host log gets one warning per such request, with the request id and sizes and never the content.

A request the host still refuses before handing it to the transport is refused by name: the child settles it at zero rather than writing the reservation off as an unknown charge, the host log gets one warning naming the check, the request id and the sizes, and the Lead's wait says the request was not sent instead of telling the person to send a message to continue. The wait says which: `lead-request-withheld` when the instructions, memory or rules hold it, `lead-request-held` when the host's own check found it in the conversation (only the host can check against the real key), and `lead-request-unsent` for any other check. When the next request is refused the same way, the wait becomes `lead-request-held-again` or `lead-request-unsent-again`, which points at the desk log; a request that completes starts the count over. A send that may have reached the provider stays uncertain, as before.

The check itself stays strict: any value counts as a credential, in any script, unless the whole value is a placeholder — `…`, `...`, a run of `*` or `•`, `[redacted]` or `<redacted>` — ending at a delimiter, an encoded line break, or a quote that really closes an encoded string. `password=…"hunter2` is a credential. A line the desk clipped to `authorization: …` is text; `password=пароль` is not.

Rejected:

- **Dropping the whole tool result or turn.** It breaks the tool-use correlation the provider requires and loses everything else the read said.
- **Letting the host rewrite the body.** The host would send a body the child never sized; the reservation and the request would disagree again.
- **Writing a refused request off.** Nothing was sent, so nothing was spent; a write-off charged the reservation's price for every attempt.
- **Requiring a letter or a digit in a value.** It let a password in another script, or made of symbols, through the request check, the journal mask and public projections alike.

**Rule:** a piece the host would refuse is withheld before the body is built and counted in the log; a request refused before sending is settled at zero and says it was not sent, and why.

## Review threads are settled by outcome — 2026-11-10

After a repair round, a pull request is left full of open review threads: the ones the fix addressed and the ones the seat chose not to take. A reader cannot tell them apart without opening each, and a bot reviewer opens new ones on every push. The desk now settles each thread by what happened to it. A fixed thread is resolved and nothing is posted, because the commit is the answer and a "done" reply is noise in the reviewer's inbox. A declined thread gets exactly one plain sentence saying why and is left open, because the decision belongs to the reviewer, not to the seat that disagreed with them.

The host, not the plugin, decides what a thread is. It reads the pull request's threads before every settle, so whether the thread belongs to that pull request, who wrote it and whether that author is a bot come from the forge. The answer is validated as one sentence of at most 280 characters on one line with no link, markup, `@`, or reference to another issue or pull request, in the plugin, at the extension boundary and in the gateway, with the same function each time. The host adds the desk marker so the answer is known as the desk's own. A thread is answered once; a bot reviewer's threads on one pull request are settled in at most three distinct repair rounds, after which the rest is left to the person. A person reviewer is not capped, because a person who keeps asking is a conversation, not a loop. Both counts are host state written before the write, and kept when the write may have reached the forge: answering twice, or under-counting a round, is worse than one round too few.

Rejected:

- **Replying to every thread.** A reply on a fixed thread adds a notification and says nothing the commit does not, and an agent that always replies drifts into arguing with a bot.
- **Resolving declined threads.** It hides a disagreement from the person who has to judge it; a declined thread stays open until a person closes it.
- **A separate bot account.** It would be a second credential to store, scope and rotate, and it would cut the answer off from the person who is accountable for it. The answer goes out as the person, through the same pinned gateway and Git record as every other write, and the marker says the desk wrote it.
- **Trusting the plugin's word on the reviewer.** A plugin claiming a thread's author is a person would lift the cap; the host reads it instead.

**Rule:** fixed means resolve and stay silent; declined means one sentence, once, left open; a bot reviewer gets at most three repair rounds per pull request, counted by the host.

## Reading a conversation back is not activity — 2026-11-09

Loading a stored ACP conversation replays it, and the replay is history being
re-read: the adapter folds it into the read and announces nothing until the
read is whole. One path used to announce each replayed answer and thought as
an empty `item/started`, which the host had to take as unsaved work over the
finished items it held under the same ids. An idle conversation then read
back with its replies blank and "still being saved" for good (#2044).

A load also carries no times. Where a replay is silent on a turn's start,
end, duration, plan or diff, the host keeps what it recorded when it watched
the turn run, however full the replay is otherwise. A duration the backend
did measure still wins; a turn nobody timed shows no duration rather than 0.

**Rule:** an adapter emits nothing while replaying; a read fills a turn's
silent facts from the desk's record, never from the moment of the read.

## A finished transcript item keeps what the desk observed — 2026-11-08

Every ordinary read reconciles replay with the saved transcript, as recovery
does. A final saved item survives a thinner or rewritten replay; a replay with
a different status contributes no fields. With the same status, missing values
may be filled and strings or arrays extended, but existing facts are kept.
A running item accepts the runtime's finished version.

This preserves recorded output at the cost of ignoring a runtime rewrite of a
finished item, including a completed file change's diff. A later read cannot
tell a correction from lossy reconstruction.

**Rule:** preserve final saved facts; let the runtime finish running work.

## One host table says who work waits on — 2026-11-05

Lead threads, ordinary chats and Teams carry a deterministic stage from the
closed, ordered table in `packages/protocol/src/lead-stage.ts`. First match
wins: a person's decision takes precedence over concurrent work, and each
kind ends with an idle catch-all. Phone counts and the Lead's observations
read that host stage, so each surface answers the same question. The model
never computes it: prose cannot decide who owes an action, and a new wait
reason requires an explicit classification. Legacy phone phase and line
fields remain for older phones; newer phones fall back to phase only when an
older desk omits stage.

An owned Team's stage wakes the Lead only when `isWaitingOnYou(stage)`
changes, or when the Team goes from `working` or `queued` to `idle`.
`working` ↔ `queued` and changes among the three `you-*` stages stay quiet.
The fingerprint uses the same attention and completion distinctions; a quiet
transition updates its baseline without consuming other changed evidence.

## Groups are cards by default, and a sheet is a foundation — 2026-11-01

The app-frame canvas drew every left-menu mode twice: Cards, where each group
of settings rows, each right-panel section and each object on a page is one
card on the main ground, and Sheet, where the same groups lie flat on one page
with a hairline between rows. The owner chose Cards as the default and Sheet as
the choice beside it. Cards changes the least of what was already drawn — the
same rows, one edge and one corner — and Sheet suits a person who wants fewer
boxes. Sheet is a token overlay (`tokens.sheet.css`), not a second set of
screens, so neither can drift from the other: a screen that names a surface is
wrong. The same pass took the extra 12px off the Settings column, so its labels
share the main column's edge, and moved fact ink one step further from prose
(grey-600 light, grey-500 dark) so counts and times no longer read as a second
tier of prose.

**Rule:** a screen never branches on the surface; what differs between Cards
and Sheet is a `--hd-card-*`, `--hd-panel-card-*` or sidebar token in
`tokens.sheet.css`.

## Transcript cache limits yield to recovery evidence — 2026-11-01

The renderer starts with soft targets of 128 eligible bodies and 8 MiB of
canonical UTF-8 turns. The Host separately reserves at most 8 MiB of logical
recovery descriptors. Count and bytes answer different workloads; neither is
a limit on process memory or an empirically optimal working set. Active,
mounted, drafted, partial, in-flight or uncertain content can exceed them.

A closed body leaves memory only after exact storage verification and
independent readback, with current owner, generation, revision and sequence
checks on both sides. A turns hash does not cover richer Session metadata.
The cache compares that metadata separately and preserves local mutation
fences. Missing events, conflicting replay or an older pending generation
retain their observed data until reconciliation is proved; item counts and
newer numeric cursors are not that proof. A receipt is a point-in-time fact,
not a promise against later storage failure or forced exit.

**Rule:** refuse unloading when recovery or ownership is uncertain; never
discard protected content merely to meet a cache target.

## A self-hosted runner takes work only while it is shown to be up — 2026-10-30

The organisation's hosted runners run twenty jobs at once. A full run is over
thirty, so its browser shards waited three to ten minutes for a slot while the
project's own Linux machine, paid for by the hour it is on, sat idle: no job
named it.

The first job, `CI runners`, asks whether one of that machine's runners is
online and sends the typecheck and gates jobs there if so. Those two start at
once and take minutes, so they free two hosted slots for the shards. A job
sent to a runner that is down waits in the queue for a day rather than moving,
so every doubt answers "hosted": no `RUNNER_STATUS_TOKEN` secret (forks never
get one), a pull request from another repository, any failure to ask, or less
than half an hour before the machine's scheduled stop (`SELF_HOSTED_UNTIL`).
Jobs that start later in a run, like the bookkeeping checks, stay hosted for
the same reason: the machine may have stopped by the time they are created.

The pick is made once per run. "Re-run failed jobs" keeps it, so after the
machine has stopped, re-run a failed typecheck or gates job with "Re-run all
jobs", which asks again.

**The rule:** a job reaches a self-hosted runner only through a pick made at
the start of the run that defaults to the hosted runner.

## Customize is the shared capability destination — 2026-10-21

Skills, MCP and Plugins share one Customize entrance and a common section navigation. Existing Library and Plugins destination identities remain valid for saved history, command links and capability detail pages. Settings' skill-management requests open Customize, scoped to the active runtime; Hooks retains a separate Settings page. Runtime-owned commands not covered by the scanned inventory remain browsable in Customize, under the active runtime’s name, with their enable switches and composer action. A different runtime scope never borrows the active runtime’s commands. Legacy command detail routes remain readable; the obsolete Settings list route replaces itself in navigation rather than leaving a redirect in Back history.

Skills default to two-column catalogue cards. The title and a bounded description lead; scope and a named runtime count replace the unbounded strip of runtime marks. Cards, List and Runtime comparison are choices in View. All and nonempty or selected Needs attention stay visible; uncommon reach and declaration filters live under Filter. Runtime selection and search use a dedicated view subscription, leaving the global app snapshot untouched, and all install, update, remove and restore operations retain their existing reviewed plans.

**Rule:** one skill-management destination; runtime diagnostics are a deliberate view, never a repeating wall of marks on every card. Typography and spacing come from the shared page, card and row patterns.


## A skill opens as a page, not a sheet — 2026-10-17

A skill has enough definition and evidence to read as a destination: the definition is a card on the left, while loaded runtimes, recorded source and copies, files and cost stay in cards on the right. Back returns to Customize (then the Library) and history retains the route. Findings sit above the columns, and More keeps the less frequent copy actions; writes still open reviewed plans. This keeps the skill consistent with other details and gives long definitions the page’s scroll owner rather than two constrained dialog lanes. MCP retains its existing dialog. **Rule:** a detail is a page with a way back; dialogs are for confirming.

## What the Library changed has its own page, and every write says so in a toast with no Undo — 2026-10-17

Customize (then the Library) keeps its cards for finding skills. Changes made here is a separate
view of the same destination, reached from More and from a write's View changes
toast. The audit read covers 90 days, with local-day groups, search and filters.
Restore remains a previewed plan and is offered only for completed backed-up writes.

The page and toasts share the operation verbs. Each apply summarizes completed
writes once, keeps failures until dismissed, and ignores skipped operations.
Restoring refreshes the audit read; no persisted last-seen state or Undo is added.

**Rule:** every Library write ends in one toast with a View changes button.

## Page band headings are 16/600 and field-group labels stay small — 2026-10-16

Heads naming the cards or rows in a page’s body use the existing section text
role. `SectionHead` defaults to that heading; field groups explicitly choose
`level="label"`. Titled `Section` bands choose the same heading level. Page
titles, dialog legends, Settings forms and right-rail cards keep their roles.

This costs an explicit classification at every call site. The explorer shows
both levels and rendered frame tests hold page bands to the existing role,
so a new form group cannot silently become another heading style. No size,
weight or foundation token is added.

**Rule:** a head that names a band of a page's body is a section heading; a label that names a field group stays small.

## First launch offers installed runtimes — 2026-10-16

> Superseded in part by [First run always has a text box](#first-run-always-has-a-text-box--2026-10-16):
> its decision 8 removes the history-source copy and the
> `presentation.historySource` field this entry reads. What follows is the
> record of the offer as it was first chosen.

The first empty conversation uses the Add a runtime page's machine catalogue
to offer installed agents that have not been registered. Each is one compact
name and Add button. Detection runs once per window, after the pane draws,
with an eight-second limit on the offer's wait. Nothing found means no offer.
A runtime available only through a bundled bridge is not an installed CLI.

The owner chose an offer over automatic registration in [#1673](https://github.com/HarnessDesk/HarnessDesk/issues/1673).
Add uses the existing template registration; it neither installs nor signs in
nor changes the agent's own files. The registered runtime arrives through the
host's existing event and becomes selectable in the composer. History copy
comes from every present runtime's `presentation.historySource`, deduplicated
for accounts of the same agent, and is absent when no runtime declares one.
Unregistered agents take their names from the same host catalogue as Settings;
registered runtime names come from `RuntimeInfo.presentation`.

**The rule:** offer what is installed, and let the person choose what to add.

## History arrows move to the main bar when the sidebar runs out of room — 2026-10-15

The native corner consumes 78px of the sidebar's top row. The default 256px
column fits four full 28px controls and the mode switch when the controls
give up their gaps. At smaller widths, a standing sidebar moves both arrows to
the main bar, returning them when it has room. Their rendered fold owns the
handoff, so native corner reservations and live seam drags agree.

**The rule:** a standing sidebar hands folded history arrows to the main bar.
A floating drawer keeps them in a second header row when they do not fit,
because the covered main bar is inert. Control targets keep their design-system size.

## Browser CI is bounded on a pull request and complete before landing — 2026-10-15

> Superseded by [Ordinary pull requests run core CI; integration runs in the full tier](#ordinary-pull-requests-run-core-ci-integration-runs-in-the-full-tier--2026-10-16):
> ordinary pull requests no longer run browser shards at all. What follows is
> the record of the bounded selection, which `check:push` still uses locally.

A measured UI pull request took 79 minutes end to end: sixteen browser shards
ran for 14–27 minutes and waited 5–29 minutes for runners. Browser work used
about 340 of 373 runner-minutes. A widely rendered stylesheet can reach nearly
all 224 specs at the time, so an impact map alone cannot bound that cost.

Ordinary pull requests keep edited specs and the most specific impact selections
within four shards, using the existing light geometry matrix and duration
estimates. The summary names every deferred spec. Mandatory edited specs can
exceed the time estimate, but never the four-runner cap. Other CI jobs keep
their existing checks and required names.

This trades early coverage of indirect and dark geometry regressions for a
bounded feedback cycle. A full run on a `batch/` branch or a pull request labelled
`full-ci` reads every spec in both themes before landing. Main pushes and manual
dispatches also run everything. No suite is removed; deferred coverage moves to
that full tier. The visible tier check belongs to the same workflow check suite
as the required checks, so an old full result cannot stand in for a newer
bounded run.

**Rule:** bounded green is feedback, and only full green is landing evidence.

> Narrowed by [CI is dealt from manifests and measurements, not hand-carved jobs](#ci-is-dealt-from-manifests-and-measurements-not-hand-carved-jobs--2026-10-30):
> outside main and development the full tier reads every spec in the
> pull-request theme matrix.

## Team seats nest under their Team, and running rows spin — 2026-10-18 (owner)

The owner chose seats nested under their Team again, with a spinner on working
conversations and careful alignment. This supersedes the 2026-10-15 bullet
“running rows have no spinner” and the app-frame spec's “a Team is one row”.

The chevron follows the Team name like a project header's fold chevron (owner,
2026-10-18), with no leading gutter. It folds the Seats separately from opening
the Team's label.
The selected Team and the Team owning an open Seat start expanded; other Teams
start collapsed. Deliberate folds last for the UI session, until another Seat
activation. A matching seat filter temporarily reveals its Team and matching Seats.
The chevron can fold that reveal; clearing the filter restores the Team's own
stored state, including selected-Team defaults. Seats use the Overview's names
and states, in the Team's roster order; activity never reorders the roster. Their runtime icon stands
under the Team label, one indent step in. Clicking an open Seat opens its
conversation; a Seat not yet open opens the Team Overview.

Needs you takes priority over New or Failed, then working activity. Working
Seats show their claimed card number, when present, and a spinner; idle Seats
have no trailing mark and say Idle on hover. A collapsed working Team spins;
an expanded Team leaves activity to its Seats. Loose working conversations
spin too, retaining Needs you, Failed and folder-gone marks; unread output stays
in the Inbox for loose conversations. Runtime, model, card title and state remain
in the Seat's hover title.

All rows keep the 34px pitch and one trailing rail. Disclosure never moves a
Team icon away from loose-conversation icons. Seats belong to a visible Team
and do not consume the project's five-row allowance; hiding a Team hides its
Seats. Pins do not lift Seats out of their Team.

## The sidebar keeps its rhythm quiet and its marks for attention — 2026-10-15

The owner chose five changes so a long conversation list reads calmly and a
mark means "needs you":

- Rows have a 34px pitch: a centred 32px highlight with a 2px gap.
- Group headers have about 20px of air above them, using the shared spacing
  scale rather than another row's worth of space.
- A project shows at most five rows, including Teams, with **Show more** and
  **Show less**. A selected row beyond the first five takes the fifth slot;
  an expanded project stays expanded for the UI session. Pinned loose
  conversations remain uncapped above the projects.
- The original attention/error-only trailing-mark rule is superseded by
  [the 2026-10-18 owner decision](#team-seats-nest-under-their-team-and-running-rows-spin--2026-10-18-owner),
  which adds working spinners and nested Seats. Branch, worktree and pin facts
  remain on hover and in the existing menus.
- The footer has a full-width hairline and a transparent account row, with
  no pill around the identity. Readiness and usage live in the account menu.

The extra air separates titles without making every group a large section;
the five-row fold keeps one busy project from consuming the list. Keeping
the selected row and an expanded project visible preserves the person's
place. Quiet activity and a plain footer leave attention marks with one
meaning: something needs the person.

**The rule:** keep the 34px pitch, short project lists and plain footer;
only attention or an error earns a trailing state mark.

---

## A hidden menu bar item can be restored from View — 2026-10-20

The owner found the macOS status item missing while the development desk was
launched on an isolated home with `HARNESSDESK_MENU_BAR=off`. The quiet worker
default was intentional, but the missing item provided no route to restore it.

**View › Show Menu Bar Icon** now creates or removes the item immediately and
saves the person's choice in that home's `menu-bar.json`. A saved choice wins
over launch defaults. A fresh secondary home remains quiet, so restoring one
desk does not put every worker into the menu bar. The native status menu keeps
six primary actions and puts runtime usage in one submenu, rather than growing
its root with the runtime roster.

## Diffs wrap and highlight changed words

*Owner decision, 2026-10-15; issue #1671.*

A change at the end of a long line must be visible in the narrow Changes pane
without finding an unadvertised sideways scroll. The same defaults apply at
full width: wrap long lines and highlight the changed words within paired
removed/added lines, over their existing red/green grounds. Both are personal
choices in the diff header's view-options menu, persisted with other UI
preferences through the host's app state. Hide whitespace changes starts off.
Multi-file patches keep paths, counts and line numbers and offer collapse /
expand plus a hideable file list that can group paths by folder. Unified rows
remain the patch layout; a side-by-side layout is a separate extension.

## Composer clearance observes the box it measures

The floating dock's clearance is its `offsetHeight`, including padding and
borders. Its shared observer watches the border box so spacing changes also
refresh that value. A content-box observer missed an 84px padding increase
without updating the transcript reserve. The Side by side browser contract
waits for the measured reserve, then checks both scroll position and the final
answer's visible bounds as the dock grows and shrinks.
Conditional docks use a callback ref held in state: detaching releases the old
observer and clears the root clearance variable; mounting a replacement measures
and observes its border box.

## Round is someone, square is a thing

Faces are round and filled by default: an agent, a runtime, a Team's member, a
sender in a chat and your own seat. Square stays a setting (Settings ›
Appearance › Faces) and is the shape of things — a plugin, a skill, a file, a
section. An account is neither: a hollow ring, its colour on the edge and its
agent's mark inside.

Faces were square by default, which left two problems that a picture of the
Teams board showed at once. Overlapped squares hide most of every face behind
them, so a card with four agents read as a cropped strip; overlapped circles
are the shape a stack is read in. And a square agent face in a list looked like
the square tile of a plugin or a file beside it, so the one distinction the
shapes exist to carry was the one they blurred. Round faces bring a second
collision, with the account's ring, which is why the ring lost its plate: in
the seat, your filled face and the hollow account it runs as never read as two
faces. A desk that chose square keeps it; only the default moved.

**The rule:** someone is a filled face at `--hd-face-radius`; an account is a
hollow ring; a thing is square. A new mark picks its shape by what it is, never
by the screen it is on.

## A Team start admits only the project the person selected

Starting a Team is an explicit choice of its project folder, as opening that
folder is. Older remembered projects and folders known only from conversation
history have no captured shell identity. The preview checks that the selected
folder and the first round's checkout can be admitted, including the Git parent
and writable destination of isolated attempts, without saving authority or
allocating a lane. After redeeming that exact preview, Start captures the folder
through the same `captureShellProject` path as workspace open.

A plain Team has no Flow preview to redeem. Its renderer-only `goal/start`
request accepts the selected project root, task sentence and checkout mode,
never a caller-supplied checkout path. Before creating the Team it runs the
same `admitTeamProject` check: the root must already be a remembered project
or known from conversation history; an unknown folder is refused. A missing
legacy identity can be captured, but a changed captured identity is refused
until the person opens that folder again. Generic `goal/create`, including
agent calls, does not grant this authority.

The admission belongs to the start request's project, never a folder named by
the Flow, a card, an agent or a conversation listing. An existing captured
identity is revalidated rather than silently replaced. Subsequent Seat openings
still check the stored identity and the checkout's repository relationship.
Thus a legacy record can start the Team the person chose without letting agent
output or arbitrary checkout paths grant shell authority.

If Seat opening fails, the host releases the unused lane's ports only when its
revision is known, clean and unchanged since allocation, and no Seat, turn or
server remains active. Changed or unreadable work is retained for review.

---

## Side by side freezes the project's chosen check as ordinary Flow source

The comparison template has no mandatory application-wide check. New Team
suggests the project's declared test script, using its declared package manager
or an unambiguous lockfile. Missing or ambiguous declarations leave the field
empty. The person can edit the command, and the form serializes its check role
and routes into the concrete source the existing preview token freezes.

Clearing the command removes the check round and routes the judge directly
from the attempts, preserving both predecessor revisions. This uses the same
policy editing and token contract as the other Team options; the engine needs
neither a new conditional nor a guessed command for an unrelated project.

---

## Storage cleanup is reviewed on demand and keeps every branch

Settings › Conversations › Storage measures the conversation database and its
WAL files, daily snapshots, cached preview bodies and managed checkout containers.
A bounded asynchronous filesystem walk never follows symlinks. The first read
answers with Measuring; a host notification supplies the cached result. Cleanup
and confirmed Discard refresh that measurement. A failed measurement stays
unavailable with its reason rather than becoming a zero.

Cleanup previews inactive worktrees after 30, 60 or 90 days, across conversation
states. Live, busy, open and pinned conversations are excluded, as is a shared
worktree when any owner is ineligible. Deleted conversations retain their title
and last-active time with their checkout inventory; an older inventory whose
activity is unknown is kept. Only present checkouts are bulk candidates; kept
checkouts of removed or deleted conversations have their own Discard action.
Age follows the latest observed conversation activity. Deferred metadata writes
cannot move that time backwards, and reviewing cleanup does not change it.

Clean worktrees are selected by default. A separate choice reveals the modified,
untracked and ignored inventory before including those checkouts. Confirmation
is bound to a host-held token over the non-clean inventories. The host recomputes
eligibility and inventory immediately before removal and checks ownership again
at the existing Git mutation boundary. A newly dirty tree stays; an inventory
changed since review is refused. A refusal on one checkout does not stop the rest,
and its reason stays in the result dialog. No worktree is removed in the background,
no unmanaged checkout is removed, and no branch or conversation is deleted.

**The rule:** confirm the shown inventory; recheck it and every owner before
removing a checkout through the existing conversation worktree path.

## Worktrees follow their conversations; wrapping a Team archives its members

A managed worktree is part of the conversation's lifecycle. Archive removes a
clean checkout at once; Remove waits for the body sweep and its Undo window;
Delete everywhere cleans up after the agent accepts the deletion. None of
these deletes a branch. Another active conversation sharing the checkout keeps
it, as do uncommitted files, ignored content and a refused Git removal. A
detached checkout stays too: without a branch, removing it could lose the only
reference to its commits. Ownership is checked again after the removal's Git
reads, immediately before the mutation. A cleanup refusal never undoes the
conversation action.

The index records the managed path, branch and whether the worktree is present,
removed or kept. Its separate inventory survives even a deleted index row.
Returning to a conversation recreates its checkout from the retained branch
before resuming the agent. A missing branch opens the main checkout with one
line explaining why.

Archive reads the local index, including archived Team members. A kept worktree
wears a chip whose tooltip counts changes and ignored entries. **Discard
worktree…** and the explicitly selected dirty Storage cleanup force removal: the confirmation lists the inventory, and the host
rechecks the full inventory, including files inside untracked and ignored
directories, before removing it. If it changed, the person must
review and confirm again. Discard also refuses a detached checkout; a branch
must retain its current commit before its folder can go. This reads the live
checkout, even when the inventory still records a former branch. The existing
explicit worktree removal verb keeps its own policy.

Wrapping a Team archives its idle member conversations through the same archive
path, including the agent's archive when it has one. Working members and archive
refusals stay; the saved receipt counts them. A completed native reconciliation
also reads unresolved ids omitted by the listing, three at a time. A failed
read or an answer without archive authority leaves the row unresolved for the
next pass.

## Removing a worktree reads what it holds within a deadline, and holds ignored files to names, sizes and modes

"Remove this worktree…" confirms against an inventory of everything the removal
would delete, and that inventory is read as one bounded piece. The whole
reading, git and disk together, has twenty seconds, the same as every other
read the host makes. At the deadline its git children are killed and the
reading is refused with "Couldn't list what this worktree holds in time;
nothing was removed", so a removal that could not list a checkout takes none of
it. The reading it replaces waited for as long as a mount that had stopped
answering under an ignored folder stayed silent, and left its git child behind.

The digest a confirmation is bound to holds the two kinds of content
differently. What git reports as changed, tracked or untracked, is somebody's
own work and stays held to its mode, identity, size and both times. What git
ignores — dependencies, build output, caches — is held to its path, type,
size and mode, and the folders it is read through to their mode and identity.
A dev server or a watcher writes there while a person decides; held to its times,
every write voided the confirmation and a write during the reading failed it,
so a lane with a running dev server could not be removed. A name that appears
or goes, a file that changes size or mode, or a folder swapped for another
still voids a confirmation. A rewrite that leaves the size alone does not, because what is
ignored is made again by whatever made it. A file that is gone by the time it
is read stands for nothing, so a scratch file a writer renames away does not
split two readings of the same lane.

**The rule:** bound the reading and refuse on a miss; hold a person's work to
its contents and what a tool makes again to its names, sizes and modes.

## The sidebar reads the desk's conversation index

The sidebar lists conversations started or continued in HarnessDesk, rather
than asking every agent for its history at launch. A local SQLite metadata
index answers the first page without an agent or a Git process; repository
identities fill in from a persistent cache and background checks. Later
changes update rows. The palette keeps its existing history read path; Archive
now pages this index.

An upgrade seeds the list once from the desk's transcript metadata and archive
marks, in background batches. It migrates no bodies and leaves the old files
unchanged. Native archive rows are withheld until the agent confirms their state;
background reconciliation preserves the last confirmed answer when a listing fails.
Cached repository identities answer first and are rechecked in bounded background
passes, including after later list refreshes.

Team runs are filed under their Team. Their conversations remain reachable
through that row, and do not also appear as loose sidebar conversations.

**The rule:** the first sidebar page reads local metadata; an upgrade carries
the list over, and Team membership decides where a conversation is filed.

## Opening history previews it; a new turn adopts it

A conversation created or forked here is `desk`. An unknown conversation read,
opened or resumed here is `imported`. Ordinary metadata and body writes retain
that origin; only a new `turn/started` adopts a preview, turns its cached body
into a full body and emits the sidebar upsert immediately. A Seat's turn does
this too, while its Team membership keeps it filed under the Team. Upgrade
rows remain desk conversations.

History import is a per-runtime, on-request metadata job. It starts the runtime,
pages its own history in transactions and records progress, failure or
cancellation in the same database. Native archive state comes from both archive
listings, while newer archive actions here win over an in-flight scan; other
agents use the host's archive marks. Desk rows keep their origin
and body, and removal tombstones are never revived. Imports and ordinary
metadata observations fill a missing title without replacing one already kept;
an explicit rename wins even before its metadata row arrives. Accepted agent
title events explicitly replace or clear the indexed title; a host-owned name
still refuses those events. Renaming a
preview retains its imported origin. A verified backup restore can replace
metadata with the restored version. Completed rescans are
throttled to once a minute; failures and cancellation can be retried immediately.
Import does no Git work. The History query matches titles literally and pages
by update time, runtime and id. Unfiltered pages check only displayed folders;
a project filter first resolves its candidate folders through the bounded
repository pass, so a cold mapping cannot silently exclude a matching row.
Removing an import deletes retained imported rows and their cached bodies,
keeps desk rows and tombstones, and clears its scan state. Agent files stay untouched.
Settings and the command palette open History; there is no fixed sidebar entry.
The runtime's settings page owns import, progress, rescan and removal. A row
opens as a preview, and only the host's adoption event adds it to the sidebar.

Preview bodies are `cached`, with payload bytes counted on write and recency
recorded on open. The host's default cap is 500 MiB, configurable through
`HostOptions.cachedBodyCapBytes`. At launch and after settled writes, eviction
drops the oldest cached bodies, including items, turns, search, usage and Insight
context in one transaction. Full bodies and live conversations are retained.
The clear-cache host operation uses the same policy, retaining live previews.
Backups carry a preview's imported origin and opening time; restoring one keeps
it outside the sidebar and subject to the cache cap. Older backups without an
origin retain their desk semantics, and a restore never changes a local origin.

**The rule:** opening reads history without adopting it; a new turn adopts it.
Import and eviction alter only the host's own database.

## The host's conversations live in SQLite

The host keeps its conversation bodies in `sessions.sqlite`, beside their
index rows. Versioned turn metadata, complete item payloads, usage and Insight
context survive a cold recovery. Changed items update their existing occurrences;
an unchanged turn writes nothing. Conversation facts occupy a small `bodies`
table so deleting a body leaves the sidebar index to its own owner.

Old transcript files are kept, not migrated (owner, 2026-10-08). The index's one-time metadata seed reads them. An on-demand host fallback also reads a kept
file when the agent cannot answer and SQLite has no body; it never changes or
migrates that file. The transcript store never reads,
writes or removes them. Backups retain their existing transcript-entry format;
a daily database snapshot runs on a worker and keeps the newest three copies.

Search covers typed messages and answers by default, and tool output only
when asked (owner, 2026-10-08). Tool output is capped at 3,000 characters in
the index, with its complete payload retained for recovery. Reasoning and
client context are excluded. The palette remembers its viewer's choice and
renders every matching line as text.

**The rule:** bodies, rollback and search update in one transaction; a stored
conversation's only copy is kept in both the backup and the daily snapshot.

---

## Remove forgets the desk's copy; Delete everywhere goes to the Trash

Remove from HarnessDesk takes a row out of the sidebar, sets its origin back
to imported, and leaves the agent's files untouched. It stops an open handle
through the same path as closing a pane. Undo restores the index facts and
body during the eight-second toast window. Queued messages and held picks stay
outside active lookups and client sync until Undo restores them, and are
forgotten when the window ends. Archive retains its body and search.

The body sweep runs on a timer after Remove and at launch. It drops items,
turns, FTS entries, usage and Insight context in one transaction after the
Undo window, keeping the removed index row. A launch schedules any remaining
window too. Pending writes and late events cannot bring that copy back.
An explicit read or resume that succeeds admits the removed row again before
new work is accepted; a failed open leaves it removed. A direct resume during
Undo reads the held picks without admitting the record, reapplies them through
the shared reopen, then restores the queue and attaches the handle.

Native deletion declares its destination before a click: `deleteHistory` is
false, `trash` or `erase`. Both the host and the window admit Delete everywhere
only for `trash`. The agent answers first; then one transaction drops the desk's
index row and body. Agents that erase their own record keep the item greyed,
with that consequence on its tooltip. An explicit readable-history declaration
and a retained-copy flag identify when the desk holds the only readable body.

**The rule:** Remove touches only the desk's records; Delete everywhere promises
Trash before it is offered, and body cleanup is atomic after Undo expires.

---

## The agent’s record is the authority on reopen

An adapter that can name a conversation’s source declares that capability and
returns its path, modification time and size. The host saves those facts with
the body in the same SQLite transaction. An unchanged file serves the stored
body without reading the agent. A changed file is read through the agent and
reconciled by `TranscriptStore.enrich` before it is saved: lossy replay keeps
commands, reasoning, notices, publications and recorded context authorship.
Empty and partial replay retain the history they did not answer for; rollback
removes omitted work, search rows and Insight context together.

A missing source, or an agent that cannot serve the conversation, leaves the
desk’s copy readable. One quiet line names it as HarnessDesk’s copy and names
the agent through its presentation. A filesystem read error does not prove
that a source is gone. Runtimes without the source capability retain their
existing read and reconciliation path. Nothing writes to or deletes the
agent’s record, and old desk transcript files remain untouched.

**The rule:** the agent’s file is the authority while it exists; the desk’s
body is the fallback, and a failed refresh never updates its source fingerprint.
Only a successful reconciliation saves a fingerprint captured before replay.
Ordinary event writes invalidate it: a newer file may contain CLI work the
held conversation never saw. A source capability learned during the first
replay leaves that body unstamped until the next read can capture it safely.

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
kept in step with it. Windows has no launcher yet, and no door either: the
host does not open the client door on Windows at all (`openClientDoor` in
`packages/server/src/client-door.ts`), so a launcher there waits on a door of
its own first, and its installer is a change of its own.

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
matching session ids across runtimes establish ownership.

Completed Flow obligations stay Ready without inventing a missing check.
A current failed check, failed CI or closed pull request still needs attention;
a completed obligation does not erase a failure. Downstream check facts
qualify the attempt only through its recorded dependency, exact diff revision
and checkout identity. Board placement and host attention use this same
contract rather than omitting completed cards on the host alone.

Completed cards
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
its Goal's dependencies or follow-up cards. One pure board function puts every
Team in Needs you, Working or Ready to wrap. Stopped work needs the person;
stopping and wrapping remain Working. Ready work is always visible, regardless
of an earlier Hide preference. Wrapped receipts fold below Ready to wrap.
Read marks still bind to the observed Team change in machine preferences;
usage refreshes do not count as a new revision. This implements the owner's
approved D3 board in [#1657](https://github.com/HarnessDesk/HarnessDesk/issues/1657).

The board shows no usage totals, so it requests no usage reports on opening,
filtering or refresh. A Run and its review are read for every Team that is not
wrapped, because either can move a Team
into Needs you. A wrapped Team's Run is read once its group is unfolded, for its
faces, and its review never: nothing on a wrapped card follows one, so its read
mark leaves the review out too. Successful reads are kept while the page is
open; a failed Run or review
read gets at most two retries, five seconds apart, and an in-flight read is
never duplicated. Asking again for every
Run still missing whenever one landed sent a large desk's Settled tab
thousands of reads. Card age is said in its largest unit (`47m`, `5h`, `2d`),
and only those age labels follow a minute clock. A desk with about 500
Teams had made one full ledger scan per Team on every open, and a one-second
clock re-rendered the whole table
([#1567](https://github.com/HarnessDesk/HarnessDesk/issues/1567)).

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
command. Only a check explicitly marked `onRequest: true` is offered; omission
or `false` leaves it off. Landing, publishing and deployment checks leave it
off and wait for the Flow's rules. It gets three runs a turn and ten a card,
one at a time, and none while the run is paused or not live.

The command receives `HARNESSDESK_FLOW_ADVISORY=1` for that request
and `0` for a Flow check card or its retry, so it can refuse an advisory run
before acting. The host derives the flag from the same card metadata that
marks the evidence; an inherited value cannot select the mode.

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
default ssh, no signing, and no signature check when a history read prints a
commit (`log.showSignature` would start the repository's `gpg.program` for each
signed commit a `log` or `show` lists). Working-file reads use a private Git
directory with an immutable configuration snapshot. Included and global settings are
flattened into that snapshot; include paths and the repository's filter
definitions are omitted. Global and system includes are evaluated from the
repository's folder, so a conditional include for that repository applies;
an `onbranch` include selects using the repository's HEAD. Only those two scopes
contribute filter definitions, with other Git environment
configuration removed. The filters the person's own configuration defines are
the one thing added: they are read apart from repository configuration by the
`--system` and `--global` scopes alone (the system file only where `GIT_CONFIG_NOSYSTEM` would let git read it), and a file that is not
there is no definition. A repository that keeps its files behind Git LFS then
reads clean in status and can have a lane cut from it, because the program that
converts them is the person's own. A repository can neither add a driver to
that set nor change one in it, so a filter only the repository defines is never
run. A status read leaves `required` off for those filters, so a program that
has gone missing shows as a change instead of failing the read. The consuming
process cannot acquire another driver from live configuration.
Status disables Git's implicit submodule content reads and reads initialized
children through the same isolated runner, retaining their content, untracked,
and commit-change reporting. Parent diffs use short gitlink summaries rather
than starting child diff commands, and pass `--no-ext-diff --no-textconv`.
Automatic checkouts inspect the target tree's attributes in a private index
and refuse files whose filter the person has not defined, instead of writing
them without conversion; the filters they have defined convert the files with
their own program. Removing a lane still runs git with every filter off, so no
filter program is needed to remove one.
They register an empty checkout and check its attributes again before writing
files, because conditional configuration can differ in a linked worktree.
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

**Today's numbers.** The figures above are the ones the entry was written
against. The line has since moved off the desktop window's minimum (still
720px, `minWidth` in `packages/desktop/electron/main.mjs`) to a fixed 1000px
(`FRAME.fold.sidebarFloats` in `packages/ui/src/design/frame.ts`), and the
sidebar is 256px wide by default, so the desktop app floats its sidebar below
1000px even at its ordinary zoom. The first bullet's reasoning no longer
holds; the other two, and the rule, do.

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

**Today's numbers.** The arithmetic above is the measurement this entry was
written against. `packages/ui/src/design/frame.ts` now holds the figures: the
sidebar is 256px, the right panel 400px (320–640), and the reading column's
floor is 480px (`FRAME.main.min`, still exported as `MIN_READING`). Both lines
are one fixed width, 1000px (`FRAME.fold.sidebarFloats` and
`FRAME.fold.panelFloats`), rather than a sum of the drawn widths: below it the
sidebar floats and a drawn panel covers the conversation; above it the panel
is clamped so the conversation keeps 480px, yielding only as far as the
panel's 320px minimum needs. The 1px seam is still counted. The order of the
rule holds: the panel narrows before the work does.

**The rule:** navigation gives way before the thing being consulted, and the
thing being consulted before the work; the work never stands beside anything
narrower than its reading floor (now 480px).

## Capabilities are negotiated, not normalised

`RuntimeCapabilities` is a flat set of declarations an adapter makes about
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

## "Not installed" is said of a machine with no copy, and of nothing else

Finding Codex means asking each copy for its version. A copy that was there and
did not answer used to count as no copy at all, so a machine that was busy, a
launcher that could not find its `node`, a spawn refused under load — states
that pass — read as "Codex is not installed", with an install hint for a program
the person had installed. And nothing looked again: the runtime stayed failed
until the app restarted.

So the two are told apart, and the second is told apart again. No copy anywhere
is `notInstalled`. A copy that is there and would not answer is `unreadable`
when a later ask could differ — it timed out, was ended by a signal, exited
non-zero (a launcher whose `node` is in a folder the PATH it was run with does
not name exits 127), the machine refused the spawn for want of a resource,
or it exited successfully with empty output. Elapsed probe time is checked
even on a successful exit, since a delayed callback can arrive after its
deadline without a timeout error. It is `spawnFailed` when it could not:
it answered with text that is not a version, it is not
executable, it is not Codex. Either names the copy and what it did.

**Discovery asks once, and the desk never waits on a second ask.** The window
opens after the runtimes are started, so a retry inside the start is a blank
screen for as long as it lasts, on every launch, for a machine that is genuinely
broken. Asking again is the host's, in the background: when the PATH the login
shell builds lands and changes anything, the runtimes that read `notInstalled`
or `unreadable` are asked once more (`Host.retryProgramLookup`, the look
`installs/shell-path.ts` always said would happen); and an `unreadable` runtime
is asked again on a short schedule from the moment the desk starts
(`retryDelaysMs`), which a quit ends. Each runtime is judged after its own start
only, up to the deadline every start has, because one agent that never answers
`initialize` must not turn the look off for the others. A missing program is not
on the schedule: what it waits for is a PATH.

*Open:* the install lookup that picks which copy of an ACP agent runs
(`installs/locate.ts`) has the same shape — an unreadable copy is never chosen,
so the agent reads "not installed" — and has only the second half of this, the
re-ask on a PATH change.

**The rule:** "not installed" is said of a machine with no copy of the program.
A copy that exists is never called missing, and the window never waits on the
asking again.

## Independent development sessions own their checkout and browser — 2026-10-19

The owner's independent bug-fix conversations shared the open folder and its
branch, so all three published to the same PR. A project draft now defaults to
a new managed worktree on its own branch, allocated only on first send. It starts
from the known remote default, then local main or master, with HEAD as the local
repository fallback. An explicit Local or existing-worktree choice still uses
that checkout. Opening a linked worktree or repository subfolder is itself a
place choice, so ordinary drafts keep that code and subfolder scope instead of
cutting from the default branch. A failed runtime start keeps its allocated checkout for retry.
Existing conversations are never relocated automatically: already mixed changes
cannot be safely attributed by moving folders.

PR updates must match the calling checkout's branch. Browser isolation follows
the runtime/session identity even when the person explicitly shares a checkout;
tabs, cookies and storage belong to that conversation. Team sidebar actions use
the same eligibility rules and dialogs as the Team header.

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

*Not done here originally:* native-command steering and host-owned write
execution. The reach described above was the plugin's shell; that part is
superseded by [Every git write goes through one gateway, and the host holds
the credential](#every-git-write-goes-through-one-gateway-and-the-host-holds-the-credential).
Seat signatures and transcript publications remain the plugin's presentation
contract.

## Agent publications name the writer and the role

A signed review beside an unsigned fixer's reply made the reply read as the
person's own words. Descriptions had the opposite problem: re-signing an edit
with only the last seat erased the writer. Both lost who did which work.

The Git plugin now signs agent descriptions, reviews and comments as one
capability, with three editable templates and a blank value disabling each
kind. Roles come from the stored Seat, Team names from its board and review
rounds from the run. No Team means no invented role. Writer, Reviewer and
Fixer are capitalised. Other role ids use ASCII letters, digits and hyphens; other
characters become `-`. They are bounded to 32 characters, with `role` used when
nothing usable remains.

A description keeps the latest seat for each role and agent pair, up to eight
pairs, in its hidden signature marker. Adding a ninth drops the earliest-added pair,
even if it was updated later.
Its visible line is rendered under the current template, so a person's edits
to that line or a new template cannot erase the earlier credits. Legacy
signatures are upgraded when edited. A review or comment keeps the role and
seat that made that publication.

Card commits keep the desk co-author, which gives GitHub its desk icon, and
add the native commit credit supplied by the running adapter through its
presentation. Credits come from local observations or cited sources; an unknown address is null,
never guessed by the host. On this Mac, Claude Code 2.1.285 contained
`Co-Authored-By: ${Jqn(e)} <noreply@anthropic.com>`, and codex-cli 0.160.0
contained `Co-authored-by: Codex <noreply@openai.com>`. Cursor Agent
2026.10.01-e373342 is cited, not observed: its installed bundle and executable
did not contain a matching credit string. The Codex attribution is also cited
in the [upstream commit implementation](https://github.com/openai/codex/pull/11617);
the agent addresses are listed in [AgentPack's measurements of native commit identities](https://arxiv.org/html/2509.21891v1#S3).
The person's own configured identity remains the author. A person's own text
carries no signature: its absence means a person, rather than an agent whose
role the reader must guess.

**The rule:** the desk signs agent text at publication, and preserves the latest
seat for each role and agent pair, up to eight pairs, across description edits.

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

## Provenance journals recover within a bounded storage budget

Provenance replay and appends have a 64 MiB journal budget. Line-bounded
streaming still retained every decoded historical observation: a multi-gigabyte
journal could exhaust the desktop heap during checksum or serialization.
Before decoding an oversized journal, a bounded streaming pass validates its
records and removes only superseded checkpoint cursors into a temporary file.
Replacement happens only after complete validation and only if the retained
history fits the budget. Historical observations are never pruned. Append-time
compaction makes room only when the incoming record or complete checkpoint
would exceed the budget and obsolete cursors can free enough space. The complete
checkpoint is sized before any part is written, so compaction never renumbers
part IDs in flight. Near-limit appends that still fit do no forced compaction.
External file growth is not overwritten by compaction of an older in-memory view.
A changed file has a separate refusal and reload guidance; it is never described
as a size limit or exported as a size-refused project. Damage and filesystem
failures keep their storage failure semantics. Parsing and replacement each use
one shared path, including the source identity check immediately before rename.

If retained observations still exceed the budget, capture stops for that project
and its original history stays in place. Capture can be turned off; Retry tries
recovery again. Backup reports size-refused projects in `omittedProjects` while
including healthy projects; restore counts refused entries without spending
the admission budget available to the remaining projects. A limit or changed-file
refusal during an append skips the rest of that project immediately, avoiding
repeated compaction attempts while other projects wait. Export tracks exact
serialized bytes incrementally, including omission metadata and JSON framing. This is a per-journal input bound, not an aggregate heap
guarantee or a history retention policy.

## Passive provenance starts at the project and Seat window

Capture walks back to the earlier of the project's first capture opening and
its earliest local Seat opening, minus one day for clock skew. The opening and
floor survive in the checkpoint. Older desks recover the opening from their
oldest local commit observation; restored records never widen the local window.
Reaching the floor finishes ancestry work, including a History request for an
older commit: it remains unobserved rather than pending forever. Terminal range
limits describe bounds already reached, not work still pending. Existing
observations, decisions and backup history are retained.

This is a bound on passive discovery, not an ownership test. `model.seed` binds
a diff's observation time to the Seat's lifetime, and `model.reconcile` compares
exact fingerprints; neither treats a Git author or commit clock as evidence.
Commit clocks can be backdated. An admitted local diff fact therefore still
supplies its source fingerprint even when its endpoints predate the passive
window, preserving its explanation of a later rewrite. Missing commit clocks
are handled conservatively rather than used to discard an observation.

Reconciliation indexes patches and range dependencies, and capture work yields
every 100 items or 20 ms. A journal retains every historical observation and
only the latest complete checkpoint. Streaming an older journal discards
superseded checkpoint bytes from memory, then writes the retained records to a
synced temporary file and atomically replaces the original. A failed replacement
leaves the original readable; checkpoint writes and replacements share a queue
so a manifest never points at parts renumbered while it was being written.

An earlier local Seat widens the saved window and restarts discovery from the
unchanged tips. Capture reads the frontier's commit clocks in bounded batches
before spending its observation budget, discarding every entry below the floor
in the same scan. Frontier-only discards write no checkpoint: replaying that
disposable work after a restart is safe and avoids rewriting a large journal's
range index while no new observation is made. Completed range keys remain in
the checkpoint because reconciliation uses them to avoid repeating Git work;
the journal and backup formats keep their existing contracts.

An in-window scan walks up to 200 commits or five seconds of elapsed Git and
storage work, yielding every 100 items or 20 ms within that batch. It writes one
checkpoint after the batch and immediately continues unfinished work. The scan's
elapsed budget includes asynchronous I/O, so it is separate from the synchronous
slice budget that keeps the host responsive. Walking an already journalled
commit or peeling a tag does not move the capture clock. Frontier-only replay
writes no checkpoint: the saved frontier and durable parent edges can repeat
that work after a restart without losing an observation.

A peeled tag target follows the same walk bookkeeping as a branch tip: its
observation alone does not mean its ancestry was visited under the current
floor. Widening the window therefore revisits tag-only ancestry too, including
when a legacy checkpoint first acquires a floor.

A failed object-clock batch falls back to individual reads. An already
journalled commit whose object cannot be read still supplies its durable parent
edges; an unavailable clock never proves that it is outside the window. Object
failures remain visible as a history gap. Admission and storage failures still
refuse progress, and an unreadable commit without durable edges ends the scan
with that gap rather than starting a retry loop.

## A Goal is finite; Seats and receipts are the authority

Rooms accumulated three competing truths: a member array, the conversations
the host happened to hold, and Seat evidence. Goals keep the useful surface —
board, channel and roster — but make the durable records authoritative. An open,
non-restored Seat establishes membership. Assignment and Release are serialized
host transactions; the renderer refreshes the resulting Goal instead of
splicing a member into local state.

Isolated Goal work receives a durable lane: retained checkout and disjoint port
block. Each conversation has its own browser partition, whose persistence follows
the browser setting. The host injects
the lane environment into each agent invocation that can take it per session.
A lane depends on its checkout, never on a variable in the agent's process: the
cwd is the confinement; browser identity follows the conversation, while the
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

Agent-folder copy, export, Save and restore have a narrower content-open
boundary in `agent-file-open.ts`: macOS uses `O_NOFOLLOW_ANY`; Linux holds a
directory descriptor and opens each next name through `/proc/self/fd` with
`O_NOFOLLOW`. A linked ancestor is refused before it is opened, and replacing
an already-open directory's name cannot redirect a later content read or
write. Every directory descriptor is closed before the content handle is
returned or an error escapes. Linux without procfs, and other platforms,
refuse these opens rather than falling back to path-only checks. Directory
creation, publication and cleanup still use paths and identity checks; this
does not turn the whole operation into a descriptor-relative transaction.

## Local workspace content uses no-follow opens on macOS and Linux

The host's `LocalFiles` reader and writer use the same content-open traversal
as Agent sources: macOS refuses links in any component, and Linux opens each
component through a held directory descriptor. Local workspace reads, saves
and editor writes deliberately require macOS or Linux until another platform
has an equivalent traversal. A canonical-root check still precedes each open.
Runtime-provided file services keep their own platform support behind that
same canonical-root check.

Linux's directory opens use `O_RDONLY | O_DIRECTORY`, so every ancestor must
be readable as well as searchable. A search-only ancestor is deliberately
refused even when an ordinary path open could reach the file. The workspace
refusal names this requirement; a platform refusal names workspace reads and
saves and the supported systems.

The host's per-file turn fallback has the same platform limit for creating
and removing files, including rollback. Its refusal names workspace file
changes. Aggregated patches and individual update hunks still go through Git.

## Local workspace reads and saves require one filesystem link

Local workspace reads, previews and saves require a regular file with exactly
one filesystem link, checked on the opened descriptor. A second name can make
a file outside the admitted roots look like one inside them, even when its
canonical path passes the root check. Reads and previews refuse it with a
message explaining that the file has more than one name on disk.

A save checks the opened descriptor before truncating it, and its refusal says
why: changing the contents would change every name sharing them, including any
outside the admitted roots. A separate copy with one filesystem link can be
opened and edited here. Symbolic paths whose canonical target stays inside an
admitted root keep their existing behavior.

## Path confinement walks a link's target the way the kernel does

A path is admitted when its spelling and its canonical target are both inside
an admitted root. The canonical target of a name that is not there yet is its
deepest existing ancestor with the missing names appended, and a link that
leads nowhere yet still names a destination: that destination is part of the
answer. It is found by walking the link's target one name at a time, from the
link's real parent (from the root of the filesystem for an absolute target).
A `..` takes the parent of the real folder reached so far, a name that exists
becomes its real path, and a link met on the way is followed in turn.

Reading the target as text is wrong exactly when a `..` follows a link:
`sub/../x` is a sibling of `sub` as text, but for the kernel it is a file
beside the folder `sub` leads to, which can be outside the project that holds
both links and is where a runtime's own writer creates the file. A `..` after
a name that does not exist has no folder to go up from, so the walk refuses it
rather than guessing.

## Confinement asks the disk off the host's thread, under a deadline

Every file request is confined: the renderer reads, stats, saves and lists by
path, and polls `workspace/stat` every few seconds for each open editor tab.
Confinement looks at the disk — where the path really leads, and which of the
roster's folders are linked into this machine's Agents root — and it did so
with synchronous calls on the host's own thread. A single link onto a volume
that had stopped answering then stopped every wire method and every session's
stream behind it, for as long as the volume stayed silent.

So the walk uses `fs/promises`, where a silent volume holds workers of the
thread pool and not the host's own thread. The spelling is judged first and
costs nothing: a path outside every root's spelling is refused without the disk
being asked. Only then are the target and the roots that spell it resolved,
together, and only for `CONFINE_DEADLINE_MS`. When that is up the request is
refused with the volume named as the reason — a late answer never admits a
path — and the walk is told to stop: a call already asked cannot be taken back,
but no next one is started.

That call keeps its worker until the volume answers, and the pool is four
threads for every file, folder and lookup on any volume. An editor polling a
silent volume every few seconds would leave another call behind each time, and
four of them leave nothing for the rest of the host. So a root whose request
gave up is held: a request that names it is refused at once with the same
answer (`unreadable`, for `workspace/readFile`), and the disk is not asked,
until every call left behind has come back, answered or failed. It is held by
the most specific named root containing the target, so a stall below a nested
root refuses its paths while paths elsewhere in the outer root remain usable. And a volume cannot be told from a slow one
before the deadline, so the requests that arrived within a deadline of the first
were asked all the same.

The roster's own folders (`AgentFileRoots`) are the other disk read a file
request made. They are listed off the thread, kept for a few seconds, shared by
requests that arrive together, and dropped the moment the host says
`agent/changed` for this machine's roots. A request waits for a listing no
longer than two seconds in all, and a listing already late is not waited for
again; it is answered with the last listing, or with the root alone. A folder
not yet seen is not admitted, which is the safe way for a slow disk to be
wrong. What it costs: an Agent folder linked in by hand is readable by path
once the roster watch has noticed (a moment), or when the listing is five
seconds old, where it used to be at once.

## A path the disk will not resolve is a file's state, not a refusal

Looking at the disk can fail without deciding anything: a link that loops, a
folder nobody may search, a volume that did not answer in time. None of those
is "outside every open workspace", and none should read as it. They are raised
as `PathUnresolvableError`, which keeps the errno the disk gave and its reason.

`workspace/readFile` answers a file in its own terms — gone, or there but not
readable — and did so before confinement looked at the disk, so it answers this
error the same way: `missing` for a name the kernel would call absent (a `..`
below a name that is not there), `unreadable` with the reason for the rest.
Every other method passes the error on as the plain error it is. A path that is
simply outside every workspace stays a refusal, and a name that is merely not
there yet is still admitted.

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

## A PR review binds the destination as well as the head

A reviewer receives the exact PR head and current destination ref and tip.
An automatic merge needs that same host-observed tuple in its review evidence;
older unbound reviews remain readable but cannot authorize it. The serialized
gateway checks the tuple again before submission, while retaining the existing
head and CI checks. GitHub does not offer this path an atomic base-tip lease,
so a destination can still move after the last read. A queued or uncertain
merge is kept unresolved rather than silently submitted again. An open,
unqueued snapshot cannot prove that an earlier request will not still complete;
without a merged observation, a person may need to inspect or complete it
outside the app.
The current CLI process boundary cannot reliably distinguish a definite server
rejection from a lost response. Even a CLI-reported rejection can therefore
remain unresolved and require that outside inspection or completion.
The host serializes its own gateway's attempts; another host or external client
can race it, so neither the journal nor a read-back is an exactly-once lease.
A later direct person turn may request manual approval after its prior Flow Seat
has closed. Its live turn and owner must still match at submission; a fresh Host
has no invocation lease surviving from the previous process and must observe a
new direct person turn rather than infer one from a default cause.

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

## An ACP read ceiling needs a native guard as well as host permission refusal

ACP delegates file access and execution to the agent. A tool notification
arrives after the work, so refusing a notification cannot hold read. The
adapter reports `ceilings.read` only when the bridge's initialization handshake
declares its native read guard. The bundled bridge installs its pre-tool guard
before opening a read session, persists the ceiling across loads and resumes,
blocks file mutation tools and unknown MCP tools, and admits shell commands
only from its narrow read-only allowlist. Its permission mode cannot bypass
that guard; plan mode alone is not a held ceiling.

The host restores a Seat's recorded ceiling on resume, including after a
restart, when its conversation is already open and while a read is still
loading it. An idle handle opened without a native read guard is reloaded
with the ceiling; a running turn refuses that resume until it finishes.
A peer holding read natively has already checked each call with its
pre-tool guard; its permission requests retain their ordinary approval path.
For asked ACP read seats, the host refuses write-kind, execution, mode-change
and unknown-kind permission requests before they reach a person or an
automatic approval policy. Read, search and think requests retain their
ordinary approval path; fetch requests are refused because read does not
grant network access. Trusted provenance from shipped bridges uses the shared
desk-tool ceiling table rather than the generic ACP tool kind. A
question-shaped request follows the same kind rule: edit, delete, move,
execute and switch-mode kinds are refused even when they carry a question.
Each host refusal adds a transcript notice naming the tool and the Read only
ceiling, and selects an offered reject option, preferring reject-once.
Only a request with no reject option is answered as cancelled.

Host refusal alone does not constrain an agent's native tools, and does not
earn a ceiling for a peer without the native guard. This is tool enforcement,
not an operating-system sandbox for the peer process. Other ACP peers remain
ineligible for held read roles until their own enforcement exists. When none
can be offered, the dry run names the missing ceiling for that role. Provider
independence is still checked from the providers read for the actual Seats,
never inferred from a runtime's name.

**The rule:** an ACP capability reports enforcement the bridge holds, not a
mode label or the host's ability to decline a permission request.

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

For a list of more than one Agent or seat, its length sets the width and an
existing `count` follows that length. A single Agent keeps its explicit
`count`. Shrinking a list to one keeps the old width until `setCount` changes
or clears it.

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

## A resumed card retains its own work, and its Seat can undo its own block

A restart or a released claim does not make a writer's unfinished work somebody
else's pre-existing dirt. Replacing its dirty-path snapshot at the next claim
hid that work from both the commit tool and the finish check (#1403). A card
now keeps the earlier claim's snapshot when it is released, and reuses it only
for the same conversation in the same checkout, within 24 hours of its
release. That gives a restarted writer a day to recover without keeping
an idle checkout’s ownership indefinitely. Another card claiming that
checkout discards the retained ownership, even on another board; a simultaneous
claim there also prevents retaining it. Busy boards cannot be changed, so
the host persists a discard record before the new claim and checks it on
resume, including after a restart. Read-only history stays untouched, and
an invalidation never changes another board’s activity. Unknown snapshots
remain unknown. Done and abandoned cards end retained ownership even when
they were already released; a writable board read retires expired snapshots.
The snapshot and checkout identity stay inside the host, and a hand-back and
commit say plainly that the preserved work predates the new claim; the commit
answer names up to 20 committed paths and counts the rest.

A deliberate agent block records its conversation. That conversation can
claim the card again, subject to the same dependency, role and file checks.
This is the existing board's recovery route, so no new person-answer surface
is needed. A person's block stays held, and a Run stalls with that reason
once its Seat ends its turn. A Flow hands a Seat its own blocked
card back with a claim before sending its order, and that hand-back does not
spend the stall budget for unfinished turns. Self-block hand-backs have
their own allowance of three per Seat per rolling hour, retained in the run’s
operation journal across restarts. Past it the run stalls, naming the card
and its reason, while the card stays blocked. Ordinary unfinished turns keep
their existing limit. A board that refuses a hand-back's claim stalls the Run
with its refusal instead of rejecting the host's turn-end callback.

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
specific is asked for. `/race` now opens the same New Team Side by side form
with the task prefilled (issue #1626). That form writes two explicit signed-in agent choices
when available and retains the ordinary source, policy-editing and preview-token
contract; there is no separate race dialog or seating path.

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
on the Overview strip, Run header and Findings summary. A need card above
Timeline and Flow keeps the reason for attention and the existing next actions;
the selectable End step does not repeat them or the aggregate chip. A review
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
work, keeps its handle. That first change still left a continuously working
shared runtime retaining finished threads' children until a quiet opportunity
arrived. It chose the measured release boundary without interrupting work or
changing any configured server.

## Finished conversations recycle their own processes

> Reversed by [One Codex process per account](#one-codex-process-per-account-shared-by-every-seat):
> its measurement stopped listening after one second, and a minute later the
> release it asked a process per conversation for happens in a shared process.
> What follows is the record of why each conversation once had its own.

Part 1 of #1418 builds on #1404's measurement above. The generated protocol
has `thread/unsubscribe`, but no immediate per-thread unload. Its response
reports subscription status, not helper shutdown. The existing scripted fake
retains a thread's MCP child after unsubscribe, matching that measurement.
[`script/probe/mcp-release.mjs`](../script/probe/mcp-release.mjs) remains the
manual probe for a person; this change does not run another real-process probe.

Recycling a shared process only after all its working Seats drain cannot free
a finished Seat's helpers while one Seat works continuously. Each top-level
conversation now starts or resumes in a fresh app-server process. This bounds
conversation processes by live conversations, plus one control process, rather
than every Seat started since launch. It costs an app-server per live root;
this is a lifecycle choice, not a measurement of memory saved. Forks also
receive a fresh process, reading their source from the same agent-owned history.
Delegated threads follow their root and drain with it.

The adapter's `CodexThreadServers` routes thread verbs to their owner and
forwards notifications and tool calls through the existing adapter. Request
ids are namespaced by process before the shared approval router sees them.
Releasing the last root waits for unsubscribe, then exits its owner even when
unsubscribe refuses. A resume arriving during close waits for that owner's
release, then loads in a fresh process. Another conversation's turn and handles
never participate in that stop. Filesystem watches, standalone terminals,
accounts and catalogue reads belong to the control process, which keeps
#1404's idle-stop behavior.
Every process uses the same agent-owned history and configuration; nothing
rewrites that configuration or shadows real history.

MCP reload, plugin install and removal, and skill configuration writes
are sent to the control process and every open conversation process. Shared
configuration files do not establish that an already running process reloads
its tools; the adapter explicitly asks each process to apply these verbs and
returns the control process's response after all have answered. Recipients are
chosen after the control request finishes, including conversations still opening
at that point. Each recipient waits for its opening requests to settle before
being updated; a failed opening or a process closing in that interval is skipped.
The fixture regressions hold new, resumed and forked conversations open across
the control response and check that tool updates follow their root registration.
Another opens two conversations and checks that all three processes receive
the reload and settings requests;
this is not a claim about unmeasured cross-process propagation in the real agent.
MCP login opens one interactive authorization flow on the control process only.
The agent owns its stored credentials; Reload in Extensions sends the existing
reload verb to unfiltered conversation processes (the shared-process rule below
now holds reloads while any filtered conversation remains open). Whether a running real agent process
re-reads a newly stored credential on reload remains unmeasured.

A conversation process that fails reports `session/detached` for its own roots,
clears their live handles and holds their queued messages. It leaves the other
roots and runtime health alone. Delegated registrations and approvals are
forgotten with their root, so a replacement process must announce each child
afresh. The host's existing resume barrier reopens the same stored conversation and reapplies frozen attachments; membership and the
host transcript survive. Full runtime shutdown also stops in-flight starts,
so an opening that loses that race cannot leave a new owner behind.

The regression starts and closes three conversations while another turn stays
active throughout, checks the closed helpers exit, and then interrupts the
working turn deliberately. The production-host fake rig also checks the Seat
rest boundary with another Seat still working, plus reopen and idle reads.
The remaining parts of #1418 are implemented by native server narrowing and
passive process observations below.

## One Codex process per account, shared by every seat

This reverses the process model of [Finished conversations recycle their own
processes](#finished-conversations-recycle-their-own-processes). What that entry
measured still holds; what it concluded from it does not.

**Why a seat had a process of its own.** `thread/unsubscribe` answered
`unsubscribed` and one second later the thread's tool child was still alive, so
the only way to free a finished seat's helpers while other seats worked looked
like ending the process that held them. Each root conversation therefore got an
app-server of its own: on a desk with three Teams and two accounts that was five
processes, each busy one with its own launcher and helpers, and one more for
every seat started.

**What the longer measurement showed.** The probe ended after one second. Run
for a minute on codex-cli 0.160.0 (an isolated `CODEX_HOME`, a loopback provider
that answers a real turn, no account, and a synthetic tool server that starts a
child of its own), one app-server holding three threads did this:

- A thread unsubscribed while idle was closed by Codex sixty seconds later:
  `thread/status/changed` to `notLoaded`, then `thread/closed`. Its tool server
  and the child that server had started both exited. The other threads' helpers
  stayed.
- A thread unsubscribed while its turn ran stayed loaded and the turn finished.
  Another seat's turn finished normally while the first was released.
- A resume inside the minute (at 5 s, and again at 57 s) answered with the same
  loaded thread, started no second set of helpers, and the thread was still
  loaded after the minute. A resume after `thread/closed` loaded it again with
  fresh helpers.
- A seat whose agent spawned a sub-agent (the loopback provider answered the
  turn with a `spawn_agent` call) had two loaded threads, and two sets of
  helpers. Codex subscribes the parent's client to the sub-agent without
  announcing it, so it is never unsubscribed and idle: the roots closed at
  sixty seconds and their sub-agents were still loaded, with their helpers, when
  the probe stopped watching forty seconds later. Unsubscribing a sub-agent
  directly answered `unsubscribed`, and it closed with its root: no thread and
  no helper was left. `thread/read` names a sub-agent's parent.

Not reproduced: the refusal a resume gets in the instant of the close, whose
words ("thread … is closing; retry thread/resume after the thread is closed")
are in the binary and played by the scripted fake, and how long a real tool set
takes to exit. [`script/probe/mcp-release.mjs`](../script/probe/mcp-release.mjs)
now waits for the close and reports what exited with it,
[`script/probe/subagent-release.mjs`](../script/probe/subagent-release.mjs)
records the sub-agent case, and
[`script/probe/seat-processes.mjs`](../script/probe/seat-processes.mjs) counts
the processes and resident memory N seats hold.

**The rule.** One `codex app-server` per account, per `CODEX_HOME`, however many
seats and conversations the account carries; two accounts are two processes.
`CodexRuntime` owns it directly, and the per-conversation layer is gone. What
differs between seats is a parameter of their own thread, never of the process:

- *Working folder.* `cwd` and the writable roots go with `thread/start`,
  `resume` and `fork`, and the sandbox is judged per thread, so a seat's lane
  checkout confines it in the shared process as it did in its own.
- *Lane environment.* The six values travel as the thread's `shell_environment_policy.set`
  configuration (never as process environment), are held per thread, and a
  resume or fork carries its own thread's values.
- *Per-seat settings.* Model, effort, sandbox, approval policy and model route
  are thread parameters. The process carries only the account's: its home, its
  `-c` overrides and the desk's own environment.
- *Isolation.* Stopping a seat is `turn/interrupt` and `thread/unsubscribe` on
  its own thread. Neither names another thread, so no other seat's turn, helper
  or approval is touched; the test holds three turns open and stops one.
- *Accounts.* Auth and limits stay per account, because the process is.
- *Finishing a seat.* Closing the handle interrupts its active turn before
  unsubscribing the thread, while completion and approval events are still heard. Codex closes
  it after its minute and the helpers go with it; the runtime counts the
  closed handle from the moment it asks for the unsubscribe, not from its
  answer, until `thread/closed` arrives — a close Codex makes at once can be
  read in the same chunk as the answer — and does not announce that close
  or its `notLoaded` status back to the desk, which asked for it. The
  sub-agent threads it left loaded are found among the loaded threads by their
  parent; an in-progress child turn is interrupted before its thread is
  unsubscribed, with each read and stop bounded to two seconds and errors
  ignored. This replaces what a process of its own used to do by exiting;
  a thread a session here holds, or another seat's, is left alone. A
  seat opened again inside the minute subscribes the same loaded thread; one
  opened while Codex is closing it waits for `thread/closed` and asks again. A
  reopened active thread recovers its in-progress turn from `thread/turns/list`,
  so it can be steered and interrupted without another `turn/started`. A turn
  notification arriving during that read takes precedence over the snapshot.
  Reopening the root abandons its old descendant sweep, including reads already
  in flight; each unsubscribe also checks that the descendant has no live handle.
  A thread started for a conversation that never registered is unsubscribed
  the same way.
- *The process failing.* A crash or a restart for a new build is the account's
  event: every conversation it held is detached with `session/detached`, the
  restarted process starts empty, and the host reattaches each seat through the
  resume path it uses after the desk itself restarts. Five consecutive restarts
  exhaust the crash budget; a process that stays ready for a minute refills it.

**What it costs.** One process failing now takes every seat of that account's
running turns with it, where a seat's own process took only its own. A finished
seat's helpers live for Codex's minute rather than ending with a process, which
bounds them to the seats released in the last minute and not to every seat since
launch. A close the process never answers (the unsubscribe times out after two
seconds) leaves that thread's helpers until the process rests or restarts.
Closing a pane asks its running turn to end before unsubscribing; a Flow
Stop or a budget stop uses the same close path.
Closing reuses an interrupt already sent for that turn and accepts the process's
"no active turn to interrupt" refusal as completion. Turn notices heard during
the start request take precedence over its reply. An interrupt request and
the subsequent wait for its completion notice each have a two-second bound;
a missing notice after an acknowledged stop does not prevent unsubscribe.
Other interruption failures keep the handle subscribed for retry.

**Reload and a frozen native-server selection.** A Seat keeps the tool servers
it opened with across a Reload. The choice is (a): hold the account's reload
while any open conversation has a frozen selection, including an empty one.
Extensions › Reload reports how many conversations hold it and asks the person
to close them, then try Reload again. Plugin installation has the same hold:
installing can start new tool servers on existing threads, so the install is
refused before it changes configuration while filtered handles remain open.
The person retries after the last filtered handle closes; no deferred reload runs unexpectedly. Conversations
opening hold both operations. Tool changes are serialized, and an opening
that follows an in-flight Reload or installation waits for the admitted
changes to finish before reading configuration. A change that fails reports
its failure to whoever asked for it; the changes and openings queued behind
it go on. Closing and resuming a filtered
Seat rereads native configuration and reapplies its frozen list.

**Where a separate process is still called for.** A frozen selection uses the
reload hold above and does not require another process. What still ends the process is the
account's: the idle rest when nothing is open, a crash, and a restart for a newly
installed build. A future need for a process of its own (a configuration Codex
only takes at launch, say) is named here before it is built.

The scripted fake plays the measured behavior: it closes an unsubscribed idle
thread after `FAKE_CODEX_UNLOAD_MS` (the minute, unless a test shortens it),
never one with a turn running, kills that thread's helper, announces
`thread/closed`, and refuses a resume that arrives mid-close. Two gate files let a
test hold the close open instead of racing it.

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
Scoped notices heard before registration wait under the runtime and conversation
id until real metadata arrives. The pending lists keep the newest 20 notices per
conversation and the newest 100 conversations, dropping the oldest at each
limit. The host folds them into registration and cold snapshots, so a window
that missed their arrival still receives them. The window uses the same
pending-notice fold; content already counted in a host snapshot is not counted
again. Reads keep a synthetic notice turn only while its items are absent from
the real turns, so its old row cannot return after it moves.
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
**Not published** in their list and detail; no new lifecycle event or verdict is
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

> Superseded in part by [Round is someone, square is a thing](#round-is-someone-square-is-a-thing):
> faces are now round by default and square when chosen (`--hd-face-radius`
> in `tokens.css`). A runtime still wears the face shape.

The owner chose the face shape for runtimes: a runtime is who does the work
in these lists, and one meaning keeps one shape everywhere. Settings,
setup, Add a runtime, gateway rows and the runtime card all follow the
person's Faces setting. At the time, square corners were the default and round
was chosen; the superseding decision above makes round the default and square
the choice.
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

Below 600px of list-container width, the skill list (now Customize's, then the
Library's) therefore uses the table family's
list rows: name and command on the title line, a two-line wrapped description,
state on the meta line, and whole loading faces and the chevron in the trail.
The definition keeps the full description one click away. At 600px the table
has about 293px of identity text beside those trailing facts; the identity
cell also keeps a 192px floor. This reads the container, like Teams, so both
the standalone Library and the Settings skills page it then had responded to
their own space; Customize's list does the same.

In that earlier Library repair, the header's markup, relevant PageHead styles
and Settings reading measure were unchanged from main; its narrow blurb was
pre-existing and outside the repair. #1424 later changed the header's wrapping
and text basis.

Roll back: remove the container observer and narrow ListRow composition from
SkillList/SkillRow, accepting the former crowded identity column.

**The rule:** switch a comparison to its list form before trailing facts
consume the width its identity and sentences need.

## Context authorship is recorded beside the transcript

*Issue #1181.* The desk’s marked context wrapper is also text a person can
paste. Its marker identifies a layout, not who wrote it. Each newly sent text
part records the length of the exact prefix the desk composed beside its text;
zero records that no prefix was added. Adapters carry that boundary into the host’s
own transcript, and richer runtime reads retain the recorded content even when
the runtime has already folded its wrappers. The window, queue and
hand-off reader all use the protocol’s same prefix parser with that record;
transcript search, the conversation rail and session summaries use its typed
text view. A second marked block after the recorded prefix is still the
person’s words.

Agent-owned history and older desk transcripts have no such record. Their
readers keep the start-anchored layout rule as a compatibility fallback, and
never infer a new provenance record from that text. This lets the host remember
what it composed without modifying the agent’s own history.

## One canvas interaction engine for Flow drawings

*Owner decision: 2026-10-05.* The builder uses React Flow as its interaction
engine, behind the lazy `FlowCanvas` pattern. It owns pan, zoom, selection,
dragging and pointer connections; every visible card, edge, label, control and map reads
our design system and tokens. The upstream attribution stays visible.

The architecture gate permits the engine and its base stylesheet only in
`design/patterns/FlowCanvas/Engine.tsx`. The public pattern has its own graph
and callback types, so importing it does not load the engine. The caller owns
its document and supplies positions, including the existing `flow-layout`
coordinates. The Run drawing scales the layout pitch from its rendered card
box and the layout's exported gaps, rather than treating the 176×68 layout box
as the rendered card. A Run supplies its state slot, with `flow-overlay`'s vocabulary;
failed and skipped are also available to a caller with those recorded facts.
The first drawing is centred at 100% when it fits; a narrow container shrinks
it to fit. Edits keep the viewport while any earlier step survives. Explicit Fit recalculates the viewport up to 100%; automatic resize keeps the current zoom when the drawing still fits.
Read-only plans retain selection and navigation but have no edit affordances.
Keyboard connection belongs to the builder dock and will arrive in a later
change; it is not part of this pattern.

## ACP sessions release what they opened

An ACP handle used to disappear only from the adapter's map. The peer kept its
session and its children until the whole account process stopped. A catalogue
probe was another retained session. Measured without prompts on 2026-10-06,
eight sessions through the bundled Claude bridge left ten processes and about
2 GB resident after close; the adapter now leaves the one bridge at about
133 MB. The measurement uses an isolated home and synthetic keys, never a turn:
[`acp-session-processes.mjs`](../script/probe/acp-session-processes.mjs).

The negotiated `sessionCapabilities.close` chooses the lifecycle. A peer that
declares it serves every conversation of its account on the same connection;
closing a handle asks `session/close` with a three-second deadline. A refusal
or timeout is logged and drops the local handle; a failed opening keeps its
original error, and a stored archive mark remains successful.
The bundled Claude bridge already tears down its query and attachments there.
The Cursor bridge now cancels and waits for that session's turn, removes its
transient tool/config folders, and keeps its durable chat and the shared start
gate. Neither close names a sibling.

A peer with no close method normally gets a connection per live session, beside the
account's session-free control connection. Close reaps that connection's process
group. A failed worker detaches only its session; restarting or disposing the
account reaps all workers.

Gemini CLI is the measured exception, declared by the known-agent table's
`sharedSessionProcess` policy and applied through the same overlay to existing
and newly registered rows. The first implementation multiplied its process
families, taking eight unprompted sessions from about 0.5 GB to 4.1 GB. The
repair keeps one shared family: measured on 2026-10-06, one, three and eight
open sessions have two processes at 464, 474 and 485 MB. Closing the last
handle reaps the whole family, leaving zero processes. Concurrent session
opens, resumes and catalogue reads hold that release until they settle.
Closing one session cancels only its turn and abandons its approvals; siblings
keep their handles. Without a release verb, its closed sessions and probes
remain in the peer until the last handle closes. This is a deliberate limit,
not a claim that a shared peer can release one session while another works.

Catalogue readers and nearby draft picks share a probe for five quiet seconds,
then release it. Stored-history reads also retain their temporary handle for
five quiet seconds and return the transcript before resource teardown; an
explicit resume takes ownership and cancels that release. Draft picks
and model/command declarations remain cached, and fresh option reads do not
replace the composer's picks. The existing host release seam rests finished
Seats; personal conversations also release after ten quiet minutes, with turns,
approvals, queued input and running tasks protecting them, and so does a
conversation the agent has taken no prompt in: an agent that stores a
conversation at its first accepted message lists nothing for one that has none,
so releasing its handle would drop the only way back. Only a turn the agent
took counts. A first prompt it rejected leaves a failed turn on the record and
nothing in the agent, and a warning given while the conversation opened is the
host's own, so neither lets the handle go. The host cannot tell a prompt the
agent rejected from one it took and then stopped on, a limit say, so a failed
turn is counted as not taken: the cost is a handle kept until a later turn
succeeds, never a conversation that cannot be reopened. Keeping it live has a
second cost: an agent process stops for idleness only while no conversation
holds a handle, archived or not, so one kept this way holds its agent process
open until the agent takes a prompt in it or the person closes it. Releasing it
as soon as the agent lists it would need a listing, which not every agent has,
so it is not done. Archiving a quiet resumable
conversation releases its handle through the same release and the same quiet
test. Archiving preserves working turns,
approvals, queued input and running tasks for the normal quiet sweep.
Closing a pane lets go of its handle at once, whatever is happening in it, and,
for an agent that can reopen the conversation, holds its picks the way a quiet
release does.
Reopening waits for close, then loads the same
agent-owned history; a quiet release, and a pane the person closes, hold the
conversation's option values and reapply changed picks before reopening it to a
client or a send.
A held pick the reopened conversation has no place for, such as a control the
agent now greys, is dropped and logged rather than refusing the reopen; the
picks are spent once tried, and a reopen that still fails closes the handle it
resumed.
Transient history handles keep the stored row's status and timestamps and do
not request a shared last-handle stop; the host owns that idle interval.
A stale close cannot release its replacement. A shared
last-handle stop publishes idle state and its cleanup barrier before awaiting
exit, so host callers wait for restart. Passive process counts include both the
control connection and every live session worker.

**The rule:** share an account process when the peer can release a session;
otherwise bound processes to live handles and reap their groups when released,
except where measured process cost requires the shared, last-handle policy.
Scripted ACP and bundled bridge tests prove release, resume, sibling isolation,
probe cleanup and worker failure. The installed-agent measurements cover opening
and closing only; they do not claim anything about real prompted turns.

## Native server narrowing is separate from approved attachments

Measured on 2026-10-06 with 0.160.0 by
[`script/probe/mcp-selection.mjs`](../script/probe/mcp-selection.mjs): two
synthetic configured servers, an isolated agent home and no model turn.
Thread `config` overrides of the existing native server table, setting an
unselected server's `enabled` to false, started only the selected child on
create, resume and fork, including a server name containing dots. The readback's
null defaults are omitted because the override is converted to TOML; quoted
dotted override keys are rejected by this build. An unrestricted
concurrent thread still started both. Empty threads have no durable rollout;
the probe supplies a synthetic metadata/message rollout for resume and fork.
The production adapter also opens selected, default and empty selections
together, releases only the closed conversation's helpers, and reports zero
owned roots after an idle stop.
No real conversation or account is recorded.

An Agent's `runtime-servers` narrows only the agent's existing native
configuration. It cannot enable a disabled server or install a new one.
Omission keeps defaults; an explicit empty list suppresses them. This is not
phase 12's `mcp` attachment contract: approval, staging and exact attachment
readback retain their existing rules. Unsupported builds and adapters refuse
native selection. The measured capability starts at 0.160.0, rather than
claiming it on older supported builds by inference.

The list is frozen in the durable Seat record, not reread from an edited
Agent file on resume. Native configuration is reread on opening so new
unselected servers are disabled too. The [shared-process decision](#one-codex-process-per-account-shared-by-every-seat)
holds tool-server Reload while any filtered conversation remains open, preserving
its opening selection; close and resume applies configuration updates. Side reviews inherit the selection. A person's fork
of a filtered Seat is refused like a fork of a Seat with approved attachments.
Scripted helper-child tests cover concurrent defaults, release, resume, fork,
an empty selection, reload and passive process-root observation.

## Runtime cost is a passive snapshot

Adapters may report the process roots they own. The host reads PID, parent PID
and RSS only, once for the whole desk, with a two-second bound; it deduplicates
roots and descendants. This is resident memory, not unique physical memory;
shared pages may count more than once. Missing measurement is unknown, not
zero. An idle runtime reports zero owned processes without restarting.

The Runtimes page and its detail page poll while mounted. Recycling is an
explicit idle stop, using the same host barrier as the reaper, so new work
waits for exit before starting and no active conversation is interrupted.
An open handle, operation, read, terminal or watch prevents recycling; cached
catalogue and history remain available through the existing idle lifecycle.

## Max mode reports the saved flag rather than inferring it from a window

*Measured 2026-10-06 for #1311, cursor-agent 2026.10.01-e373342.* Three
one-word live turns used separate temporary configuration directories and
`--print --output-format stream-json --trust --mode ask`; each returned
`pong`, exited 0 and wrote back the selection shown below. No tools ran.

| Request | Saved selection | Saved `maxMode` | Saved `maxModeAutoEnabled` |
| --- | --- | --- | --- |
| GPT-5.2, Max on, `context=1m,effort=low,fast=false` | GPT-5.2 Medium; parameters `reasoning=medium,fast=false`, no context | `true` | `false` |
| Grok 4.7, Max off, `context=200k,effort=low,fast=false` | Grok 4.7 256K High Fast; `context=256k,reasoning_effort=high,fast=true` | `false` | `false` |
| Max off, `--model claude-sonnet-5-5-high` | Claude Sonnet 5.5 300K High; `context=300k,reasoning_effort=high` | `false` | `false` |

The first turn dropped the requested parameters but retained the saved Max
flag. Therefore a non-1M selection does not establish that the saved flag is
off. The other turns did not reproduce a 200K automatic enablement: those
requests resolved to 256K and 300K on this CLI and catalogue. That case
remains synthetic regression coverage, not live evidence. No billing read
was made; a saved flag reports configuration, not a measured charge.

The bridge reflects that flag after a turn while preserving a newer manual
choice. Automatic provenance stays an observation: it is shown in the model
menu and hover text and is excluded from saved preset preferences.

## An account change hands the reads in flight to a fresh read

[Account reads](architecture.md) are bounded: host calls through a registered
runtime share one read per account generation, each with a ten-second deadline.
When an account-change notice arrived while a read was in flight, that read was
ended with "Account changed during a read. Try again.", so that nobody was
answered by an adapter that began before the change and nobody waited on one
that never answered.

**What it did to a seat.** No caller retries that error, and the seat offer
reports an account it cannot read as the runtime being unavailable. A signed-in
Codex says `account/updated` once, on its own, between 0.36 and 0.90 s after its
app-server is up (nine runs on 0.160.0, `script/probe/account-notice.mjs`), and
the desk reads the account the moment it resolves a seat, which just after a
start is inside that window. The notice landed on the read and failed it: the
seat was passed over as `unavailable: its account could not be read — Account
changed during a read. Try again`, and a Flow could not seat Codex at all, with
a refusal that said only "No seat could be opened". The same resolution a few
seconds later was accepted. Reproduced on the real binary and the real home
through the whole host: a Flow dry run right after the start was refused five
times out of five, and accepted three times out of three with the change below.
An empty home says nothing, which is why a throwaway home never showed it. The
build before #1480 had no bound on account reads and so nothing to fail.

**The decision.** A change hands the callers of the read in flight to a fresh
read that begins after the notice. They are answered by something no older than
the notice, never by an error, and never by the older adapter, whenever it
speaks. That keeps what the bound was made for: one shared read per account
generation, the deadline on each, the older read's late settlement neither
releasing nor changing the newer one, and a teardown refusing the callers still
waiting. A change with nothing in flight starts nothing.

**What it costs.** A notice that lands on a read in flight starts one more
adapter read while the older one is still outstanding, as a fresh caller's
already did. A stream of notices would start one each; none does today, since
Codex says it once.

**Refused.** *Retrying in the seat offer.* That repairs one caller and leaves
`runtime/account` and every other reader raising the same sentence. *Ignoring
the notice.* It is how a sign-in finished in another window reaches this one.
*Reverting the bound.* Reads a client had stopped waiting for did accumulate,
which is what it was made to stop.

**Not measured.** A real change of account, a sign-in finishing elsewhere,
landing on a read in flight: the scripted Codex plays the notice from the
measurement above and nothing else. Whether Codex says `account/updated` again
later in a session, when another process refreshes the shared credential: it
was not heard in a run of about seventeen seconds, which says nothing about an
hour.

## Agents start by measured cost

Launching the desk starts only its default agent, in the background; the window
waits for no agent. Every live operation shares the existing start and idle-stop
barrier. Highlighting or choosing an agent, and opening its settings page, is
intent: it starts an agent whose last observed process readiness plus first-model
read cost at least 500 ms, or whose cost is not known. A cheaper agent waits for
its first live operation. No agent-name table decides the split; each start is
measured on this machine, with readiness and the first models answer kept apart.

The host writes display observations to `runtime-cache.json` beside `state.json`,
atomically, independently of conversation storage. Models, runtime and session
options, loaded commands, learned capabilities and account display fields remain
readable while the adapter is idle, including before its first start this launch.
Missing observations mean not known yet. A live answer replaces them and sends
the existing catalogue and account events. Account records keep only kind, name,
plan and whether the name is anonymous; no email field, sign-in payload,
credential, token or key is copied into this cache. Agent-owned authentication
remains in the agent's home or the credential broker. The account observation
also keeps only the permitted sign-in flow kinds, so restoring it cannot offer
a method forbidden by the last effective configuration. Descriptors are rebuilt
by the adapter; without an observed policy it offers no invented method. A live
read replaces the recorded policy along with the account display fields.

An ordinary extra Codex account's saved row is retained even when its home has no
credential file: a file's absence does not establish that another credential
store is empty. The host does not probe extra agents at startup to decide.
Its restored or idle account observation is unverified until a live read.
Explicit removal persists the row change before stopping its exact owner; if
the identity is unknown it neither signs out nor purges the credential home.
This preserves ambiguous accounts and can leave an unfinished row until the
person removes it. It does not establish isolation between provider stores.

Automatic catalogue refresh skips idle agents. An explicit refresh is intent and
still starts one through the host. File-based usage meters and process-cost
observations keep their passive reads. Resuming a conversation or opening a Seat
waits for current capabilities before making its live request. Sidebar hover
intent follows when the conversation index is integrated.

## Which DeepSeek key wins is declared per version — 2026-10-14

DeepSeek Harness (`dsh`) takes its API key from four places: a store it keeps
itself (`.credentials.yaml` in its home), the environment it was launched in, a
`.env` in the folder it runs in, and a `.env` in its home. HarnessDesk keeps its
own copy in the credential broker and hands it over as the launch environment,
so which of the first two outranks the other decides whether that copy is used
at all. The registry used to say the environment wins, and that was true.

It stopped being true in 0.2.1-alpha.3. Measured by running each build as
`dsh --profile acp` (how the `dsh` template starts it) against a fake
Messages-compatible endpoint on loopback that records the `x-api-key` it
receives, with its own `DSH_HOME` and `HOME` per run and no real key anywhere:

| Present | 0.2.0-rc.2, 0.2.1-alpha.1, alpha.2 | 0.2.1-alpha.3 |
|---|---|---|
| launch environment and `.credentials.yaml`, different keys | environment | **`.credentials.yaml`** |
| launch environment and home `.env` | environment | environment |
| `.credentials.yaml` and home `.env` | `.credentials.yaml` | `.credentials.yaml` |
| each alone | that one | that one |
| none | missing-credential error | missing-credential error |

The build before the change and the first one after are adjacent releases, so
the flip is alpha.3 and nothing earlier. Through HarnessDesk's own runtime
driving the real alpha.3, a broker key and a different key in the store gave an
account row of "Stored by HarnessDesk, handed to DeepSeek when it starts" while
the agent sent the store's key; the balance meter read the broker key's balance
for the same reason. Both now follow the build the host last launched.

So a source declares the build it moves on: `AcpSecretSource.outranksEnvFrom`,
set to `0.2.1-alpha.3` on the store and absent on the `.env` (`known-agents.ts`'s
`DSH_STORE_FIRST_FROM`, spelled in both places the secret is declared).
`secretReadOrder` splits the sources into those read before the environment and
those read after, by the version the host read when it launched the agent
(`launchedVersion`), compared with `versionAtLeast` — which orders prereleases
(`alpha.3` after `alpha.2`, before `rc.1`, before `0.2.1`), because the existing
triple comparison cannot tell these two builds apart. A version nobody read keeps
the older order. Presence detection (`whereSecretLives`) and the DeepSeek
balance meter use the same split, from the same version.

That version is only known once the agent has been launched, so it is also
remembered between runs (`launchedVersion` in the runtime cache, handed back by
`restoreObservations`): without it, the first balance read after an app restart
would use the older order while the account row, restored from the same cache,
already named the store. A desk that has never launched DeepSeek has nothing
remembered, so until its first launch both use the older order and then move
together; a balance read before that is kept for its normal few minutes. A key
in a row's own `env` is read by the meter and not by the presence check, as it
was before this change.

An idle account read rebuilds declared key accounts from their current sources
and that remembered version before returning saved agent identities. An account
restored from an older cache therefore gets the same precedence flags as a fresh
read, without starting the agent.

*The copy HarnessDesk keeps.* An account's kind says where the key in use
lives, and until now `externalKey` also meant HarnessDesk held no copy; the
key dialog's Replace and Remove were drawn only for `apiKey`. With the store
winning over a key HarnessDesk also holds, that left a copy nobody could
remove from the interface. The account now carries `storedCopy` in that case
(the key in use is read ahead of the broker's and the broker holds one), the
dialog keeps its stored-key controls for it, and the account page says the copy
"comes before" rather than that there is none.

*Why not make HarnessDesk's key win again.* The only lever is a profile overlay
that disables the agent's credential store, which is what its one-shot
`headless` profile does by default. That would also hide every other credential
the person saved there (other providers, sign-ins), and the agent's own store is
the agent's to keep.

*The one-shot `headless` profile does ignore the store from alpha.3*, as that
build's own notes say: with only `.credentials.yaml` present it exits with a
missing-credential error, where rc.2 read it. HarnessDesk never starts `dsh`
that way, so nothing here changes for it.

**Checked on the same builds and unchanged.** `session/resume` (the only way back
into a DeepSeek conversation: `initialize` advertises `list`, `resume` and
`close`, never `loadSession`) returns the configuration, replays nothing, keeps
the folder `session/list` reports, and the next prompt still carries the earlier
turns; HarnessDesk marks the reopened conversation `partialHistory` and numbers
its new turns apart from the old ones. `session/cancel` during streaming and
during a running `bash` call both settle the prompt as `cancelled`, which
HarnessDesk records as an interrupted turn, on rc.2 and alpha.3 alike; the
"Task stopped" wording in alpha.3 is the agent's own web client, not the wire.
The provider name `azure-openai-responses` is an internal API kind inside the
agent's own model catalog; HarnessDesk names no DeepSeek provider but
`deepseek-official`, which is unchanged.

**Not measured.** A real DeepSeek endpoint: every figure above comes from the
fake one, so what it shows is which key was sent, not whether the vendor
accepts it. Builds after alpha.3, which may move the order again; the floor is
the first build measured, not a promise about later ones. A key in a `.env` in
the folder a conversation runs in, which the agent reads between the
environment and the home `.env`; HarnessDesk does not look there, as before.
The key dialog's sentence that a key stored in this window "takes precedence"
over one the agent already has is still true of a `.env` and, on the builds that
read the environment first, of its store; it stopped being true for the builds
above when the store has a key. The account row now names the store and the
dialog keeps the copy to manage; rewording that sentence was a separate change,
made next.

*What the dialog says now.* A second flag, `Account.outranksHandedKey`, is set
whenever the key in use is read from a source that comes before the one
HarnessDesk hands over (`whereSecretLives`' `before` side, so the same version
test as the account row). It is a different fact from `storedCopy`, which is
whether HarnessDesk keeps a key at all: with the store first and nothing saved,
the account has no copy to manage, and a key pasted into the field would still be
the one the agent ignores. So the flag is set with or without a copy, and
`storedCopy` implies it. The dialog's summary then says the agent reads its own
key ahead of any stored here, and that one saved in this window is used only if
that is removed; the stored-key row says the same of the copy it is holding, and
drops "restart a conversation to pick up a change", which is false of a key
nobody reads; the account page's note says the key stored here comes after it.
The field stays open, because a key saved now is the one used the day the
store's is removed. Where the flag is not set, the sentences are unchanged.

## One notice, one layout (supersedes #1222's first-line rule)

Decided 2026-10-15. First-line pinning left a tile floating above wrapped copy;
the owner found it awkward, and eleven notice treatments disagreed on six
axes. Rule C puts tile, copy and controls on one centre for a single line.
With wrapped copy the tile centres on the complete text block, actions stay
beside it and the dismiss stays at the top-right. Three or more actions, or
a container under about 400px, put actions below at the right.

The shared notice uses the composer's neutral plate, edge, radius and soft
shadow. Danger adds a 3px left bar and red tile; success confirms a completed
requested action through a green tile only. Title and earned detail stack.
Hosts own standard (14px) or compact (13px) size; floating toasts alone take
the notice shadow. Content callers supply no presentation overrides.

Part 1 supplies the primitive, family API, success contract and one Notice
board. Existing host wrappers keep their signatures and presentation until
part 2 moves screens and enforces the new caller boundary. JobsBar narration,
Approvals, dialogs and field validation remain separate. The #1211 decision,
one notice, one outlet, still holds; this changes anatomy, never routing.

## Missing Team folders are measured by the host

A Team can outlive its checkout without leaving conversation history on this
desk. Session listings therefore cannot be the only evidence that a project
folder is gone. Room and Goal wire boards carry an optional `folderGone`
measurement, refreshed on lists and changes; one read shares the measurement
for every Team with the same root. A missing path or a non-directory proves
absence; a permission or I/O failure leaves existence unknown. These measurements
are not saved into boards or Goal documents.

The sidebar merges these facts with missing conversation folders. A missing
root earns no project row or Team row through a surviving clone's aliases,
and the gone-folders line counts each root once.
Forget silences that count without deleting Teams, Goals, receipts, boards or
history. Search and the Teams page still reach the Team. Measuring in the host
also works for unopened roots and needs no request per renderer row.

## New Team writes at edit access and hands publishing to the person

The first-time walkthrough in issue #1669 found that Write and review asked
for `publish`, which none of the shipping runtimes can enforce. On 2026-10-15
the owner chose B + D: the shipped writer and every repair run at `edit`,
Automatic passes over preferences without the required control, and an
independent reviewer reads the committed change. Approval opens a person card
naming the reviewed revision and the writer's branch context. The person
approves and performs the push and pull request publication before merging.
The writer may commit locally but cannot push or open a pull request.

Implementer's declared maximum stays `publish` for Flows that explicitly grant
it. This changes the shipped shape's grant, not the permission ladder or a
runtime's controls. Option C, allowing an asked-only limit with confirmation,
was not chosen: New Team still requires an enforced limit, including read-back,
for every agent it opens, in later rounds and after recovery too. An explicit
runtime choice that cannot enforce that access remains refused beside its row,
with a way to choose a compatible agent. Automatic uses the same strict plan,
so an earlier incompatible preference cannot block a later compatible one.

## New conversations start carefully, with defaults in General

For issue #1675 the owner chose D2 A and D12 A on 2026-10-15: a new
conversation starts at workspace-editing access and the runtime's recommended
model and effort, and those choices are available in Settings › General.
Adapters declare `recommendedValue` on their options. The renderer validates
and applies these before starting, resolving the model before its dependent
effort, without a model-name or runtime-id table. Explicit saved picks win;
recommendations themselves are not persisted as personal choices. Existing
conversations keep the settings their runtime reports.

General and the composer share the existing per-runtime draft preference
record. Choosing Recommended removes a saved value; changing the default
runtime uses the existing persisted runtime selection. The data, backup and
support sections stay where they are.

## 2026-10-16 — Project entry and finished Teams (#1675 D4, D5, D11)

The owner chose D4 A+B: **Open a folder…** in an empty composer and
**Open folder…** in the New session menu call the same folder picker as
Projects. D5 A keeps a finished Team under its project, with the attention
dot labelled **Ready to wrap**, until it is wrapped; the gone-folder rule
still applies. D11 A removes Agents and Plugins counts from sidebar rows
(Plugins has since moved into Customize, which has no sidebar count either)
and keeps those totals on their pages; the Flows row, added since, follows the
same rule, so only Dashboard's attention count remains. Part 2 item 8 earns
**Most used** only from recorded Flow starts; fresh desks list unused Flows
under **More Flows**. These entries compose the existing controls and state marks.

## Team runs use plain words and Wrap starts from the result — 2026-10-16

Issue #1675, owner picks D7 A and D8 A. A completed attempt keeps neutral ink
when one of its sub-steps failed: the failure count and the opened step retain
the fact without judging the successful turn. Board tool headlines use one
presentation table of plain actions, and their exact identifiers remain in
details. The messaging notice explains the effect in plain words. An agent's
own “Committed” verdict remains verbatim because it describes what it delivered.

A comparison counts the attempts actually recorded in its Run and says who
picked only once the pick is recorded. Wrap uses the same Run timeline's picks
and verified person-card merge receipt to prefill an editable line for each
attempt, with its card number distinguishing identical titles. A picked revision is Kept until a merge
is observed; the person's merged attempt overrides the referee's pick, and
the other attempt defaults to Not kept with an editable reason.
The existing receipt protocol still records that disposition as dropped. The
person reviews and can edit every field before confirming the wrap.

## The Library read carries where a skill came from, and the network is only asked when a person asks — 2026-10-16

An installed repository skill already has its public repository, ref, commit
and skill path in the Library manifest. `library/read` carries that recorded
origin on each non-hollow skill copy, so copies installed for different agents
can report different pinned commits before anyone checks for an update. Local
skills, MCP entries and copies without a valid recorded origin omit it.

Every read loads the local manifest again. An applied update therefore changes
the origin on the next read, while the existing comparison drops a check for an
older origin. Update results still belong only to the host lifetime in which a
person requested the check; a new host reads the origin without inventing a
check result.

**Rule:** the recorded origin is read from the manifest on every read; a check is only ever an explicit request.

## Empty board columns collapse; the badge counts everything

The owner chose option B in [#1674](https://github.com/HarnessDesk/HarnessDesk/issues/1674)
on 2026-10-15. A finished Team showed Board 3 above four full-width empty
columns, while its three completed cards were outside the visible row.

The badge continues to count every card. Empty columns start as named rails
with zero counts, preserving their order and the existing keyboard expansion
and folding controls. Occupied columns retain their width; the all-empty board
retains one empty state. Below 600px of content width the compact list remains
the readable form. A horizontal Board keeps its token-backed scrollbar visible
at rest, so overflow announces itself before a gesture.

## One Permissions slot; plan vs act is its own control

Decided 2026-10-15 in #1672, option A. Permissions always occupies the same
composer slot and keeps the agent's own levels. Collaboration mode is a
separate control; an agent that offers no collaboration mode has none.

The adapter declares permission options with `_permissions`. A mixed list
also supplies `SelectOption.collaboration`: the existing `planValue` and
`actValue` that the collaboration control writes. The bridge supplies those
values on every declaration, including updates. No renderer match on a name,
a description or an agent id decides the split. Both controls write the same
underlying option id and its existing values; choosing a permission level
leaves planning, and choosing Act uses the adapter's acting value (the ordinary
manual mode when the agent is currently planning). There is no second stored
permission policy to reconcile with the agent.

While planning, Permissions displays the declared acting value that Act will
return to; Plan remains selected only in Collaboration mode. This display
projection does not change the agent's current value. The runtime cache keeps
both collaboration values so the same split is available before the agent starts.

The Permissions trigger names the slot and the selected level, including in a
draft. Only a genuinely absent permission option earns the missing-setting
placeholder. Model and effort take their natural width while space remains;
they fold with the toolbar when it runs out.

## A fetched skill is reviewed as a bundle before installing — 2026-10-16

Customize's (then the Library's) Add from GitHub flow pins a public repository revision and lets
the person choose skills and destination agents before the ordinary plan.
The plan lists every carried file and lets runnable or binary fetched files
be read as plain text. Those incoming files require an explicit acknowledgement
before Apply; ordinary local installs retain their existing confirmation.
The acknowledgement travels only on the operations whose files need it.
This keeps the review attached to the bundle the host planned and checks again
at apply, rather than treating a skill's definition as its entire contents.

## Pace forecasts earn composer space; Team waits also reach the Inbox

On 2026-10-15 the owner chose A + B for issue #1675 D3: a pace warning above
the composer waits until work has started in the desk and less than 15% of the
binding window remains. The named threshold is
`COMPOSER_PACE_REMAINING_PERCENT`; a turn in a held desk conversation supplies
the existing work fact, excluding history previews, without a new persisted
flag. The Dashboard retains the forecast at every remaining share. The Notice
primitive supplies the sentence stop between an inline title and its detail. Exhausted quota keeps its
existing behavior.

For D6 the owner chose yes: person cards, picks, approvals and questions waiting
in a Team also reach the bell's Inbox. The store reconciles live entries from
the existing Needs-you selector when `team/changed`, `goal/changed`,
`flow/execution-changed`, `approval/requested` or `approval/resolved` updates
the held facts, and when initial reads hydrate those same facts. A Team and
Run plus conversation and card or approval identify the row; repeated snapshots preserve its read
state. Answering or moving past a step clears it, as does ending or wrapping
the Run. Its destination opens the Team's existing view. Needs you itself keeps
its current presentation.

## 2026-10-16 — Board cards share their frame before another page uses it

The compact opening card is `BoardCard`, a design pattern over the shared
Button and Card. It owns the truncated identity, optional title aside,
attention detail and optional middle and footer slots. Callers retain their
own metadata and description ids. The Teams card composes it with its Run
path, unread dot, faces, project and age, preserving its DOM and appearance.
The public entrypoint exports it as `CompactBoardCard`, preserving the
existing work-board primitive named `BoardCard`. This establishes the shared
shape before a second page uses it; it adds no new tone, token or page behavior.

## First run always has a text box — 2026-10-16

> Superseded in part by [Conversations can start without a project](#conversations-can-start-without-a-project--2026-10-16):
> decision 3 is reversed; Send no longer waits for a folder picker. The other
> decisions stand.

Issue [#1720](https://github.com/HarnessDesk/HarnessDesk/issues/1720) found that
a fresh desk replaced its text box with a folder button. The owner chose:

1. Keep the enabled text box in every state and focus a fresh draft.
2. Put **Choose folder** in the composer's own toolbar, using the existing
   folder picker from Projects and New session. A chosen folder shows its
   name, truncating with its full path on hover; worktree choices remain.
3. Enable Send for text on a ready agent without a folder. Send waits for the
   picker: choosing sends into that folder; cancelling preserves the draft.
   No conversation starts without a folder.
4. Keep **What should we build?** and one line, **Describe a task, then choose
   the folder it runs in.** Remove history-source copy from the main pane.
5. Keep the installed-agent offer from #1673 in a compact row: names, small
   secondary **Add** buttons, and **Installed on this Mac** on one centre line.
6. Draft Details omits unknown permission and branch prose, even with a
   folder chosen, and omits an empty Plan card. **Not chosen** and **No usage
   yet** are facts worth showing.
7. Keep toolbar items on one centre line with the toolbar's spacing, checked
   at 1280 and 1600 pixels, with no height jump after choosing a folder.
8. The first screen names no CLI, editor extension or other history source.
   This supersedes #1673's history-copy sentence for both the main pane and
   sidebar. No reader remains for `presentation.historySource`, so its UI
   helper, adapter declaration and protocol field are removed.
9. The owner's second addendum removes the global sidebar empty-state block
   entirely, replacing the earlier zero-project-only wording. Projects always
   draws its heading, filter, options and +; individual projects retain **No
   conversations yet — ⌘N starts one here.** as their own row state.
10. The folder fact in Details shows the folder name, with the full path in
    its title, rather than shortening a path in the middle.
11. All drafts omit the unreported-permission line, including after a folder
    has been chosen.

This replaces #1675 D4's standalone empty-composer button while preserving
its shared-picker decision and #1673's registration behaviour. No new theme,
scratch folder, agent registration or sign-in policy is introduced.

## Updates are checked when asked and reviewed file by file — 2026-10-16

Customize (then the Library) checks recorded repository origins only when the person asks.
It shows the most actionable result on the row and the pinned and newer commits
on the sheet. Recorded origins remain visible before a check. Review fetches
each distinct source once and plans each runtime copy at the fetched commit,
which can differ from the commit an earlier check saw.

The existing plan lists added, changed and removed files, opens the definition
diff, and reads incoming runnable or binary files. Those files use the same
acknowledgement as an install; removed files need none. An edited copy carries
the host's reason and its planned backup. Check results live only with the host,
so a restart needs another explicit check; the ordinary read after Apply clears
results whose recorded origin changed.

**Rule:** nothing checks on a timer and nothing applies by itself.
## Ordinary pull requests run core CI; integration runs in the full tier — 2026-10-16

Per-PR browser shards competed with batch runs for the account's job cap.
Every reviewed change lands through a `batch/` pull request that already runs
full CI, so ordinary pull requests now run core checks only: build, typecheck,
Node tests and end-to-end, UI unit tests, UI tests and gates. Browser shards,
server-facing browser specs and native smoke run in the full tier: main pushes,
`batch/` heads, `full-ci` pull requests and manual dispatches.

The override lives at the `ci-changes.mjs` CLI output boundary. The shared
`planChange` and browser selection stay intact for local `check:push`, including
the impact map, reached and edited specs, PR matrix and duration table. Bounded
CI reports that local spec selection and reuses the existing intentional-skip
path for its required integration checks. Core CI, local selected specs and
the batch's full run together cover a change; ordinary green alone cannot land.

**Rule:** keep per-PR browser feedback local, and require full-tier evidence
before landing.
## Dashboard figures name their measure and their observation

On 2026-10-15 the owner chose all of issue #1675 D10. Overview calls the
ledger's total **Usage cost**, keeping its pricing basis in the title and its
chart selection in `aria-pressed`. Pace badges use the magnitude of remaining
allowance above or below an even burn, so the arrow and over/under word agree;
zero is on pace. Reports older than this window are labelled **From a cached
read**, rather than suggesting this desk read them hours before it opened.
The read note follows account scope and retains the oldest observation.

The adapter supplies a readable plan label beside the raw identifier; the
host carries both and the raw value remains available in the label's title.
Unknown plan types fall back to title-cased words without Self Serve.
**What is left** includes healthy accounts with reported limits. Its former
attention-only filter caused the missing account; there was no runtime-id
gate. Host reads already use runtime capabilities, and file-backed meters may
report limits even when a runtime cannot meter directly, so those reports
remain eligible too. The attention count still counts only plans needing it.
## Agent and model logos in their makers' colours — 2026-10-16

The owner compared the app with other agent desktops and found theirs read
better because their logos are in colour; every glyph in those apps is still a
one-colour line icon. The owner chose colour logos only, not a colour per
project. `BrandMark` draws the lobe-icons colour file where one exists and keeps
the one-colour drawing beside it. A stylesheet rule shows the one-colour drawing
on `[data-tint]`, `[data-color]` and `[data-off]` grounds. That keeps a tinted
face, an account ring or a signed-out seat in its identity's ink, and it costs
a second inline drawing per mark rather than a prop at every call site. A maker
with no colour file stays in ink. Codex's colour file loses its white app-icon
square and Kimi's white K takes `currentColor`; tests require each fix to still
find what it removes, so an upstream redraw fails a test instead of shipping.

## Reviewed changes collect on development; every merge to main is a release — 2026-10-16

> Superseded in part by [Development pushes run the browser specs their change reaches](#development-pushes-run-the-browser-specs-their-change-reaches--2026-10-16):
> a development push now runs the bounded browser selection as well as the
> core checks. The branch and release model stand.

CI and the account's job cap became the bottleneck: approved changes waited
hours for a batch. From the next release, reviewed changes land offline on a
long-lived `development` branch, one commit per change. Each push runs the core
checks, without browser or native jobs. A nightly dispatch at 11:00 UTC runs
full CI on development; failures are fixed the same day. Until the branch
exists, that nightly workflow quietly does nothing.

The release pull request from `development` into `main` always runs full CI.
It lands with a merge commit, preserving each change's commit on main; the
version bump happens on development before that PR. Every merge into main is
a release. Core checks on every push, nightly full coverage and the release
PR's full run keep the guardrails while removing per-change integration queues.
Main pushes, batch heads, the full-ci label and manual dispatches remain full.
`land-safe` defaults to squash and permits `--method merge` only for a
`development` head, retaining its reviewed-head, full-tier and stable-base checks.
## Registry browsing is a separate step; runtime brands keep one colour — 2026-10-16

Owner pick for #1675 D9: **A**. Add a runtime keeps the machine's catalogue
first and puts ACP registry entries behind **Browse more…**. A single MenuNote
says the entries are third-party and unreviewed. An entry's install and add
behaviour stays the same.

The same issue's Part 2 item 3 fixes identity drift: a runtime's presentation
brand selects one tint in the design system, wherever its tile appears.
Account ring preferences remain separate. Library's Loaded by tiles use a
token gap rather than overlap, keeping each runtime mark visible.

This supersedes the account-tint rule for runtime brand faces; account rings
and account badges still identify the signed-in account. Roll back by restoring
the inline registry list and account-derived runtime tints, accepting the former
identity changes between pages.

## Usage runtime series follow their faces — 2026-10-16

The owner's repair to #1729 keeps Usage's runtime table usable as its chart's
legend: brand tint is shared by each runtime's ranked face, legend dot, share
segment and bar. Resolve across the whole roster, reserving distinct brand
tints first. The first runtime with a tint keeps it; later duplicates borrow
the next unused roster tint for both series and ranked face. Plans faces,
account preferences, other pivots and the folded Other row retain their rules.
## Agent is a role; Runtime runs the conversation — 2026-10-16

For issue #1675 D1, the owner chose B: an Agent is a saved role such as
Implementer, Judge or Code reviewer. A Runtime is the program that runs a
conversation. The composer, Settings group, Library loaders, account and
history surfaces use runtime when they refer to `RuntimeInfo`. Runtime names
still come from its presentation and features from its capabilities.

The Agents page, Team roles, Seats, sub-agents and Library’s Declared by
filter keep their role meaning. This is a copy boundary; identifiers, wire
methods, protocol fields and file names keep their existing spellings.


## Rows share one highlight and floating surfaces share one motion

The visual refinement in #1733 uses the row's hover fill for keyboard focus
as well. A menu's arrow keys stay within its plate, so that fill is its whole
focus mark; a page row keeps the window's focus ring too. A refused menu row
remains in the keyboard path so its reason can be read, but it cannot run.
Pointer hover leaves it unlit, preserving the distinction between an action
and an explanation.

The model picker and context menu now use `floatingMotion`, the same entrance
and exit as the other floating surfaces, and row fill transitions use
`--hd-duration-fast`. The shared primitives own this policy so individual
menus cannot acquire a different highlight or cut in without motion.
The menu-state preview shows rest, pointer and keyboard states in both themes;
[the interface](interface.md#menus-and-row-focus) records the behavior and
[the design guide](design.md) records its shared styling.
## Navigation and choices stay usable while runtime reads settle — 2026-10-16

> Superseded in part by [Customize is the shared capability destination](#customize-is-the-shared-capability-destination--2026-10-21):
> Settings no longer lists Skills; skill management opens Customize. The
> stable-route rule still holds for the rows Settings keeps.

Settings always lists Skills and Extensions. A runtime may call its skills
commands and may have no extensions, but those facts describe its page and
hover text; they do not rename or remove the route while a window is open.
This keeps the navigation identical before and after the runtime read (#1675).
The old recorded claims about a runtime naming the rail row, and the page
repeating that word, are retired: the rail now names a stable route while
its page keeps the runtime's vocabulary. The one-line row claim stays pinned
to the updated route test.

New Team uses the same anchored choice menus as the composer. An automatic
seat reads the runtime chosen by its plan, without requiring an explicit
runtime change first. A model or effort choice pins that automatic seat.
Nested Escape belongs to the open picker before the dialog.

A choice menu inside a dialog portals into that dialog's content. Its popup
therefore shares the modal's stacking context instead of landing below the
modal viewport; the existing focus and Escape policy still owns dismissal.

Library does not list skill folders beginning with `_` or entries with only
empty definitions on disk. This is the owner's choice for #1675: omit them,
rather than select a broken entry first. The inventory keeps hollow-copy
diagnostics for cleanup and still lists an entry with a usable copy elsewhere.
Empty and whitespace-only definitions count as hollow. Descriptions in both
list and matrix, and in the reading sheet, use sanitized markdown so backticks
produce inline code.


## Development pushes run the browser specs their change reaches — 2026-10-16

Owner's decision: approved work lands on `development` by a Lead push, without
an individual pull request. Five consecutive landings broke browser specs
without prompt detection, so every development push now runs core CI plus the
same bounded browser selection formerly used for pull requests. Diff the
push's `github.event.before` against `HEAD`, fetching the before commit when
the shallow checkout lacks it, and compute theme metadata over that same range.
Prefer development's last full-run impact map, falling back to main's and then
legacy `ui-impact-map-<sha>` entries, to select reached UI specs, retain edited
specs and include server-facing coverage when reached. Save maps from clean
full runs on both branches under distinct
branch keys. Files the specs read, including the interface contract and shot
rigs, select the specs that read them through the suite's dependency graph.
Combine those readers with the mapped reach of UI source in a mixed change;
other docs-only pushes open no browser. A read narrows a file only when it is
the file's sole tie to the suite. UI package inputs, UI external imports and
global inputs keep broad coverage with their readers mandatory. Comments are
not reads, and an unread file under `script/shots/` selects no browser specs.

Global inputs, including manifests, the lockfile, UI build configuration,
protocol and assets, retain the four-shard cap even without an impact map.
The summary names the global input. After mandatory specs and recorded reach,
the cap fills in a deterministic rotation keyed by the pushed SHA, falling
back to the before revision, so successive pushes sample different specs;
the nightly full run covers the rest. A change to `.github/workflows/ci.yml`
or `playwright.ui-system.config.ts` instead runs every spec uncapped: these
rare changes alter how the suite itself runs.

A missing, all-zero or unavailable before commit runs every browser spec with
the bounded theme matrix, bypassing the selection cap rather than guessing at
the pushed change. An unreadable input graph, a missing impact map when one is
needed, or an unresolvable read does the same on a development push. A map whose
environment differs (protocol, client, UI configuration or root setup) still supplies
per-file reach for ranking: reached specs come first, then the four-shard cap
fills. Its summary names the environment mismatch and every deferred spec.
Other stale map evidence also ranks a conservative capped sample. Native smoke
stays full-tier only. Ordinary pull requests remain core-only as decided in
#1734. Main pushes, nightly/manual dispatches,
the development release PR, batch heads and the full-ci label retain their full
tier. Required check names and intentional-skip success stay stable. Push and
dispatch concurrency groups remain separate so a landing cannot cancel the
nightly full run. Each development push also has its own commit-keyed group,
so later pushes cannot cancel running or pending coverage of earlier ranges.

## A page title stands on the wordmark's line — 2026-10-16

A standalone page's title and the sidebar's wordmark are the same type, 20px on a 28px line, and they sat 18 to 20px apart: the page column began under the bar with its full 24px gutter, while the wordmark stands in a bar-tall brand row directly under the sidebar's top row. Two big names at nearly one height read as a near miss, the same flaw the guides report as an edge off its rail. Titles also disagreed with each other by 2px, because a head whose verb is 32px tall centred its title lower than a head with a smaller verb.

The title now shares the wordmark's line. Its head row is one bar tall (`--hd-bar-h`), the brand row's counterpart, and a page that opens with its title drops its top gutter, so both rows start at the bar's bottom and centre on the same line. The title, the wordmark and their baselines coincide, and the page's verb (Refresh, New Team) centres on that line too. Nothing hand-tunes a screen: `PageOptions` sizes the row and `Page` drops the gutter when its first block leads with that row, so every page built from them follows, including one whose head sits inside a toolbar (Teams).

Why the line rather than more air: the window already reads along its bars, and the content's first row is a bar-height row beside the sidebar's. The 6px between the bar and the title is the wordmark's own distance from the row above it, so the two columns open the same way. The title keeps its place when the sidebar is hidden, because the row is measured from the bar, not from the sidebar. Pages without a body title (conversations, canvases, a session or a Team with its subject menu in the bar) keep their insets.

## Conversations can start without a project — 2026-10-16

For #1727 the owner chose option A. This reverses decision 3 of #1721's
first-run entry: Send no longer opens a folder picker or requires a project.
The host creates a fresh dated directory with a short unique suffix inside
its chats folder, defaulting to `chats/` under `HARNESSDESK_HOME`. The renderer
never constructs that path.

The folder menu starts with **No folder**, which clears a prior choice while
retaining the draft. Its hover title carries the chats location. Managed chats
and conversations with unknown folders share one **Chats** group; an empty
group is omitted. Existing repository-state checks govern folder-only tools.

Settings › General exposes **Chats folder**, **Change…** and **Reset** through
the existing folder picker and host preferences. Changes affect only future
conversations. The host retains previous chats roots so existing conversations
keep both their original folder and their Chats grouping. New drafts and
hand-offs from a managed chat allocate fresh folders; the hand-off packet
retains its source location as provenance.

The host-created folder becomes the chat's open workspace before its first
layout is saved. A recent chat with a saved workbench restores that workbench
on launch; a recent chat with no saved workbench does not choose a folder for
an empty draft. Suggested tasks from chats request a fresh folder explicitly,
even when a different project is open, while tasks from projects retain their
sender's folder.

## A chats location never claims an existing project — 2026-10-16

The owner's repair to #1727 makes chat identity a record of folders the host
created, rather than a property inherited from a configured parent. Selecting
an opened project, or a parent containing one, is refused in Settings, including
when the location reaches it through a symlink. Changing or resetting the
location never broadens the recorded set; previous chat allocations keep their
identity. A pre-existing folder with a dated name is still a project.

Only the latest managed chat appears in recent folders, alongside the fifty
remembered projects. Settings' folder list, History's project choices and the
Flows catalogue exclude managed chats. Startup restores a chat only with its
saved workbench, regardless of read order; an explicit folder choice made while
preferences load takes precedence. Failed starts remove only empty allocations.

The draft's folder control refreshes Git facts when mounted. Recent entries
other than the first carry unread facts, so refreshing them preserves the open
repository's known state. Suggested tasks from a source with an unknown folder
keep the open project's folder; a recorded managed chat explicitly requests a
fresh allocation.


## The Library's skills page is cards under filter chips — 2026-10-16

> Superseded by [Customize is the shared capability destination](#customize-is-the-shared-capability-destination--2026-10-21):
> the skills page is now Customize's, its chips are All and Needs attention
> with the rest under Filter, and Matrix is the Runtime comparison view.

Skills open as compact cards with All, Needs you, One runtime and Nobody chips. Chips count all listed skills, while search, state filters and Agent declarations narrow together. Cards carry the runtime reach strip and at most one problem line; Matrix and the skill page retain the detailed comparison. Add skill groups the three existing ways to bring in a skill. MCP keeps its current page. Catalogue banners appear under Needs you even when that chip reads 0: banners describe the catalogue, while chips count skills.

ToggleGroup gained a `chips` variant, and BoardCard gained `marks`, `finding`, `detailLines` and a grid. Keeping this shape costs maintaining those shared contracts and both views over the same filtered rows, using the existing finding and update selectors. Toolbar owns the controls row. Choices remain local to the viewer, history stays at the foot, and empty regions carry a short title without a description.

**Rule:** a card carries at most one problem line, and banners live under Needs you.


## Orange waits on a person; blue is unseen Team news — 2026-10-17

A Team’s orange mark means someone waits on the person: an answer, an approval, a held queue, a Flow decision or another actionable board reason. Done cards whose only reason is “nothing checked” keep that column on the Board but raise no Team attention, with or without a Run. Ready to wrap is news, so it joins unread Seat activity and ended Runs under a blue mark, cleared by opening any Team tab. The existing Goal store owns last-seen and ready times so another window, a restart and the phone agree. Overview counts the same attention list it renders and gives unchecked finished cards a quiet count and Board action; no badge can ask for an answer its body does not show.

## Starting a Team says, beside each seat, what will load — 2026-10-17

The dry run already computed, for each seat whose Agent declares skills or MCP servers, whether every declared name would load when the seat opens — but the person read it only as sentences in the problems list, away from the seat they were about, and a seat whose declarations all load said nothing at all. Now the seats section draws one line under such a seat: it counts what would load, says the runtime’s defaults where the Agent declares none, and lists only the names that would not, each in the host’s own words; a refused seat says its refusal in warning ink on the same line.

The line is a rendering of facts the host already decided (`FlowPreviewSeat.attachments`), not a second decision: it adds no problem, removes none, and touches neither `startable` nor the Start button, wherever the seats section is rendered — the Start dialog, the dry-run report on a Flow page, a trigger’s preview and a saved Run again. A declaration of kind `notes` is neither skill nor server and stays out of the line entirely.

**Rule:** a seat's attachment facts sit under that seat; the problems list still decides whether Start is allowed.


## A Team opens on its recorded Work — 2026-10-19

The owner found that Overview, Run, Flow and Timeline hid one story behind too
many choices. Work now opens with the Run's frozen graph and recent activity;
Full record expands history in place. Tasks groups Board and Findings without
changing their ledger or actions, and Chat offers combined and Split layouts.
An explicit saved destination still restores. Run history and Receipt remain
secondary destinations, and a compact chooser selects a historical Run.

Approvals and questions belong in Chat or their own conversation, backed by
one request store. Work keeps one aggregate link; Chat carries the pending
count and warning light. A Team approval names its requester and links their
conversation. The composer stays visible below the card, retaining its draft
and recipients. Requests sit at the end of the scrolling Chat thread, so all
actions scroll with the conversation and cannot be clipped in a second dock. Human
task decisions remain marked in the graph with the existing task and inspector
answer actions. The selected Agent's actual glyph identifies each Seat without
a surrounding coloured tile, and generated duplicate role names keep ordinals.

## Teams follows work; Agents holds reusable roles — 2026-10-20

The owner asked what Teams contributes beside Flows and requested the same
visual quality for Teams and Agents. Teams keeps attention, working and
ready-to-wrap work together across projects. Its cards show a concise status
instead of reproducing an entire runtime refusal; one shared issue mark and
the exact Team details retain the full explanation, which remains searchable.

Agents uses a responsive role catalogue with source filtering and search.
Purpose and actual seating facts have separate places. Source paths and
shadowed copies remain in a deliberate disclosure rather than stretching the
catalogue between groups. This presentation does not change precedence,
permission enforcement, authoring recovery or the host's seating decisions.

Superpowers specs and plans are local working notes. Both corresponding
folders are ignored and untracked at the owner's request; product contracts
and verification evidence remain in the ordinary documentation tree.

## The client is open; the hosted service is closed — 2026-10-21

**Status:** only the wire exists so far: `packages/contract` and
`packages/crypto`, with their tests. The desktop does not connect to the
service yet, so what follows about sign-in, pairing and the seam is the intent
the wire is shaped for, not something built.

The desktop is MIT, and so will be everything in it that talks to a service:
sign-in as a public client (PKCE through the system browser, a
`harnessdesk://` redirect, the token in the keychain), the desk's Ed25519
identity and QR pairing, and the encryption of relay and push messages. The
protocol is open too — `packages/contract` and `packages/crypto`, with the test
vectors the phone must reproduce. What stays closed is the hosted service (accounts, relay
and push gateway) and the iOS app. [open-and-hosted.md](open-and-hosted.md)
says what the service can see and where secrets live.

This costs the service any reliance on the client: anyone can build another
client against the open protocol, so every limit, check and expiry is enforced
on the server, and no secret ships in the app. It buys a client whose
handling of keys and tokens anyone can read, and a service that can be audited
from its wire. A closed helper process beside the desktop was considered and
not built; the desktop's cloud code will stay behind one seam so that remains
possible, and the renderer never imports the wire (`pnpm layering`).

**Rule:** the client holds no service secret and the service trusts nothing the client says.


## Desktop account sign-in uses explicit browser approval and host polling — 2026-10-24

The desktop now connects through the shared cloud contract. This supersedes
this document's earlier PKCE/redirect proposal for the desktop: the host
signs a challenge with its own Ed25519 key, opens the system browser, and
shows the same short code as the approval page. The signed-in person must
approve the named desk. A forwarded URL cannot silently link a desk.

Only the host holds the polling secret, private key and desk session. The
browser keeps its own session; neither side receives the other's secret.
After approval the host proves its key again to obtain a renewable desk
session. An OS `harnessdesk://` launch is only a focus hint and carries no
account data. The desktop's existing keystore cipher protects keys, tokens
and cached profile data, with no plaintext development fallback for this
account. Ordinary local work and agent sign-in remain independent of it.

The seat and Settings › Account show the HarnessDesk identity separately
from agent accounts. Signing out revokes only this desk and its phone links;
linked-phone removal uses the desk's scoped authority. The Reachable from
your phone switch was first only a preference; the relay transport that makes it
work is recorded under "Phones away from home reach the desk through the account
relay" (2026-11-01). LAN pairing remains separately capability-gated in Phone settings.

## Lead window controls have bounded consent, requests and retries — 2026-10-18

Plan approval grants 24 hours of consent from the host clock. This bounds how long
one person click can authorize paid work within the held policy and budget. The
window projection carries the expiry and stops offering Resume after it lapses.
A fresh plan decision renews expired consent; Resume cannot extend consent.
The renewal transition below preserves the approved scope and admitted work.

Each window continuation requests at most 4,096 output tokens. This keeps the
up-front reservation and one response bounded, including when a provider could
accept a larger request. Budget admission still decides whether it fits.

The journal retains the newest 4,096 send receipts in admission order. Recent
retries return the first receipt without appending; an evicted key is a new send.
Eviction is part of the reducer, so recovery preserves exactly the same window.

A credential update is exclusive, so a key write cannot succeed before another
category refuses. Policy and budget caps may change together under one revision
fence. Both changes are validated and their cards checked for combined projection
fit on the journal queue before either is appended; each widening still has its
own reviewable card. This supersedes the earlier one-category authority rule.

The supervisor gives a send a 180-second deadline. Three transport attempts of
30 seconds and two retry waits of at most 30 seconds fit below it. On expiry the
host kills the child through the existing exit path, records in-flight dispatches
as uncertain and parks for a person instead of leaving controls behind a paid
request. The short control journal queue never awaits that request.


## Lead consent renewal preserves the approved contract — 2026-10-18

When the host clock reaches plan consent expiry, the journal re-offers the
approved plan as the next revision of the same card. Its contract, digest,
original journal position and admitted steps stay unchanged. The renewal event
is durable and replayable; repeated reads do not produce duplicate offers.
Terminal, budget-stopped and recovery-blocked threads do not offer renewal.

The window receives `decide-plan`, never an unusable Resume. Only a fresh
revision-and-digest-bound Approve grants another 24 hours. Renewal preserves
run identities, consumed rounds, reported spend and any tighter caps applied
since the original approval. It cannot replay a start or restore an older
allowance. Stale clicks still refuse. A declined renewal is recorded once for that consent
expiry and is not immediately re-offered by the next read. The bounded per-card
revision limit also applies to renewal. When another revision would exceed it,
or its replacement cannot fit the projection, renewal creates a fresh plan card id
with the same contract digest and leaves the old card decided. Other renewal
failures leave the last durable projection readable, including Settings and key
removal. A full 64-card table blocks renewal and records one durable
`lead-renewal-blocked` wait, so the banner explains why no decision is offered.
Repeated reads append nothing further. A terminal phase closes pending renewal cards.


New journals keep each card's first journal sequence separately from its local
revision counter, so replacement preserves its inline position. Checkpoints from
before this field retain only card order, not exact interleaving with messages;
their cards share the retained suffix’s last message position (or one when it is
empty). Stable journal rendering puts the message first, then all saved cards in
their original order, before every new message. Synthetic positions never extend
beyond the checkpoint sequence. New writes and full journal replay retain exact
positions. This supersedes the earlier maximum-plus-index migration, which could
interleave saved cards with new messages.

Policy saves compare mode and rules structurally, ignoring revision alone. An edit
that leaves effective authority unchanged is still stored as a tightening; only
equal values are a no-op. Widening and mixed edits still require a decision card.
An authority-neutral edit intentionally bumps the policy revision, making a
pending plan card stale and requiring replanning.

## Lead is a named conversation with settings in Settings — 2026-10-18

Lead uses the session window's shared shell, thread, Items messages, composer,
empty state and top-bar registration. Its decisions are assistant prose with
the question and actions in the same docked ApprovalDialog a session uses.
The old bordered decision cards and settings dialog are retired. All window-only
authority, revision/digest fences, consent renewal and credential rules remain.

There is one Lead. Its host-journaled name is Dex or Lex, default Dex, with one
LeadAvatar artwork slot. Choosing a name never widens or tightens authority;
its system prompt names it without changing its tools or allowances. Name,
Provider key, Allowances and Permissions live in capability-gated Settings › Lead.
A widening save links back to the conversation for the person's decision.
Bounded decision messages retain the chosen state after the dock is dismissed.
Name-only writes return a closed name receipt without resolving a provider key
or applying a stale-revision refusal. They grant no fresh thread or authority
facts; every full read and notification projection still runs the public scan.

The shared floating dock uses the sticky elevation token (10), replacing the
session's former literal elevation (5). Both conversations now follow that same
stacking contract. The composer frame is shared, and only the active conversation
mounts its decision dock. Programmatic decision focus keeps the session's
half-second typed-through guard; a deliberate pointer press clears it through
the next focus event or half a second, whichever comes first. Lead's banners
and decisions share the session's ComposerNoticeStack and composer gap.

Lead is a conversation root for design accounting too. Its component-owned
message renderer and session Items stay in the same measured screen family.


## A person can stop the Lead goal and begin another — 2026-10-18

Stop goal is a revision-fenced window operation. It first records the journal's
stop latch, then ends the Lead request process and stops its owned Flow runs
through the existing stop path. It never merges, publishes, pushes or removes
worktrees. The confirmation states that files and worktrees are left as they are.
Terminal predecessor waits put this action in their banner; other active phases
put it beside settings in the top bar.

The next explicit message starts a new logical goal only after cancellation is
acknowledged, all provider reservations have settled and recovery has no pending
or contested attempt. The previous goal's full budget ledger remains in the
checkpoint, including unknown spend; new consent and a new plan are required.
The bounded checkpoint retains 64 completed goal ledgers and refuses a further
reset rather than discarding accounting. Old messages and decision receipts stay
in the conversation. A budget stop on a goal still running cannot be cleared by
sending a message: the person stops the goal first. From 2026-10-22 any finished
goal, accepted, declined or stopped for any reason, begins the next one behind
the same fences. Before, only a cancelled goal could, so a thread whose goal was
accepted, or stopped at its allowance, refused every message for good.

## A Lead plan that could never be accepted is refused before its card — 2026-10-22

A plan is frozen only after each step's seats are checked the way its start will
check them: the same held preview a start redeems must hold every seat at its
role's ceiling, and the reviewer's provider must be readable and different from
the implementer's. Either failure parks the Lead with its own reason
(`lead-plan-unseatable`, `lead-plan-not-independent`) and offers no Approve card.
Before this, a live sitting approved a plan with the same agent on both seats; the
implementer committed and the review never opened, because the Flow's review
must be independent and the desk could not show it was. The person had approved
work that could never reach a result to accept. The refusal crosses the child
boundary as a code, like an oversized card, so the Lead process stays live.


## A Lead plan is a flow in its conversation, and trigger consent stays in the project — 2026-10-24

The approved plan is read in execution order through LeadPlanFlow, composing the
existing Timeline and its decorative connectors. Each step names responsibility
in role words, followed by Approve to start. No graph library or parallel plan
list owns a second reading order. The same pattern is exported, catalogued and
shown in the design explorer. Acceptance checks and limits remain below it.

The person can Accept and open PR from a reviewed result. The existing card
decision, revision/digest fence and shared pending lock own that fourth choice.
Push and branch-ownership requests use the same machinery; their prose states
why publication or reclaim needs the person. A followed PR keeps its linked
number, check/review status and ownership chip visible. Repair wording belongs
only to an active hand-back round. Event origin remains a small linked fact.

Triggers is a Settings Lead section: machine follow preferences have two
independent switches, both on by default. Project declarations remain files,
listed only when opens.lead is true and described by lead.summary from preview.
Opening a row opens the actual returned file; listing it grants no arm or edit
authority. There is no unsupported messaging-service row.

Publication preflight validates the real person gates without answering them.
The final journaled decision answers them only after publication completes;
otherwise the board change could invalidate the very card authorizing the push.
Writer-queue guards also ignore delayed child result invalidation during
publication and an old acceptance wait after the goal enters following. Origin
metadata carries the event action and repository subject; delivery identity stays
in the private origin key. The offline rig covers these races and ordering.

A delayed child refresh cannot replace or restore the result protected by a
publication that has started, including completion before its final decision.
The expected stale offer returns through IPC without ending the management
child. A new validated hand-back starts a fresh no-progress window; total round
limits, existing findings and stops remain in force. Person acceptance does not
consume the repair's chance to produce new evidence before independent review.

Host shutdown preserves a repair already waiting for CI as well as prepared or
running hand-backs. Its published head and unanswered acceptance round must
survive restart so a later green observation can offer the reviewed result.
Preparing a same-Team repair retires the owned run's earlier terminal observation
before the host opens its next round. Recovery then retains that authorized
reopening instead of contesting it as foreign work. Shutdown freezes usage reads
before their sources disappear; a new host rebuilds those readings before it can
admit work.
## Every git write goes through one gateway, and the host holds the credential

`Detached default PR selection belongs to the creating conversation.` When a detached conversation omits a PR number, view, checks, review and comment select only its intact successful creation records in the current pinned repository. Every recorded candidate is fetched explicitly and must retain its creation head; exactly one open match is required. Ambiguous or unavailable evidence requires an explicit number. Selection survives a host restart for the same runtime/session and does not transfer to another conversation. Attached and explicit selection retain their existing meaning, and detached PR updates remain refused. The host and repository remain pinned through the associated reads; lookup grants no write authority. The journal snapshot is serialized with repository work; network reads do not hold up other repository writes, and an interrupted caller schedules no further candidates after its current bounded read.

The git-gateway design reverses the shell-reach part of
[A pull request is published through the desk](#a-pull-request-is-published-through-the-desk-and-the-desk-signs-it).
A worker controls its checkout's remotes, URL rewrites, hooks and credential
configuration. Running a publication command there as the person lets worker
configuration select where the person's authority goes. One host engine now
serves Lead and Git plugin writes: it imports reviewed objects into a private
mirror, pushes to a host pin with a lease, and runs forge writes from host
state. Credentials are consulted by a host helper outside the worker. The
plugin retains signature composition and transcript references, through its
`forge: { publish, write }` capability. Ambient forge reads still use `shell`
and the person's gh login; moving the gateway credential is not a claim that
all agent-shell credentials have been isolated.

Steering needs three layers because no runtime guarantees a pre-execution
look at every native command. PATH stand-ins catch ordinary shell commands;
login-shell parsing and zsh profile shims preserve that route on the measured
surface. Native approvals and the Claude bridge's pre-tool callback supply
another opportunity. Completed concrete commands report afterward what
the earlier layers did not see. These are tested against fake runtimes, including a real login
shell and the bridge's SDK callback, not real vendor endpoints.
Generic ACP steering currently isolates a worker per conversation because the
protocol has no negotiated per-session shell environment; preserving caller
identity takes precedence over process sharing until that channel exists.

An outside head is never attributed. A commit's author is not its pusher,
and a command's exit code is not proof that a particular SHA reached a
particular remote. Only an intact successful gateway entry supports
attribution. Person-allowed own git triggers observation of the pinned remote
and remains outside. The outside-recording switch covers those observations
as well as other fetched outside heads; gateway writes remain recorded.

Five decisions settle it:

- **D1:** Ask each time is the steering default.
- **D2:** New branches and every rewrite ask; owned fast-forward updates can
  proceed without another push question. A matching steering approval can
  also approve the first push, but never silently approve a rewrite.
- **D3:** The host executes every gateway write and holds its credential
  path. Plugins receive forge verbs, not an executor.
- **D4:** The first approved push pins the repository per project; a worker
  origin cannot replace it.
- **D5:** A global setting has a per-project override.

The record journals before effects and hash-chains its physical lines. It is
kept in host state, not in a worker-controlled checkout. Interrupted forge
writes are not replayed blindly; recovered pushes require the matching remote
head and a recorded successful outcome before the Lead can adopt them.


## Lead probes its child runtime, and the desktop bundles a Node LTS for it — 2026-10-26

Lead's restricted child runs with `--permission --no-allow-net` and must never
start with network access. Which runtime runs it is decided by a capability
probe, not a version number: each candidate is started with the Lead's exact
flags and environment and tries a loopback TCP connect. Only a refusal by the
permission model (`ERR_ACCESS_DENIED`) passes; a connect that goes through, a
rejected flag, a crash, a mismatched version or a timeout fails with a short
reason, which the settings projection carries as `unavailableReason`, the
conversation shows, and the host logs once. Results are cached per binary path
and version.

**Why a probe.** A major-version check says what a release promised, not what
this binary does: Electron's Node, a distribution's build and a future release
can each differ from upstream at the same major. The probe asks the one
question the Lead depends on, network blocked by the permission model, of the
binary that will run it, and its answer is also the reason shown when it fails.

**Why a bundled LTS.** On the desktop the child ran under Electron's own Node
(`ELECTRON_RUN_AS_NODE`), and Electron 42 ships Node 24, which rejects
`--no-allow-net`. The app therefore carries an exact Node 26 release for this
child alone, fetched from nodejs.org at pack time, checked against a SHA-256
pinned in `packages/desktop/electron/lead-runtime.mjs`, and signed with the app.
Electron's own runtime is still probed first; the bundled copy is used only
when it fails, and goes away once the minimum supported Electron passes. Node 26
becomes LTS on 2026-10-28 and is supported until 2029-04, which covers the
releases the app will ship before Electron's Node catches up.

**Why not Node 25.** It has reached end of life. Bundling or testing on it would
pin the app to a runtime that receives no further fixes.

**The desk handoff.** Node 26 refuses a socket built on an inherited descriptor
above 2 without a network grant, so the desk no longer arrives as fd 3: the
child asks over a Node IPC channel, receives the connected socket as a handle,
and both sides close the channel. Anything else on that channel ends the child.

CI exercises the child and its probe with Node 26. The package's Node 22.19
floor remains unchanged and other CI jobs exercise Node 22.

**Rule:** gate the Lead's child on the probe's answer for the binary that will
run it, never on a version number; never start it on a runtime that failed.

## Account identity and LAN phone pairing have separate lifetimes — 2026-10-25

The account service stores a sealed identity per service origin and signs in
through explicit browser approval of a named desk and matching code. Account
sign-out revokes this desk; account deletion removes the account after its own
confirmation. Both clear the local sealed identity only on the documented
success or revoked-credential paths. Offline deletion keeps it for retry.

LAN pairing uses `phone-link/`, a code that works once for ten minutes and
approval on the desk. Settings › Phone is present only when that service is
enabled. Pairing needs no account link; account sign-out and deletion leave
that registry intact. Reachable from your phone opens the relay connection
only while signed in (2026-11-01). These separate lifetimes keep each
operation within the connection the person chose.

## Phone sessions page the desk index and reuse its controls — 2026-10-27

A live audit of a populated desk found 198 active ordinary conversations but
only 80 in the phone's workspace snapshot. The native phone had no way to ask
for the next page. The snapshot also advertised ordinary-session start, reply
and stop as unavailable, even though their native surfaces already existed.

Keep the compact snapshot for capabilities, Teams and recent work, and page
the index separately for complete active and archived session coverage. A
workspace change invalidates those pages. The phone fences refreshes by the
connected desk, retaining its last good copy on a temporary read failure.
Team-owned sessions stay with their Team; archived conversations are readable
without acquiring mutation authority.

The three ordinary-session controls reuse host session creation, turn send
and interrupt, under the phone's Run grant. They never open the general
renderer wire or grant a new permission level. Hidden composer defaults must
not overwrite a conversation's model or permissions. Starting follows the
desk's selected runtime and resolves a displayed project name only among
admitted folders; a name that identifies two folders refuses instead of
guessing. Answer remains a separate grant for approval decisions.

## Lead is one conversation and ordinary tasks use ordinary chats — 2026-10-28

The owner asked for a Lead that feels like a single ongoing chat and manages other chats, using Dot, Duet and Muse as product references. The previous unconditional plan-first instruction turned even a screenshot request into reviewed software work. Repeated proposals failed seat or review-independence checks; Resume repeated the same request, while the phone hid both reasons behind a generic wait.

Lead now answers directly and uses narrow project-scoped ordinary chat operations for simple delegated tasks. A reviewed plan remains available when software work needs formal independent review and acceptance. Its approval, held permissions, consent, budget and publication boundaries remain in place; ordinary session delegation does not claim that review or borrow its authority. Ordinary chat spend remains separate from the reviewed-run allowance, explained in its controls.

The host checks every ordinary chat against canonical project membership, actual cwd, current policy and recovery. Starting uses saved session settings; queued replies, interrupts and approval handling remain the existing session paths. The child receives no shell, file, permission-setting, approval-answering or publication primitive. One durable allow attempt admits each ordinary mutation, and the host consumes it once, including refused admission. Trusted host receipts distinguish a preflight refusal with no effect from a genuinely uncertain dispatch; only the former permits a fresh corrected attempt. Other chat transcripts remain untrusted observations. Listings and recent transcript reads also have an encoded byte budget; partial reads report omitted turns instead of becoming tool refusals. Queued Lead messages retain their project and policy guard through to the actual send, including after a reopen; a changed target pauses the queue.

Tracked chat state transitions are metadata, scoped and reauthorized by the client door. A bounded subscription baseline covers changes during a disconnect, and the model's wake gate coalesces them. Conversations are not Flow runs and never appear as fabricated reviewed results. Setup failures show the change needed and leave chat usable; transient interruptions may offer Resume. A new message includes trusted feedback about the prior rejected plan so that the model can correct it. Direct conversation turns do not park an unrelated approved plan for failing to start it.

The screen, composer and navigation stay familiar. An ordinary active reply has its own Stop control; a finished reply leaves no planning banner. This supersedes the universal plan-first behavior, not the reviewed workflow's admission rules.

## An earned description can take a narrow row's full width — 2026-10-29

In the narrow Team Overview, the face and trailing control left a descriptive
line with too little reading width. `ListRow` now offers `subtitleLayout="below"`:
the face, name and control share a centred heading, followed by a description
across the row's inner width. Narrow Overview seats use this composition for
their role, work or unavailable reason. The shared list catalogue shows the
same option. The face centres on the heading, keeping it beside the name even
when the description wraps; ordinary rows retain whole-row centring. Metadata
follows the description at full width, and both row sizes keep a line gap.
The browser regression measures visible word ranges at 240, 280
and 320px preview viewports in both themes, including clipping and overflow.

## CI is dealt from manifests and measurements, not hand-carved jobs — 2026-10-30

Measured over 200 CI runs (2026-10-21 to 10-30, 42,000 runner minutes), and
the failure logs of the 128 jobs that failed in them:

- **Every pull request waited on one file.** The Lead end-to-end file's 31
  cases ran in series for 21-29 minutes while every other job finished in
  eleven. Profiled locally, 65% of a case was the host starting git: about
  12,000 processes in 94 seconds, mostly re-asking which repository the same
  few folders belong to, and re-reading one commit's checks file 313 times.
  The host now asks `rev-parse` once instead of three times, reuses a
  checkout identity it has just read for that same folder, keeps a project
  answer for a second while its folder is still where it was, and keeps reads
  of immutable objects. The same case went from 116 to 64 seconds; the desk a
  person runs does the same work less often. The largest source left was every
  evidence reader asking where each fact's branch stands. A branch's tip is now
  asked again only once a file its ref is kept in has changed — the loose ref,
  `packed-refs` or a reftable list, marked by `stat` and trusted only once it
  has been still for longer than a filesystem tick — and how two commits stand
  is kept per repository (`evidence/tips.ts`). That case now starts about
  4,250 git processes in about 55 seconds, against about 6,300 in 64.
- **Node tests are one manifest.** `script/node-tests.mjs` names each group —
  unit, Node end-to-end, retention, the Lead's, the Lead's end-to-end — with its
  per-file deadline and runtime, and deals the files into jobs of about five
  minutes by `script/node-test-durations.json`. Verify, `pnpm test`,
  `check:push` and CI read it; the `find … ! -path …` list kept in three copies
  is gone. The Lead end-to-end cases are four files. Every job reports with
  `spec`: on Node 22 the default TAP output left 19 failed jobs in nine days
  without the failing test named anywhere in the last 5,000 lines of the log.
- **The full tier's two themes and its recording belong to main and
  development.** Every one of the 21 dark-theme failures of a geometry spec
  in those nine days came with the same case failing in light, and a
  recording made on a batch branch, a `full-ci` run or the release pull
  request was never saved (only main and development keep the map). Those
  runs still read every spec, in the pull-request matrix, on the built pages:
  14 shards instead of 17 instrumented ones. The nightly run and main pushes
  keep both themes and the recording.
- **A tree is proven once.** A batch head's full run tested the merge of its
  branch into `development`; squash-landed onto a `development` that had not
  moved, the push is that same tree, and it ran the reached browser specs
  again (40 pushes, 2,000 runner minutes in nine days); a release pull
  request's full run and the `main` push after it did the same at 480 minutes
  each. A full run that passes every part, the whole browser suite and native
  smoke included, now uploads a `proven-tree-<tree>` artifact, and a push to
  `main` or `development` whose tree has one from this repository's own
  branches runs core CI only. The nightly run never reads a proof.
- **CI runs the dealt UI unit suite.** A related selection took as long on one
  runner as the four dealt shards (p50 4.8 against 5.1 minutes, p90 8.7
  against 6.7). Local `check:push` still uses it, where a laptop is the cost.

**Rule:** a job's contents come from a manifest and the last measurement, never
from a list in the workflow; a check that never finds anything another check
does not is measured, then removed from the place it costs most.

> Superseded in part by [A checkout root's project answer stands while what git reads to give it is unchanged](#a-checkout-roots-project-answer-stands-while-what-git-reads-to-give-it-is-unchanged--2026-10-31):
> the one-second window is gone; a folder can join or leave a repository
> without moving.

## Full CI label admission — 2026-10-30

A label worker rechecks the live pull request and can reuse a matching PR run
created no earlier than the latest full-ci label application only when that run
has generated a matching full-tier marker. A queued or running marker counts
while its workflow is active; a completed marker must have succeeded. If a
matching active run has not generated a tier marker, the worker waits up to six
ten-second intervals for selection, refreshing runs and jobs each time. API
calls add their own time; an API failure still fails immediately. A bounded or
inactive run does not earn that wait, and an exhausted wait keeps the normal
dispatch. The final live PR check still follows the wait. This avoids admitting
an old or bounded event snapshot; the marker is admission evidence, not a claim
that CI passed. A push
can still move the branch after the recheck, so this is not atomic deduplication.
Events have second-resolution timestamps; a labeled and unlabeled event in the
same second are ambiguous, so the worker treats removal as latest and dispatches.
The same-repository-only `pull_request` workflow checks out the immutable event
merge commit (`github.sha`) so its helper is present before the PR is merged.
This keeps the existing fork condition and actions write permission; it does not
use `pull_request_target` or expand the workflow's trust boundary.

## A click on a result the Lead took back is made when that same result returns — 2026-10-31

The Lead withdraws every undecided result as soon as an observation that may
change it arrives ("invalidate first"), and restores or re-offers it once it
has read the desk again. A person's click that landed in between was refused
(`lead-card-stale`, `lead-card-decided`), though the result came back exactly
as it was. With the host's reads faster, the Lead publication end-to-end cases
hit that window on most runs; a person hits it as an accept that fails for no
reason they can see.

The fence stays: nothing is decided while a result is withdrawn. The journal
remembers, in memory only, which results an invalidation took back while
undecided. A refused click on one of those waits, outside the controls queue,
for that same card — same id and revision, so the same contract and evidence —
to be offered again, then is made on it; a new revision, the card gone, or no
return within `LEAD_REOFFER_WAIT_MS` (fifteen seconds) is refused as before. A
card a person decided is never waited for, and a click whose publication began
is never made twice: an invalidation is fenced while a publication is in
flight. Not invalidating on quiet events was rejected: whether an event
changes a result is only known after the read the fence exists to wait for.

The same refusal came from a second writer. Once a repair's CI passes, the
host offers the result itself; the Lead loop, not having offered that card,
offered an identical one at the next revision (only the summary line and
bookkeeping revisions differed), so a click on the host's card was refused.
The loop now takes a stored result whose contract, evidence and spend are
exactly what it read as the current result — unless it has itself seen that
card stand for other evidence, so a result taken back while its evidence
moved away and back is still offered afresh.

**Rule:** a refusal says something changed; when nothing did, the click stands.

## A checkout root's project answer stands while what git reads to give it is unchanged — 2026-10-31

The one-second window `projectOf` kept an answer for, on the folder's real
path alone, was wrong: a folder can join or leave a repository without
moving. A lane folder torn down mid-read, or a directory a checkout is then
made in, kept its old answer, and the Lead publication end-to-end cases
decided a result card against it and were refused (`lead-card-stale`,
`lead-card-decided`) — in CI on most runs once the reads around them got
faster. The window was removed (`4081d37`); only callers asking at once share
an answer.

Asking afresh every time put `projectOf` back at about a fifth of a Lead
run's git processes. A folder that is the root of a checkout of its own (a
project, or a Team's worktree) now keeps its answer while a stat mark reads
the same, and the mark is read on every call: the folder; its `.git`, a
directory or a `gitdir:` file read whole; that git directory and its
`commondir`; the common directory with the configuration that can move or
empty its working tree (`config`, `config.worktree`); and the answer's own
`<root>/.git`. Directories and pointers are marked by identity and text, a
configuration file by identity, size and times, and one changed within
`RACY_MS` of the read vouches for nothing — the parts and the rule are the
ones `tips.ts` marks a branch tip with. The folder's side is read before git
answers and must agree after, so a checkout made meanwhile is not marked as
it was. A subfolder, a folder in no repository and a folder that has gone are
asked every time. `repositoryRoot` no longer asks for the origin it discarded.

Measured on the Lead end-to-end case `the model gets one standing text…`,
with every git process counted: without a cache, `projectOf` started about
4,600 of its 7,800 git processes and the case took 90–97 seconds; with the
mark, it started 26 of 3,300, in 65–69 seconds.

The faster host also showed the Lead publication cases racing the Lead
itself: the Lead withdraws a result on every desk event that may change it and
offers it again, so a click on a result card read a moment earlier was
refused. That is a person's race too, and is fixed in the Lead, not the test
([a click on a result the Lead took back](#a-click-on-a-result-the-lead-took-back-is-made-when-that-same-result-returns--2026-10-31)).

**Rule:** an answer about the filesystem stands on a mark of exactly what was
read to give it, read again on every use, never on time or a path alone; a
mark too new to tell the next change from is no mark.

## The popup contracts are captured once and checked many times — 2026-10-31

The 73 `frame-*` contract specs took about 414 of 653 recorded test-minutes in
the full matrix and 103 of 270 in the pull-request matrix
(`e2e/ui-system/durations*.json`). The eight `frame-contract-popup-*` specs
were the largest family, 7,600 and 1,240 seconds. Each of their tests opened
one wall destination at one width in one theme and measured its popups. Of the
3.3 seconds a test took on built pages, opening the preview was about 2.2:
every test's fresh context fetched and ran the 9.8 MB bundle again. Measuring
was 0.2–0.5 seconds of round trips, and a dark test rendered the same geometry
a second time.

They are now captured once and checked many times:

- **One render per destination and width.** A test takes a batch of up to ten
  destinations at one width through one page, so the bundle stays in the HTTP
  cache and a load takes 0.8–1.4 seconds. Nothing else carries over between
  destinations: an init script empties local and session storage as each
  document starts (the app writes drafts on `pagehide`, so clearing before
  navigating is not enough), and the app keeps nothing in IndexedDB or
  cookies. The preview fixture's route turns the cache off, so it is installed
  only for a destination whose document asks for the local preview, which is
  then staged again with it.
- **One read per theme.** `frame-contract-popup-snapshot.ts` reads every
  visible popup in one evaluate, then switches the page to dark in place (the
  body attribute, `color-scheme` and the emulated media, with colour
  transitions finished) and reads again. A destination with no popup has
  nothing to read in dark and is not switched.
- **The rules are pure functions.** `frame-contract-popup-rules.ts` holds the
  C10 assertions with their messages and runs over each reading in Node. The
  four locator helpers other frame specs call now read a surface once and call
  the same rules, so there is one copy of each. `popup-contract-rules.spec.ts`
  breaks each fact of a synthesised snapshot, 90 cases, and expects the rule
  to name it; it starts no browser.
- **A failure still names its destination and width.** A batch carries on past
  a failing destination, attaches that destination's snapshot, and fails at the
  end naming each one. The width stays a dimension of its own.

What licenses it was measured on built pages, two workers:

- A reused page reads what a fresh context reads: 576 of 576 destination-widths
  produced identical snapshots.
- The switched page reads what a dark load reads: 135 of 135 popup readings
  were identical. `popup-theme-switch.spec.ts` keeps six destinations, one of
  every popup kind and ink, on that comparison.
- The rules catch what the live checks caught: 20 CSS mutations of plates,
  rows, labels, hints, icons, separators, groups, notes, trailing values,
  chevrons, info cards and inks, across the 45 popup destinations at 1440, and
  the unmutated page. Old and new failed on exactly the same destinations in
  945 of 945 cases; every mutation was caught by both.
- Time, the popup family: the pull-request matrix went from 1,596 to 1,000
  test-seconds (809 to 509 seconds of wall time) while gaining the dark ink
  it never read; the full matrix's light and dark runs, 3,232 test-seconds,
  are the same 1,000.

Geometry is now read in light in every matrix; the 2026-10-30 measurement found
dark geometry caught nothing light did not. Dark ink is read from a switched
page rather than a dark load, which holds while the theme is CSS: a popup that
chose its colours in script would break `popup-theme-switch.spec.ts` first.
The durations tables scale the family's recorded times by these local ratios
until CI records them.

**Rule:** a frame family is migrated by giving its rules pure functions over a
reading, proving each fails as the live check did, and adding its reads to the
same visit. The families that open the same wall destinations (the leads, page
layout and navigation) are next, and are where one visit per destination pays
most.

## The non-work window leads are captured once too — 2026-10-31

The B10 lead contract — a non-work page titles itself in its content column,
and the bar's fixed lead carries exactly the window's controls — was the
next-largest frame family: 4,277 recorded test-seconds in the full matrix and
805 in the pull-request matrix, over three window states (sidebar hidden at
1440, 720, sidebar standing at 1440). Each of its 456 tests loaded two
documents in a fresh context: the work conversation, for the place origin
every non-work lead is held to, then the destination.

It now runs the way the popup contracts do
(`frame-snapshot-batch.ts`, shared by both families):

- The work conversation's origin is read once per batch of ten
  destinations, and each destination once, through one page.
- `frame-contract-leads-snapshot.ts` reads the lead. The live check waited
  before most assertions — for a title to leave the bar, the lead to gain its
  buttons, a long title to find its room — and each wait is kept under the
  same condition and deadline; only the assertion moved, to
  `frame-contract-leads-rules.ts`. `expectLead`, which the B6 work leads
  still call live, reads and checks through the same rule.
- It is geometry, so it reads light only, in every matrix: the decision of
  2026-10-31 above, accepted by the owner for this family as well.
- `lead-contract-rules.spec.ts` breaks each fact of a synthesised reading,
  21 cases, and expects the rule to name it.

Measured on built pages, two workers:

- A reused page read what the old test's fresh context read (the
  conversation first, then the destination): 228 of 228 destination-states
  and 12 of 12 batch references were identical.
- Old and new failed on exactly the same destinations in 1,140 of 1,140
  cases, over the unmutated page and CSS mutations of the title's column edge
  (caught at 70 destinations in each state), a hidden title (70), a missing
  Back control (50; Settings carries none) and the bar's height (the 26
  Settings pages).
- The branch that holds a bar title to the work origin and its title room is
  reached by no destination today — all 76 title themselves in a column, six
  of them canvases — so neither version asserted it on the live app, and
  mutations of the place and the title changed nothing in either. Its rule is
  held by the synthesised cases alone, and runs when a destination reaches it.
- Time: from 1,070 test-seconds (the old light half, what a pull request
  read) and 2,116 (both themes) to 368; wall time for the whole family went
  from 1,067 seconds to 190. The durations tables scale the recorded times by
  these ratios until CI records them.

## Repeating Lead work keeps the approved contract, one run at a time — 2026-10-30

Recurring work should not need the same plan approval every week. A repeat therefore lives in the existing schedule store, carrying the approved digest-bound contract and per-run caps. The repeat field belongs to the approval scope. Each slot mints fresh goal, contract and step identities, budget and consent, and rechecks the same project, policy, source and seat constraints as a person-approved start. A changed fact returns a plan card with its reason. Legacy Settings tasks retain their plan-per-run behavior. Publishing, merging and deleting keep their own consent on every run.

A slot is skipped when paused or while work remains open; it never queues. Missed slots while asleep coalesce to one run on wake, held by quiet hours. Stop retains history, and Run once now requires an idle Lead. The last 12 run records include the terminal outcome and known spend. A second schedule store, replaying every missed slot, carrying old consent into a new run and giving the Lead repeat controls were rejected because each would make either ownership or authority less clear.

## A worker stop can receive one host second look — 2026-10-30

A named issue or pull request may have cleared since a worker stopped, and a completion claim can lack check evidence after its last edit. The host may act once on such a stop using facts it can prove. A cleared blocker resumes owned work through the existing recovery path within the same approved step and allowance. Missing evidence produces a steer on the existing worker path. One journaled Second look entry records Said, Found and Did; a failed or inapplicable intervention leaves the ordinary person wait. The wake gate does not reawaken the model for a handled stop.

Model-inferred blockers, repeated retries, a second start of an already started step and counting worker output as a required person-run check were rejected. They would confuse claims with evidence or add authority. The untrusted Said text is bounded and sanitized when rendered.

## The last fifth of a Lead allowance finishes the approved plan — 2026-10-30

Known Lead and worker spend reaching 80% produces a journaled At 80% entry with the observed figure and unchanged hard stop. A desk conversation message tells the Lead to finish only what its approved plan needs and leave additional review asks in the result. Standing instructions remain stable throughout the goal. A higher dollar cap re-arms the warning for its own threshold. Unknown, stale, partial and ambiguous spend produce no warning figure.

Raise limit… is a person-only direct caps update in the shared Dialog. It can increase dollars, rounds or both and preserves an existing stop latch. The raise belongs to its goal: the next goal starts from the caps in force before it, and a fresh approval of a stopped repeat turns that repeat back on. A second Lead approval card for the person's own choice, changing the standing prompt mid-goal, estimating unknown spend and automatically clearing a stopped goal were rejected: none is needed to make the remaining allowance useful.


## Worker approvals can be remembered for one Lead goal — 2026-10-31

“Yes for this goal” is a person's decision through the authenticated window or
paired-phone answer path. The host persists an exact key bound to the goal-start
sequence and approved contract. Child RPC and worker clients have no save or
revoke operation; the worker-approval permission floor remains in place.

Commands never receive a reusable key because repository configuration and gitfile indirection can make even read-looking commands execute worker-controlled programs. A check before execution cannot prevent a worker changing that configuration or indirection between the check and the run.

File rules match one exact absolute path for an add or update under the approved
project. The closed source/document extension allowlist is: `c`, `cc`, `cpp`,
`cxx`, `h`, `hpp`, `cs`, `fs`, `go`, `rs`, `java`, `kt`, `swift`, `m`, `mm`,
`py`, `rb`, `php`, `js`, `jsx`, `ts`, `tsx`, `css`, `scss`, `sass`, `less`,
`html`, `htm`, `vue`, `svelte`, `md`, `mdx`. XML, Kotlin scripts and SVG are
excluded because they commonly define builds or carry executable content. JSON,
YAML, TOML, lockfiles and shell scripts are also outside this list.

Eligibility is checked on the path relative to the approved project, allowing a
project itself to live below a dot folder. Every relative segment must be plain printable ASCII (U+0020–U+007E). This prevents Unicode-equivalent instruction and build names from borrowing a source-file key on filesystems that fold those names. The key, checkpoint admission and fresh path check enforce it; the project root itself may contain Unicode or dot folders. No relative segment may start with a
dot, or name a `script`, `scripts`, `bin` or `hooks` directory (case insensitive).
Basenames use the lowercase rc-file pattern `^\.?[a-z0-9_-]*rc(\.[a-z]+)?$`, except short ordinary source stems of the form `<letter>rc` (such as `src.ts` and `arc.ts`). This exception follows the explicitly required source-file acceptance cases, which the general rc pattern also matches. Basenames also refuse `*.local.*`, `*.conf.*`, `conf.py`, `*.config.*`,
`*.setup.*`, `*.workspace.*`, `*-config.*`, `gatsby-*`, `*.gradle*`, `ember-cli-build.js`, `sitecustomize.py`, `usercustomize.py`, `*.gemspec`,
`*.podspec`, `package.json`, `Makefile`, `Dockerfile`, `pom.xml`, `Package.swift`,
`build.*`, `setup.py`, `setup.cfg`, `conftest.py`, `noxfile.py`, `tasks.py`,
`fabfile.py`, `manage.py`, `Rakefile`, `Gemfile`, `Podfile`, `CMakeLists.txt` and
`meson.build`. Agent instructions (`AGENT.md`, `AGENTS.md`, their dotted variants,
`CLAUDE.md`, `GEMINI.md`, `WARP.md`, `QWEN.md`, `CRUSH.md`, `INSTRUCTIONS.md`, `RULES.md`, `SKILL.md`,
`copilot-instructions.md`, `CONVENTIONS.md`) are refused in any case. Ordinary
names such as `resource.ts`, `source.ts`, `profile.ts`, `profile.test.ts`, `profile.spec.ts`, `profile.component.ts`, `profile.service.ts` and `file.utils.ts` remain eligible. Runner stems are explicit: `gulpfile`, `gruntfile`, `jakefile`, `pnpmfile`, `brocfile`, `noxfile`, `rakefile`, `taskfile`, `dangerfile`, `cakefile`, `guardfile`, `makefile` and `webpackfile`, followed by zero or more alphabetic dotted variants and a `js`, `ts`, `mjs` or `cjs` extension, are refused (case insensitive). This includes `gulpfile.babel.js` without treating every source name ending in `file` as a runner. The implementation
is `LEAD_APPROVAL_FILE_EXTENSIONS` and `safeFile` in
`packages/protocol/src/goal-worker-approval.ts`.

Only regular existing files with one hard link, or new files with an existing
regular directory parent, qualify. Symbolic links below the project root,
multiple paths, deletion, movement and root grants do not qualify. The host
rechecks paths and link counts at each use; a background process can still swap
a link after the check and before the runtime applies the change.

Tool permissions match the exact trusted `flowBoardTool.tool` in the closed read
set: `list_intents`, `get_context`, `get_team_status`, `review_candidates`,
`list_findings`. Permission summaries cannot prove tool identity. Rationale,
extra grant facts of any kind, filesystem/network scope, gateway questions and
held requests exclude reusable keys. Extra permissions and network context are
normalized to labeled display facts on the ordinary approval card and on the
Lead's complete one-time request. Questions, elicitations and stdin never get a
key. Targets and paths containing Unicode control, format or line/paragraph
separator characters are refused.

Audit traffic never enters the conversation message window or the Lead's prompt.
Each rule keeps its exact acknowledged-answer count; file rules separately keep
newest-first entries containing the answer number and exact diff (including an
empty diff). Each diff is limited to the card's 8,000 characters. History retains
at most eight entries and 32 KiB of UTF-8 JSON per rule, with a 256 KiB goal-wide
cap; oldest entries drop first and never change the count. Tool rules retain no
diffs. Revocation disables matching and moves the rule to read-only revoked history, retaining its entries under the same bounds and shared 128-rule limit. Terminal decisions and a new goal clear both active and revoked history. An unfenced contract change also clears them; a fenced contract change retains revoked history and the audit wait. A renewed grant for the same target has a new id.

The conversation derives one host notice line per active used rule, updating it
in place with its count. View changes belongs to the saved rule's row and
opens retained entries newest first in the shared Dialog. These values pass the
transcript text sanitizer and never appear as assistant prose. A dispatch intent containing the exact bounded request is journaled before answering, and admission is checked again after that write. Acknowledgement writes history and count, clears the intent and restores the prior phase. An unmatched intent persists across checkpoint and journal replay as `waiting-for-user` with `lead-worker-audit-failed`; neither another automatic answer nor Resume can bypass it. The person inspects the worker changes and revokes the uncertain rule through the Answer-tier path before Resume can continue. A response failure also leaves the intent uncertain, without claiming an allowed answer or incrementing its count. A failed writer must first be restarted; the durable intent retains the fence. Live revokes of missing or already revoked ids fail without an append, while historical replay remains lenient.

Strict checkpoint loading drops structurally valid but obsolete rules with one
host removal notice, rather than refusing the whole checkpoint. Other malformed
state remains an error. Former command keys are recognized only for removal;
legacy use records retain counts without inventing missing diffs. Retained
round-one diff notices migrate into file history and leave the message window.
Journal authentication checks the original stored record before migration.

Saved approvals and read-only revoked history use a plain Rows/Row list; revoked rows show a Revoked chip and keep their diff reader without a Revoke control. Active rows use secondary Revoke controls and the
dock's shared busy state. Revocation and automatic admission share the journal
writer queue. Entering Following ends all saved authority by moving active rules
to revoked history. A dispatch present at that boundary becomes an uncertain
history entry and latches `workerAuditWait`; a later repair must ask again.
Accepted, declined, stopped and fresh or repeated goals discard active rules and
history. An unfenced approved contract change does the same. A fenced contract
change retires every key, retains uncertain diffs (including their original
contract digest) and orphan receipts, and keeps the audit-failed wait. A pending plan suspends automatic
answers. Strict journal and checkpoint parsers retain only the closed keys;
obsolete keys are removed rather than widened or reinterpreted.

A durable worker-approval dispatch keeps the live phase while its answer is in flight. Its own acknowledgement or proven cancellation resolves it. Any other journal record following that unresolved dispatch proves the answer was unacknowledged and records the audit wait, even when Revoke removes the dispatch. Reopen/checkpoint loading applies the same fence when the dispatch is the final record. Resume after Revoke is therefore a durable person decision, and older dispatch/revoke/resume journals remain readable. File rules that become ineligible retain inert metadata and bounded audit history, so a historical unfinished dispatch still exposes its uncertain diff. A checkpoint that already discarded the key retains a bounded host observation and private dispatch receipt; a matching acknowledgement or cancellation clears the uncertainty, while the person may inspect and Resume an unacknowledged observation.

The reducer applies `fenceLeadWorkerDispatch` before any non-settling successor
of an unresolved intent and after every later record. Live answers, the disk
writer, replay and checkpoints share that function, including repair hand-backs
that reach passive following. Following retains audit history; terminal person
decisions and a new goal retire it. New revoke records carry `auditFailed: true`
when they remove an uncertain intent, retaining an explicit Resume requirement
through same-contract renewal. Unmarked historical revokes retain the old renewal
semantics, so a start admitted by a valid older journal remains readable.
Repair refreshes compare the fenced state before appending and are idempotent.
Neither a plan proposal nor approving its revised contract resolves a worker
audit. Known acknowledgement or proven non-delivery settles its own pending
intent; once authority has retired, Resume continues after inspection. An orphan
requires the explicit Resume action, never implicit resumption by ordinary chat.
Terminal decisions and a new goal end the audit wait. All non-read,
non-cancellation execution remains refused until the wait has resolved.

## Lead message provenance is verified and chat control belongs to the person — 2026-10-30

A sender label is text anyone can type. The host composes the Lead envelope and
records its exact digest; only a matching record earns `Sent by <name>`. An
unknown envelope stays folded context. Failing closed loses a label, not a
boundary. The envelope keeps the name at send time, so a later rename never
rewrites an old sender.

The host checks chat holders at Lead send and stop admission and at queue
delivery. A prompt is advice; a host refusal enforces the person's decision.
Take over removes waiting Lead messages and preserves the person's queue.
A message already dispatched to the agent may finish, as with the person's
ordinary queue. A take-over installed during admission wins before dispatch. Hand back sends nothing and the Lead reads
the chat on its next activity wake.

Only the button takes over. A person's message is not a hand-over: they can add
a word to the Lead's work without ending its hold. The composer stays usable
under either holder. These controls grant no permissions, approval answers or
Flow authority.

The host keeps up to 32 verified envelope keys per chat. Older Lead messages
fall back to the folded “Lead message from …” context block. On the phone, a
mixed message containing both Lead context and ordinary user content drops the
Lead label rather than attributing the whole message to the Lead.

A chat the Lead starts is named by the first line of the Lead's words, not by
its envelope label: the label is the same on every chat the Lead opens, so a
list of them read "Lead message from Lex" five times. The label stays the name
only when the Lead sent no words; headings, bullets and emphasis marks are
dropped and the title is clipped at 200 characters. The phone's session list
marks a chat whose holder is the Lead as the Lead's (`startedBy: 'lead'`, `by`
its name). That is the holder, not who opened it: a person's own chat the Lead
sends a follow-up to is held by the Lead until Take over, the same fact the
desk's composer notice shows, and a chat the person took over reads as theirs
again. The Lead is told that a new chat's first line is its title, so it opens
a brief with a short task name rather than with context.

Control records retain up to 64 chats per project; person holds are never
evicted. An invalid record fails closed for every Lead send,
stop and queued delivery until the person confirms **Reset chat control** in
the composer notice. That explicit reset clears all projects' holds and
verification keys; no read or Lead operation repairs the record. Missing
records alone mean no holds. While the host runs, a synchronous in-memory
person hold survives disk failures and is checked at the actual dispatch
boundary. Control reads are passive and never construct the Lead or select a
project. Temporary I/O failures refuse the operation without latching invalid state; the window offers Try again and retries once, retaining the known holder controls. Stale project roots retain their records without blocking available projects only when a redirected root resolves outside the selected project. A redirect into the selected project or any descendant latches invalid: otherwise its old record key could hide a person hold from dispatch. Missing, ENOTDIR, ELOOP, EACCES and EPERM stale roots remain retained without blocking other projects. Chat ids are globally unique: a person hold under any project key fences dispatch and holder lookup for that chat, including pending in-memory holds. The selected project’s list projects that global holder without changing its verification keys or copying another project’s record. Hand back durably releases every project key for the chat together; only pending holds at or before that request’s epoch are released, so a newer take-over stays fenced and is persisted by its queued write. Only a chat in the host’s chat list can gain a person hold before its first Lead record. Cancelled waiting Lead messages are noted in the Lead thread immediately after the hold is saved, before a follow-up read.

Lead verification keys bind the exact envelope to its runtime and chat id.
Receipts from another chat, and older unbound digests, never earn a sender
label; those messages remain folded context. Phone projection uses the same
chat-bound verification without changing its wire fields.

Invalid control content requires explicit reset. Transient I/O failures refuse
that operation and allow a later retry. Corrupt content or permanent control-record access failures (including EACCES and EPERM) latch invalid and offer explicit Reset. Three consecutive retryable read failures from any caller report a resettable unreadable state with the additive window flag `retryable: true`, but never latch the corrupt-record fence: every subsequent call still tries the disk. This state keeps holder controls, offers Try again before secondary Reset, and gets one automatic retry even if the initial transient retry was used. Truly corrupt records retain Reset without automatic retries. The next successful read clears both the consecutive-failure count and that state without changing the record or its holds. Recovery through Lead or phone reads also clears the published window warning. The selected project being unavailable is a distinct `unavailable` problem: restore that folder and its access permissions, then retry; Reset cannot repair the project and is not offered. Both failure kinds keep dispatch closed, including its synchronous check.
Records for deleted project folders remain intact without blocking another
project. A person can hold a chat before its first Lead record when the host chat list admits its real cwd into the canonical selected project, including a symlink alias. Take over
persists and publishes the hold before attempting its cancellation notice;
notice failures are logged. A Lead instruction still in admission when the
person takes over is cancelled on refusal, freeing the person's queued replies
and preventing replay after Hand back.

## Phones away from home reach the desk through the account relay — 2026-11-01

A phone off the desk's network needs a path, and the account service already
runs a relay room per desk. The desk holds one outbound socket to it while it
is signed in and Reachable from your phone is on, which is off until the person
turns it on. The relay is not trusted with content: each phone it announces
runs the same end-to-end session as a LAN phone, pinned to the desk key from
the pairing code. What holds against the relay itself is that pin, the secret
inside the pairing code, and Allow this phone?, which a new phone still waits
for. The device check is narrower: a phone must prove the key the relay says
the account linked, which stops a ticket being used by another phone, and
refuses it before the pairing code is spent.

The relay is handed a credential of its own. The desk session carries two
tokens, and the one the relay sees is typed for the relay alone and refused by
the account API, so a relay, or anything that logs its traffic, never holds one
the rest of the account would accept.

The link's behaviour follows what each failure means. A close for a replaced
desk or a revoked one stops it, and only the person turning Reachable off and
on starts it again, so two copies of a desk never fight over the room. A
refused token is renewed once; refused again, it stops. Any other drop
reconnects with full jitter, and the window says "Can't reach HarnessDesk" only
after three failures in a row, so waking from sleep does not flash a warning.
Silence is probed three times before a socket that looks open is dropped. The
backoff starts over only after a socket has stayed up a while, so a relay that
admits the desk and drops it again does not make it reconnect in a loop. The
relay meters each socket and closes it over a frame it does not allow, which
would drop every phone at once; the desk paces its frames under that meter and
lets go of only the phone whose message is too large.

Removing a phone on the desk refuses it at once from the local registry; its
account link is removed when the account can be reached, from a small outbox
that survives a restart. The outbox is written before the phone is removed, so
a removal that cannot be recorded fails as a whole instead of leaving a link
nothing will remove. The pairing code carries a one-time invite when one
can be made, and falls back to a same-network code when it cannot, so the
account is never in the way of pairing. A desk whose relay has stopped (replaced,
refused, or an account that names no relay) gives a same-network code only: a
phone away could not reach it, or would reach the copy that took its room.

The account key and the phone-link key stay separate: the first names the desk
to the account and signs the relay's challenge; the second is the one the
phone pins for the encrypted session.


## An empty Lead page shows Dex and the folder step — 2026-11-03

With Lead on and no folder open, the host refuses `lead/thread/read` and
`lead/settings/read` with `lead-project-missing`: it builds the Lead journal only
once it has a project. The page used to wait for a name that never came — a
grey disc holding "…" in the sidebar, the bar, the popover and the middle, a
greeting floating above a warning banner, and an open rail with nothing in it.

The store now records that refusal as `projectMissing`, cleared by the first
projection. A journal always starts as Dex, so before one exists the page shows
Dex's face and name; the stored `name` stays null, so nothing that writes or
gates on the setting changes, and Switch to Lex says to open a folder first.
The middle is one LeadGreeting pattern (face, a 16 title, a 14 sentence, and
Open folder… only when it must come first), so the dock no longer repeats the
step as a warning. The rail gets one Goal line saying what it will hold and
what comes first. A word on every row at rest is noise, so the presence word
leaves the sidebar row and the bar while the Lead is Ready or has no folder,
and stays in the status popover. An empty disc replaces "…" for the moment
before settings arrive. A chosen name with an empty thread now greets rather
than leaving a blank page.


## Paired phones can review bounded output and changes — 2026-11-03

The owner approved command output and diff lines reaching a paired phone on
2026-11-03 so a person can review a change away from the desk. A file count and
a command title cannot show whether the work is right. The existing encrypted
Read lane now includes scrubbed command tails and unified diff hunks.

Command tails keep at most the last 40 lines, 300 characters per line and 8 KB
per step. Hunks keep at most 400 lines per file and 1,500 per turn, each line
capped at 300 characters; added and removed totals remain complete. Paths
become project paths, and the transcript scrub removes addresses and
key-shaped strings. Any cut marks the in-process projection truncated. Binary
or absent diffs have no hunks; added-file content becomes numbered add lines.
The complete thread is capped at 512 KB of serialized JSON, retaining recent
entries and shortening a recent change if necessary to fit beneath the relay
frame ceiling. HarnessDesk context injections are omitted; only
host-verified Lead envelopes contribute Lead words and attribution.


## Lead acceptance stays internal and distinguishes a broken check from broken code — 2026-11-05

A timeout, interrupted run or null exit produced no verdict. It needs a check
again through the existing person action, not a code repair. Missing facts and
stale or incomplete facts remain distinct internally so Lead can ask for the
right observation. Only a recorded negative verdict enters a repair brief;
passed assertions stay out, and errored checks are named separately.

An approval with hedged prose cannot support done. A short, closed phrase list
on the host checks whole words outside backtick code. This is a deterministic
acceptance rule, not another model's judgment of the first model. Reviews must
approve only what they verified and request changes for what they could not.
The exact recipe-1 source remains available for old plans and stored runs;
new plans use recipe-2.

The gate is internal: there are no Evidence or Rounds screens. The person's
report gets its how to verify line from passed assertions' recorded evidence,
never the model's confidence. Internal failure reasons are not rendered as
person-facing prose. A failed result may offer at most one general, sourced
Remember: lesson; an errored check teaches no lesson about the code.


## Lead questions offer choices; delegation keeps the person's words — 2026-11-05

A decision carries two to four short options and a recommended pick so it is
answerable with a tap on the desk or phone. The composer remains available for
another answer. Only the latest unanswered ask is live; older choices are a
record. A confident, already authorized action needs no question. Work the
Lead notices outside the person's request is offered with a recommended start
option and waits for the person; there is no backlog.

The host appends the person's original messages below a delegated chat's brief.
The model selects message ids, never re-types their words. This keeps wording
and scope intact, rejects references outside the current journal window, and
refuses an oversized brief plus quotes instead of silently losing context.
Stored proactive reports without options remain readable.


## Delegated chat recovery follows the provider's clock, then the person's choice — 2026-11-05

The host owns recovery timers because a quota reset is a provider observation,
not a model decision. Waiting buys no Lead turn and reserves no allowance.
A Lead-held chat gets at most two automatic continues per incident: the reached
window's reset plus a small jitter, or one minute then five minutes when there
is no future reset or the failure is transient. Credits, other failures,
authentication, version and sandbox refusals ask immediately. A later successful turn clears
the incident. An adapter that reports no error code is classified as failed
and asks immediately; the host does not guess a retry category. A waiting chat
remains working, never done.

The bounded host record persists its due time and claims an attempt before
sending through the ordinary attributed, journaled chat path. Restart restores
one timer; an already claimed but unconfirmed send asks instead of replaying.
Explicit Lead stop, disable, project change and person take-over cancel retries;
closing the desk preserves the wait, as does changing the Lead key or another
non-stop lifecycle interruption. Temporary retry admission failures back off,
then ask after the bound; a busy worker defers without using an attempt. A
past reset uses the backoff rather than spending both retries immediately.
No recovery transition changes policy, caps, saved approvals or publication
authority.

After the bound, an incident observation wakes the Lead once per meaningful
change. The existing structured ask offers retry, move to an eligible agent,
or stop; credit exhaustion recommends moving when another agent fits. Moving
needs the person's tap or typed answer because the reset clock grants no
permission to change who does their work. The host requires a person message
newer than the incident and the current goal start: consent counts only the
person's own messages. The host records person, automatic, or scheduled source
at send time and keeps the revision with the incident, so a same-millisecond
answer still has a strict order. Asked incidents expire with the goal. A chosen
reset retry re-arms the host timer through chat_send's retryAt reset selector;
it never sends immediately into the limit. A fresh automatic generation, for
either a plain send or a reset wait, needs a newer answer: consent counts only
the person's own messages. Without one, an explicit reset retry is refused;
a plain send remains ordinary and a failure asks again directly. Every
new failed turn can wake again. Interrupts settle recovery as stopped, and
a refused admission rolls an unstarted renewal back. A skipped terminal
observation retires its cancelled wait, and a queued renewal discarded before
sending is stopped. Message source is required at append time. Live worker approvals
remain visible during waits and retries.
The host validates the live workspace start roster, reserves one move, and
builds the new first message from the brief, the original first message (including the person's verbatim words), and
a bounded recent transcript/file digest, preserving any explicitly selected
verbatim quotes as well. A creation refused before any chat exists releases
the move claim and requires a fresh answer before another move: consent
counts only the person's own messages. Candidate admission runs before
creation; a first message refused before dispatch is reported as not started.
The empty new chat stays available on the desk and is never returned as the
moved chat. The existing ordinary removal paths cannot prove that nobody
has begun using it across their asynchronous cleanup; guarded discard only
covers the host's separate Seat allocations, so recovery does not reuse it.
Once the first message starts, its id is returned even if saving the receipt
fails, and the durable claim still prevents a duplicate move. It leaves the
old chat intact. Agent configuration and credentials remain in the agents'
own worlds.


## 2026-11-07 — Simulator input belongs to the host

Simulator input uses a source-built Swift/Objective-C helper and Xcode 27 DTUHID,
confirmed by a liveness round trip before any action. A port lookup alone can
succeed while the guest discards events. The helper dynamically loads the installed
Apple frameworks, which are never redistributed. When DTUHID is unavailable
(including Xcode below 27 or a source build without the helper), taps alone retain
the previous measured-window `cliclick` path. That path fronts Simulator, moves
the desktop pointer and refuses multiple booted devices. New input tools refuse
there. An interrupted gesture or helper crash never falls back or replays queued
input through another transport.

One host engine serializes input and capture per device. Installed plugins use
invocation-bound, manifest-checked parent requests, rather than spawning their
own native process. Screenshot pixels are transformed through measured display
orientation; missing/stale geometry and out-of-bounds contacts are refused.
Native interruption ends the current gesture and releases contacts and modifiers
without waiting for guest acknowledgement. Each connection first clears both
contacts. Frame identities authenticate a geometry epoch: another caller's
capture does not invalidate them, but an observed size, rotation or boot change
does. Native and installed-plugin IPC deadlines scale with validated bounded work; the parent holds the invocation only while the bounded native call is active.

Keyboard show/hide, device rotation and deterministic lock are explicit refusals
until the requested guest state can be observed and verified. A physical power
button is not a deterministic lock setter. Text currently reports US-layout HID
insertion and refuses characters requiring an unverified Unicode method.

The desktop's beforePack hook preserves preparation of the pinned Lead Node and
requires a helper for the target architecture. The helper is copied as an extra
resource and listed in mac.binaries for nested signing. Source builds without
Xcode stay usable; input reports the missing prerequisite. Release signing and
notarization remain the release machine's separate gate.

## 2026-11-07 — Installed simulator authority requires shared consent

Installed plugins share one child process, which cannot attribute a simulator
request to an individual resident. The parent offers invocation tokens and
forwards simulator calls only when every enabled resident declares `ios: true`
and still holds its stored grant. It keeps a conservative installed-plugin census,
accepts disabling only through parent-issued operations, and blocks forwarding
during resident changes; a child snapshot alone cannot establish shared consent.
Built-in plugins run in the parent kernel and retain their own capability gates.
Per-plugin process isolation would lift this shared-consent requirement.
*Superseded by "Installed plugins run one to a process" below: each process
holds one plugin, so its simulator authority is its own consented grant.*
Missing shared consent withholds simulator authority rather than the invocation:
tools, commands, hooks and context providers still run, and a non-secret per-owner
refusal marker makes `ctx.ios` explain the constraint without exposing a bearer.

Every forwarded simulator method uses a deadline derived from the engine's
subprocess limits and sequential steps, with delivery margin for IPC. The parent
holds the invocation while any such call is active and aborts its engine signal
on expiry. Simulator subprocesses and diagnostic probes consume that signal;
queued mutations check it before starting, so an expired invocation cannot begin
another mutation after its predecessor finishes.

## Installed plugins run one to a process

*2026-11-07.* Each installed plugin runs in its own process, and the host
attributes everything that process asks for to that plugin, by the pipe it
arrived on. [plugin-isolation.md](plugin-isolation.md) is the design.

**Why.** One process shared by every installed plugin survives a crash, but
it cannot tell its plugins apart. Every request comes out of the same pipe,
so the plugin making it has to say who it is. And whatever the host tells one
plugin, every plugin in that process can read. Per-call claims and tokens can
narrow that, but they cannot close it: inside one process there is nothing
to bind a claim to. A process per plugin gives the host something it can
know rather than be told, which is which pipe a frame came in on.

**The rule:**
- **Identity comes from the channel.** A request from a plugin process never
  names a plugin.
- **Authority comes from the record.** The record is the manifest the person
  agreed to at install, kept by the host outside the plugins directory, plus
  the grants they gave in Settings. A plugin whose manifest on disk no longer
  matches its record does not start until the person agrees again.
- **The conversation comes from the lease.** The lease is the host's record
  of the call it started, scoped to that one pipe.

A change that reads any of the three from a plugin's message is wrong,
however well it validates the value.

**What it costs.** A runtime per plugin in memory, and one round trip more
for each brokered capability. Installed plugins also cannot share Cordis
services with each other; cooperation goes through the host's attributed
planes instead. Built-in plugins stay in the host process: they are the
repository's own reviewed code, on the same API and the same gate.

**Layers.** Attribution and authority are about what the host does, so they
hold for every plugin, confined or not. Confinement under Node's permission
model is what keeps a plugin from reaching the machine without asking the
host, and Node describes that model as a seat belt against accidental reach,
not a defence against code written to escape it. A plugin that escapes it, or
runs where no confining runtime passed the probe, has the user account's own
access. The host says so in the plugin host's status rather than implying
otherwise, and an operating-system sandbox per plugin process is the layer
planned after it.

**Confinement, as built.** A confined process reads its own code and its
plugin's directory and nothing else, so everything it once did for itself
with the disk, the network or a program moved to the host: `ctx.fs`,
`ctx.http`, `ctx.shell` and `ctx.android` are served there, workspace roots
are resolved there once, and a browser page is placed there. The runtime is
the first of the Lead's candidates whose probe refuses a connection, a read
outside the grants and a spawn; with none, the plugin runs unconfined and
the host's stats say why, rather than refusing to run a plugin the person
installed. Two gaps are left in the open, not papered over: `process.kill`
is outside Node's model, and Node follows a symbolic link past the grants.
The second is closed at the one door a package comes through: the installer
refuses a package with a link that leads outside it.

## An adjacent conversation is a reader, not a second subject

The sidebar's Open on the right action has one window-local, read-only target.
The current work remains the sole command and workspace subject, including in
Editor mode. Opening explicitly reads then resumes the other conversation for
live updates; the operation may reopen a runtime or restore a worktree. Closing
its reader does not close a shared Host handle. This deliberately avoids a
second composer, persisted layout or general-purpose conversation dock.

## A mention is triaged by rules, then by a model that only chooses — 2026-11-10

Asking the Lead from an issue or pull request comment is the most direct way
to hand it work, and also the easiest way for a stranger to try to. A mention
trigger therefore never admits on the comment alone. Deterministic rules run
first, in a fixed order, and the first one that fails decides: the comment
must address the handle, its author must be on the trigger's list (compared
by the forge's account id, never a login), the thread must be in the
project, carry one of the trigger's labels if it names any, and still be
open, and a comment that asks the handle to stop is a stop. Only then does
one small observer-model request judge whether it is a request for work, and
that answer can only pick accept, ignore, stop or ask with one sentence.
What accepting opens, the budget and the Flow are the trigger's own and are
never read from the comment or the answer, so text in a comment that tries
to instruct the model changes at most the verdict, never what is admitted.
The assessment uses the Lead's key and transport only when the Lead is
enabled, sends no comment that looks like it carries a credential, and stops
at 200 a day; without an answer the decision is `ask` and waits for the
person, who can Re-evaluate it.

A new mention trigger observes first: it records "would have accepted" and
acts on nothing until this machine switches it to act, and every arm starts
it observing again, because a changed file is a new consent. Accepted work
is one thread. A later comment from someone allowed on the issue or any
linked pull request joins the same Goal without a second triage; a comment
from anyone else is counted as an observation and never acted on. The thread
closes when its linked pull requests merge or close.

Review round, same day:

- **Only a comment that addresses the handle resumes work.** Discussion
  between people on a followed thread is counted, not acted on; the desk's
  own posts never resume it, whether told apart by marker or by the
  desk-posts record. A review on a linked pull request does not resume it
  yet: the mention source reads comments only.
- **A stop says what it stopped.** `@dex stop` stops running intake runs and
  live Seat turns on the thread's Goals through the host's stop path and
  records how many runs stopped; when nothing was running it says so, and the
  thread closes as closed, not stopped. It reaches the trigger's own runs and
  Seats; work the Lead starts after a person approves its plan is the Lead's
  to stop. (Superseded below, by joining the work ledger.)
- **Observing is silent.** An observing trigger raises no attention notice,
  even for an `ask`; the person reads it on the trigger's page.
- **Re-evaluate judges the comment that was decided.** The decision keeps a
  digest of the comment's text; Re-evaluate refuses a comment edited since,
  because the request a person would approve is no longer the one recorded.
- **The observer's spend is the Lead's.** It is reserved before the request
  and settled after it on the Lead's budget ledger, at the Lead model's price
  (an upper bound for the smaller observer model); an unknown outcome counts
  the whole hold at once rather than leaving the Lead's spending blocked. No
  ledger, or a refused hold, sends nothing.
- **An issue-only thread ends with its issue.** With no pull request linked,
  the sweep closes the thread once the issue closes.

Joining the work ledger, 2026-11-10:

- **A thread of work is one item on the Lead's work ledger.** An accepted
  mention attaches its thread when it opens or resumes: the asking comment
  is the item's origin, and the issue or pull request and the thread's Goals
  are its links. A plan the Lead drafts for that issue or pull request names
  it as its origin, so once the plan starts Teams it joins the same item by
  that shared link instead of opening a second one. The ledger is the one
  place that knows both halves, which is why the stop reads it.
- **A stop reaches the Lead's goal the thread opened, and only that.**
  `@dex stop` stops the trigger's own intake runs as before and, when the
  Lead's goal in hand was opened by one of the thread's own firings, stops
  that goal the way the person's Stop does: journaled as a stop from the
  comment, then the runs the goal owns, then the Lead's model process, so
  the plan is stopped and its next step never starts. A plan still waiting
  for approval is stopped the same way. The decision says what it stopped
  ("1 run the Lead started for it and the Lead's plan for it were
  stopped"), so a Lead-target trigger no longer says nothing ran while the
  Lead's Teams were working.
- **Never by Team, never by shared link.** The first version walked the
  work item's Teams and stopped every run on them. Every thread on the same
  issue shares one item, so a comment on one trigger's thread could stop
  another trigger's Goal, and a run a person started on a Lead Team was
  stopped and counted as the Lead's. The work item stays for reading; the
  stop matches the Lead's goal by its origin key (`trigger-<firing>`) and
  reaches only the runs the goal's journal owns, the same set the person's
  Stop reaches. A run a person started is never stopped from a comment.

Rejected: a webhook (a public endpoint and a secret to hold, for a desk that
already polls the forge); a separate bot identity (a second credential, and
the desk's marker line already tells its own posts apart); triaging every
comment (cost and noise, and a stranger's comment would reach the model);
and letting the assessment choose the Flow or the role (that would hand
control of what runs to whoever writes the comment).

## Account pacing is an order and a note, not a scheduler

Accounts of one agent used to take turns only in the person's own order. Allowance that expires unspent is lost, so *Prefer the account that resets soonest* (`pace: 'soonest'` in the agent's account pool) uses the accounts with room in the order their deciding windows refill, and an account with more than half of a window unused and that window about to refill says **Use it first**. The ranking lives in `@harnessdesk/protocol` (`pacing.ts`) so the desk's order, the Lead's start and the phone's note read one rule from the usage reports the host already keeps; there is no new request to any vendor.

- **An account with room but no clear reading ranks behind one with a known reset.** A stale or failed reading proves nothing about room, so it is tried after the clear ones, in the person's own order. An account that is out is last however soon it resets, and one nearly spent (under 10% left) is tried after one with more.
- **An account is only as roomy as its tightest window.** Headroom is read from every account-wide, known lane, not only the binding one: 80% of the five-hour window left with 2% of the week is nearly spent, so it neither leads the order nor raises the note. A lane whose reset has passed has refilled and is set aside before this test, and a "reached" reading that is stale or past its reset is unknown (tried after the clear ones), not out.
- **Ten percent is the bar.** `PACE_HEADROOM_PERCENT` is the one line between "has room" and "nearly spent", shared by the order and the note so they cannot disagree. It is a round number a person recognises ("under a tenth left"); lower, and a window that is minutes from empty still leads, which wastes the first message of a chat; higher, and a half-used account is demoted for no reason. It is a bar to revisit with real use, not a measured optimum.
- **Close means a quarter of the window.** Half left with a week still to go is not about to expire; with a quarter of the window left it is. A window with no stated length counts a day. Model-scoped windows, placeholders, unlimited ones and stale or failed readings never raise the note.
- **The Lead does not choose.** The person turning the soonest-reset order on for an agent is the account choice. A Lead chat start that names no agent asks the host (`LeadChats` `pacing` port); the host answers only when that setting is on for the agent of the desk's default runtime (named, not guessed from the list) and that default can start and the agent has more than one account, and then starts the chat there; if that account is gone by creation time the chat starts on the desk default instead of failing and returns the account's `usage_summary` label in the result, which the Lead says in its reply. A Lead can still never pick an account itself, and a move after a stuck chat still names its agent as before.
- **Rejected:** moving a running conversation to the better account (its thread lives in the first account's history); a scheduler that spreads turns over time (the person's own order and the notice already cover running out); computing the note on the phone, including dropping it on the phone's clock after the reset (two clocks and two rules would disagree; the next desk read carries the new flag).

## The Lead's work is one ledger the host derives — 2026-11-10

A Lead that starts chats and Teams for the person lost track of them across turns: a resumed turn could start the same work twice, and the person had no single list of what was asked and who it now waits on. The host now keeps that list. One item per piece of work links its chats, Teams and pull requests; `chat_start` claims an item before anything is created, so a repeated start is refused naming the open item, and `ledgerItem` adds a chat to one on purpose. Matching uses the quoted person message first, then a title that is the same after normalising or shares at least four in five words with no differing number, so "issue 41" and "issue 42" stay separate work.

Stages are derived, never written by the model. They reuse the waiting-on-whom stages the phone already counts, so the desk rail and the phone draw the same four groups from one host board and cannot disagree. Closing follows the desk: a merged or closed pull request, a finished Team or a finished chat the Lead has replied after settles a link, and an item whose every link settled closes itself and reopens if one starts again. The person's Done or Drop is final and closes only the record, never a chat, Team or pull request.

The model's one write is a note, an `after` link and a reminder. `lead/work/note` sits in the client door's read tier: it annotates a host record the child already owns and changes nothing on the desk, so classing it with the run-tier mutations would fence it behind the attempt journal for no gain. A reminder uses the existing minute timer and the two doors scheduled work already has, the automatic-goal offer and a schedule-sourced turn, with the same quiet hours and a stable key; there is no second timer system.

The open cards reach the model as a bounded block appended to the request, not as thread messages, so they cost no history and are always current. Rejected: letting the model set stages or close items (it would report work done that the desk shows running); a phone-only projection (two lists would drift); a per-item timer for reminders (a second scheduler to recover after restart); refusing duplicates only by exact text (a resumed turn rewords its brief).

Three limits keep the ledger from working against the person. Reminders are at least fifteen minutes out and an item may wake the Lead three times before the person writes again; without them the model could wake itself every minute indefinitely. Reminder text carries the title and note as quoted strings with `<` escaped and says they are data, because the title came from the model and the note may repeat a page. Work with no link the host can follow for seven days closes as stopped, and a full ledger closes its oldest such item to make room, because an issue or an unfollowed pull request never settles and 256 of them would refuse every later start. Rejected: refusing new work when full (the person loses the Lead to stale records); dropping open items on reload (work disappears without anyone closing it); refusing on a shared origin message alone (one message often asks for two separate things); overwriting a ledger file that failed to read (a transient read error would erase the record).

## The Lead's conversation is stored by the host and summarised in place — 2026-11-10

A Lead that runs a goal for days outgrows any window. Rebuilding each request from the words the person can read lost every tool call and result, so the Lead re-read the desk to learn what it had already done, and a changed prefix on every wake meant the provider's cache never paid. The host now stores the conversation as the provider saw it, tool pairs included, and replaces its earlier part with a checkpoint when it fills.

- **The host stores it, the child marks it.** The child has no file access, and a restart or a model change must not lose the conversation. The child sends each step's new turns to the host, desk context already stubbed, so stored history and the next request agree byte for byte. Rejected: the child keeping history in memory (lost on every restart) and the host re-deriving it from the journal (the journal holds no tool results).
- **Desk context is never part of the cached prefix.** It changes every wake; inside the prefix it would make every request a cache write. It goes after the last mark and leaves a one-line stub behind.
- **A checkpoint, not a sliding window.** Dropping old turns silently loses the person's early instructions. The checkpoint has six fixed sections, quotes the person's words with their references, says the person's later words win, and merges the previous checkpoint. It is refused unless shorter, complete and carrying every work id. Rejected: summarising every turn as it ages (many small requests, each a cache miss) and asking the model to decide when (it cannot see its own pressure).
- **The checkpoint request replays the same prefix.** Same instructions, tools and turns, one instruction appended, so it reads from the cache it would otherwise throw away.
- **A breaker and a desk-built fallback.** Three refused or failed checkpoints in a row and the desk builds one from the conversation itself: the person's words and the work ids, verbatim and bounded. A full conversation must never stop the Lead. After a fallback the next compaction asks the model once.
- **Two-phase apply.** The new file is written beside the old, the journal's epoch is the commit, then the file moves in. Reopening rolls forward or back by comparing epochs, so a crash keeps exactly one conversation. Rejected: rewriting in place (a torn file loses everything).
- **Pruning before compaction.** Trimming old tool results is free and often enough; it runs first and compaction follows only if pressure stays high.
- **Folding old reads before summarising (#2151).** An ordinary question read the desk in three rounds of tool calls, so it stored eight turns, and the turn count (200 a request) crossed the soft line after 17 questions while the tokens stood at 40% of the window: the conversation was summarised every ten questions. Pruning now folds each closed exchange older than the last three tool pairs into the person's words plus one desk record of its reads and the Lead's reply, two turns in place of eight, and the answers are cut to their head. The model still sees what it read and what it said; it loses the full text of old answers, which it can read again. What a read returned is untrusted, and folded it no longer sits in a tool result but in a user turn beside the person's words, so the record says it is quoted tool output and quotes each answer as one JSON-string line: a hostile answer cannot close the record or start a line that reads as the person or the desk. Rejected: keeping the answers raw under a closing marker (an answer can print the marker) and dropping the answers (the model loses what it read). Measured with a fake agent over forty such questions at a 200k window: three summaries before, none after (three prunes).
- **The person's section is the desk's, not the model's, by structure rather than by pattern.** The checkpoint's What the person wants is built by the desk from the person's messages in the journal, quoted with their references, and travels as data: the facts carry it as `person` (each message's reference and text, and the references left out), and the view draws it as rows with the reference as a chip. It is never drawn from text. The model's five sections are shown as plain text under the desk's own section titles, a line a paragraph, so nothing the model writes can draw a heading, a list or a quote, whatever markup or markdown it holds. In the request the person section sits inside a `<desk-person-messages>` envelope that only the desk writes. The model's text is normalised where it is read: every line terminator a renderer or a model reads as a break (CR, CR LF, the Unicode line and paragraph separators, next line, vertical tab, form feed) becomes one newline; other control characters except a tab are dropped; every format character and the blank letters that render as nothing (U+2800, U+3164, U+115F, U+1160, U+FFA0, U+180E) are removed; and trailing space is trimmed. Then the structure is read: only the five headings open a section, matched however they are spelt; a heading that names the person's section is dropped with what follows it, blockquoted or not; any other heading becomes a plain line; and what comes before the first section is dropped. A line still in the desk's quote shape, blockquoted or not, keeps its words and says it is the Lead's note. Every other line is kept, with its words. Last, `<` and `>` become entities, so model text holds no markup and cannot close or open the envelope; escaping before the structure was read hid a blockquote's `>` from the heading and quote checks. Every bounded field the desk writes (the checkpoint, each person message, a turn or tool result in its own checkpoint) is cut by one clip that never splits a surrogate pair, since a half pair fails the wire's check and would make the facts unreadable; the stored list is read one summary at a time, so an entry the wire refuses drops itself, never the list. Pattern-matching the model's text as the only guard was dropped: five rounds each closed one spelling (a folded heading, a line separator, an invisible character, an HTML heading, a raw list) and the next round found another, because a renderer reads more shapes than any list names. The desk now owns the person section's shape end to end (data in the facts, an envelope in the request, a component in the view), so the model's text has nothing to imitate. Each checkpoint rebuilds the section from the journal rather than reading the previous checkpoint's, so nothing the model once wrote is carried forward as a quote. Text inside a tool result or a worker's output can say anything, including words that look like the person's, so only the journal decides what the person said. A message the journal no longer holds is named by its reference.
- **The approved plan is the host's own words, not desk context.** A request marks where the host's kept turns end (`kept`); only the desk context after it is stubbed, so a wake days later still reads the plan's step ids. The plan (the contract and how a step is started) is the same text for the same contract and is stored once: a conversation that already carries it gets no second copy, and one a checkpoint took it from gets it again on the next request, a desk wake included. Where the plan stands (step states, runs, open waits) changes with every request, so it goes after the mark and is stubbed. Rejected: putting the contract inside the checkpoint (it can be larger than the checkpoint's bound, and the checkpoint is a summary while the contract must be verbatim). Turns of one role in a row are joined before they are sent or stored.
- **Only the model's failures count toward the breaker.** A checkpoint request refused by the budget, stopped, or lost between processes ends the run without counting, and so does one the provider refuses for the desk's own key or configuration; a stopped Lead spends nothing on its context. A checkpoint request the provider refuses as a request is different: ordinary requests can still pass while that one never does, so stopping would let the conversation grow until it is too long. It counts, and the desk writes that checkpoint itself at once. A timeout or conflict the provider names (408, 409) is about the moment, so it gets one more ask first.
- **A conversation the latest turns alone fill stops compacting.** The host keeps the smallest tail once, and if that still sits past the hard line it pauses until the conversation grows and says so in Settings, rather than compacting on every request.

## Presence, the away digest and ask expiry live beside the journal — 2026-11-10

The desktop kept what the person last saw in the browser (`hd-lead-seen-v1`) and built its own away summary from the thread. That left each device telling its own story: a phone could not show the same card, dismissing was the browser's private business, and a question the person never answered stayed answerable forever. The host now owns the record.

The digest is derived from the work ledger and the journal's pending cards, not from message text, so it reports what the desk knows and is identical for any device that asks. Seen marks and dismissals are per device and are the host's: a dismissal names a digest id, so dismissing on one device cannot hide it on another. Rejected: a shared seen mark (reading on the phone would blank the desktop's card), and keeping the mark in the browser (the phone has no browser, and a cleared cache would replay a day of news).

Ask expiry and answer receipts sit in the presence file, not the journal. Journal events are strict allow-lists without timestamps, and an expiry that mutates thread history would change what the model reads. The thread stays as written; the presence view says whether an ask is open, answered or expired. An ask is still answered by sending its label as the person's message, so a receipt is recorded when that send arrives, and a send after expiry is refused and nothing is done. Rejected: closing an expired ask by appending a journal event.

The review of the first build changed four things. A digest that nobody dismissed is rebuilt from where it began instead of blocking the next one, because moving the seen mark while ignoring the new span lost events; and dismissing the brief hides only the brief, since it covers the same hours an away digest would but is not that digest. Expiry is judged against the newest open ask, not the last message, and the clock starts when the journal appends the ask, because the first look can be hours later; words sent after an expired ask carry a host note, because the model otherwise reads "yes" as an answer to a question that nothing acted on. The answer is claimed before the send, first wins, because two devices tapping at once must not both reach the model. The phone is told of presence changes on a `presence` topic and tells the desk it is looking while it is open, because a mark that only moves on connect turned a watched hour into a digest.

The optional digest summary is a separate model call with its own daily cap, counted in the digest's spend, rather than a journal budget reservation; a reservation would put the digest into the goal's allowance logic for a paragraph that can be omitted. The brief push rides the phone-link `notices` topic because the desk has no push sender of its own yet; the same notice carries text capped for a system push and for a window so a sender can be added without changing the digest.

## Autonomy and rules are settings the host enforces, not words the Lead is asked to follow — 2026-11-10

The Lead does five things unasked, and a person wanted to turn each off, or watch it first. The setting is a host table of Off, Observe and Act per kind; the host checks it where it would act, so a model that ignores its instructions still cannot act, and the Lead has no tool that reads or writes it.

- **Observe records, it does not half-act.** It writes a silent wake row with the kind and does nothing else, so a person can see what a switch would do for a few days. A separate "dry-run" flag per kind was rejected: a second code path that only pretends is the one that drifts from the real one.
- **Modes in the journal, history in a file.** The modes and the sections in force must replay and reach the child, so they are one journal event. The version history is the person's and can be large, so it is a file. Keeping all of it in the journal was rejected because journal events are strict allow-lists the child parses; keeping the modes only in the file was rejected because the child's wake gate could not see them.
- **Rules reach the model only at an epoch.** They are the last entry of the epoch addenda, fenced and clipped, and open with a sentence that they grant nothing. Putting them in the child's bootstrap was rejected: the bootstrap is fixed for the child's life, and an edit would need a restart. Reading them every wake was rejected: it breaks the cached prefix on every edit.
- **Rollback appends.** Restoring an old version writes a new one carrying the exact old bytes, so history only grows and a restore can itself be undone. Rewriting the list was rejected because it loses what the person changed their mind about.
- **A running approved goal still hears about the desk.** Desk-change reports set to Off or Observe still wake the Lead when the goal in hand is approved and running; the host cannot know that silence is safe for work it was told to finish. The mode governs the Lead's unasked reports, not the work it was already trusted with.
- **The reserved run is a count the host keeps, keyed on the cause of each start.** A start from a turn the person woke, or its tool continuation, is the person's; every other wake (desk change, stuck, repeat, mention, brief, reminder) is automatic. The host counts live automatic runs, chats and Team runs together, and refuses an automatic start at three or when the account's pacing headroom is under 10%; it never refuses the person. A missing cause is automatic, never the person's: a read of "no cause named" as the person is how a scheduled pre-approved run and the stuck-chat retry once walked past the cap and the deadline. Until the journal and the runs file have loaded, an automatic start is refused as loading rather than counted as 0; a missing usage report lets a start through (the cap of three still applies) and the record says `no usage report`; the slot is held before the run is created. The Lead sees the reason as a tool result. Keying on whether a goal has an origin was rejected: it protected nothing, because a person's goal can wake the Lead for automatic work and a scheduled goal can carry the person's own follow-up. A per-kind quota was rejected as more to configure for the same guarantee.
- **A deadline is a budget and a stop.** It is read at admission, so it needs no timer to stop a round, and the same read stops automatic chat starts and sends and every unasked wake for that goal. The person's own message is still answered, and the Lead tells them the time has run out. The 80% report is a courtesy on the minute timer. Storing it in the wake ledger was rejected: the ledger is a record of what happened, not a limit. Goals can be given a deadline in the window.
- **Untrusted text has one cleaner.** The rule sections, the compaction summary and any text the person or a desk supplies pass `leadCleanUntrusted` (fold, NFKC, strip invisible characters, escape last, clip), so a forged closing tag or a zero-width split cannot leave its fence.

## The Lead's memory is the host's, read at an epoch and changed by proposal — 2026-11-10

The Lead kept memory as a flat list of lines in `memory.json`, filled from `Remember:` lines in its replies and sent with every request. The person could not see who wrote a line, could not undo a change, and any text the Lead read (a tool result, a worker's output) could reach the list through a reply. The list grew without bound, and since it sat in front of every request, each new line changed the cached prefix.

- **The host owns the store, the child gets a snapshot.** The child has no file access and must not gain one, so the host keeps `memory-store.json` and writes Core into the journal as a host record. The Lead reads it in its standing instructions, which are rebuilt only at an epoch. Rejected: sending memory with every request (each change becomes a cache write and the prefix never settles) and a memory tool the Lead calls at the start of each conversation (it forgets to, and the read costs a step every time).
- **Core and Archive, with a fixed size for Core.** Core is what the Lead must always know and stays at or under 6 KB; everything else goes to Archive and is searched. Rejected: one list with a count cap (a few long notes fill it) and dropping the oldest when full (the person's earliest instructions are the ones most worth keeping).
- **The Lead proposes, the person decides.** A proposal is scanned and either refused with a reason or put in an inbox shown under the reply it came with. Facts and lessons may skip the inbox when the person says so; preferences always wait. Rejected: the Lead writing directly (anything it read could become standing instructions) and a separate review screen (proposals far from the reply that made them are hard to judge).
- **The scan reads structure, not only patterns.** Every note, the person's included, is cleaned the same way before the Lead reads it, and the tidy request reads it the same way, through the shared `leadCleanUntrusted`: line terminators folded to one newline, compatibility forms folded (NFKC), format and blank characters removed, and `<` `>` escaped last, so nothing in a note can open or close the `<desk-memory>` envelope, start a heading, or start a new entry line. A proposal, and a line the Lead offered before this store, is also matched after lookalike Cyrillic and Greek letters are read as the Latin ones they imitate, and is refused when it reads as an instruction to the Lead, carries something shaped like a credential (a prefixed key is also looked for with the spaces and line breaks between its pieces taken out), quotes a tool's output, or is too long. The person's own notes skip the instruction check, since the person wrote them, but not the credential check.
- **What the scan does not catch, by choice.** A short base64 string and a plain-language paraphrase of an instruction pass the scan. Decoding every short run would refuse ordinary identifiers, and recognising paraphrase needs a model reading each note. The inbox is the control for both: nothing the Lead proposes is kept until the person keeps it, unless the person turned on keeping facts and lessons without asking.
- **A tidy is checked and undone whole.** The observer model only says which of the Lead's entries to merge and which a newer one replaces; the store applies that or nothing. The check counts distinct words: a tidy after which more than 30% of the words the Lead's entries said appear nowhere is refused. Rejected: a character count (merging two near-identical notes halves the characters and loses nothing), letting the tidy touch the person's notes (their words are theirs), and a notice in the thread for each tidy (a daily housekeeping line crowds out the conversation; History lists it with Undo).
- **Search is local and covers summarised conversation.** BM25 over Archive, a copy of the conversation the host keeps beside the journal, and the checkpoint summaries. Rejected: an embedding index (a model and a download for a few thousand lines) and searching only the journal (it rotates, and a summary replaced the older part).
- **Memory stays with the Lead.** A Lead request to start a chat or a Team that carries the envelope or a kept note's text is refused, so workers get the task and never the person's standing preferences. The comparison folds compatibility forms, case and every run of spaces and line breaks, so a wrapped or restyled copy is caught; a paraphrase is not, by the same reasoning as the scan.
- **An epoch reads one Core, even across a restart.** The Core a Lead epoch starts with is journaled with its goal and epoch, and a Lead process that restarts in the middle of that epoch rebuilds its instructions from the journaled copy rather than from a Core kept since. Rejected: rebuilding from the latest Core (the cached prefix breaks and the Lead's view changes mid-plan) and holding the snapshot only in the process (a restart loses it).
- **Core is measured at the widest revision.** The revision is printed twice in Core, and the journal's may run ahead of the store's, so the 6 KB budget is checked with the widest revision the desk can print. A Core the journal still refuses is shown in Settings as an error, and the Lead's older copy is named as such rather than used in silence.
- **Forget says what it removes.** Forget removes the entry from every saved version, including the originals a tidy merged into it, and drops the passages of the kept conversation that quote it, compared on folded words; Forget all clears that conversation copy. A paraphrase cannot be found reliably, and the Lead's journal is an append-only record whose sealed segments are kept, so neither is touched, and the confirmation says so rather than promising more. The ids taken out stay in the file, with no text, so a message the journal still holds is not copied back.
- **A phone answers proposals, the desk edits memory.** From a phone the person may keep or decline a proposal and forget a single entry. Forget all, Undo, Add, Edit, Move and the switch that keeps the Lead's notes without asking are refused there in one plain sentence: each changes more than the one line on screen, and the desk's Settings shows what they change.
- **A request to remember runs the scan before the model.** The person's chat message is the person's authority for that turn, so an ordinary message is never scanned for instructions. A message that opens by asking the Lead to keep something ("记住这条：…", "Remember: …", "覚えて…") is different: the kept line would be read on every later turn, and text pasted from elsewhere would become a standing instruction. The host reads the opening of every person send, and when what is to be kept fails the proposal scan as an instruction to an agent, the send is refused with `lead-memory-instruction-refused`, nothing enters the thread and no request goes to the model; the composer says why in one sentence. Rejected: scanning only Dex's proposal (it depends on the model proposing at all, the refusal reached the model rather than the person, and the turn was already spent), and refusing any message that mentions such words (the person may want to talk about prompt injection). A rule the person really means is written in Settings, where it is their own entry.
- **The opening is read the way an attacker would write it.** Invisible characters are taken out first (the same cleaning a memory entry gets), at most two short addresses or yeses before the verb are set aside ("Dex，", "好的，", "Please,"), polite forms ("Can you remember this:") and the other verbs people use (记得, 以后都记住) count, and the instruction patterns read Chinese and Japanese as well as English (忽略之前的指令, 不需要 review, 跳过审批, 直接合并, 以前の指示を無視, レビューは不要).
- **Keep with edited words, on the desktop or the phone, is the person writing the entry.** Its text is saved as the person's own (`by: 'person'`), like a line written in Settings: it is cleaned, held to the length limit and refused if it carries a credential, but never refused as an instruction, since the person choosing those words for the Lead to read is exactly what a rule they mean is. The proposal it replaces was scanned when the Lead made it.
- **The old file is read, not replaced.** `memory.json` is the migration source: its kept lines become the person's Core entries once, numbered m1, m2, … in their old order so a plan's tag still names the same line, while the lines it offered are numbered c1, c2, … apart and pass the scan on their way to the inbox; and `lead/memory/read` and `lead/memory/update` keep working for older clients against the person's entries.


## The Lead only says a note is kept when it is — 2026-11-10

Core is frozen for an epoch, so a Keep, a No or a Forget in the middle of one is invisible to the Lead until the next checkpoint. Proposing a note that already waited came back `refused: duplicate`, and the Lead read that as "already recorded"; after the person declined everything and forgot every entry, it still said so. The chip stayed under the old reply, and a declined note could never be proposed again.

- **The Lead sees where its proposals stand, every request, outside the cached prefix.** The host appends a `<desk-memory-status>` block after the work cards: each recent proposal as waiting, kept, kept in the person's words, declined or forgotten, the entries changed since the epoch's Core, and the date of a Forget all. It is stubbed when stored, like the rest of the desk context, so it costs nothing in later turns. Its instructions say a note is in memory only when the list or this block holds it as kept, or the tool answered `exists` or `kept`. Rejected: refreshing the standing instructions mid-epoch (every Keep breaks the cached prefix, which is what epochs exist to avoid) and journaling each proposal's state into the Lead's state (the store already owns it; a second copy has to be kept in step and rotates with the journal).
- **The tool answers with what is true, not a refusal.** `pending` returns the waiting proposal's id, `exists` the kept entry's id, `created` a new one; only `kept` means the note is in memory, and only the store can return it. Rejected: keeping `refused: duplicate` with a better reason (the model treats any refusal of a duplicate as "done") and creating a second proposal (two chips for one note, and Keep on one leaves the other).
- **Asking again moves the one chip.** A pending proposal made again takes the newer message's position and is marked asked again, so the chip shows under the reply that is talking about it, with the same id. Rejected: leaving it where it was (scrolled away, which is how the person never saw it) and a notice in the thread (a second control for the same note).
- **A No holds until the person speaks again.** A declined note is refused while nothing the person wrote is newer than the No; once they write again, the Lead may propose it, and the tool says `declinedBefore` so the Lead can mention it once. Rejected: a permanent decline (the person cannot get back a preference they changed their mind about without going to Settings) and no decline memory (the Lead re-proposes on every turn).
- **Forgotten means forgotten in the status too.** A forgotten proposal keeps its state but loses its words, so the status says something was forgotten without carrying the text Forget took out. An entry gone by Undo reads as undone and one gone any other way as removed, so the Lead never tells the person they forgot something they did not.
- **A desk wake reads the status through the host, and a turn without it checks first.** The Lead's process builds desk wakes and never holds the store, so it asks the host for the status over its existing channel (`readMemoryStatus`), as it already asks for the stored conversation. The host sends the block even when nothing changed, and the instructions say that on a turn without it the Lead never says a note is recorded. Rejected: an instruction alone (the Lead would hedge on every wake), handing the child the store (it has no file access by design), and pushing the status into the child on every change (a second copy to keep in step with the store). The status is context, never a reason to stop: a read that fails or is slow answers null rather than failing the call, since a failed call on the child's channel stops the child, and a damaged store would then stop the Lead on every wake.
- **A negation is a different note.** Near-matching is word overlap, so "never merge after review" once matched a kept "merge after review" and answered `exists`. Each side's negation ("not", "never", "no", "don't", 不, 别, ない) is read apart from its words, and two sides that differ never match. Only words that negate count: "no-op", "do nothing", "without", 不错 ("not bad") and 非常 ("very") are ordinary words, so a "don't" in front of such a note still reads as its opposite; 无法 ("cannot") still counts, as "cannot" does. Rejected: a lower overlap threshold (it would still match, and miss real repeats).

## A reply's links are pointers the desk confirms — 2026-11-10

The Lead named work in its replies ("the keyboard work is in review") and the person had to find the chat or Team by hand. The reply's envelope now carries `refs`, at most eight `{kind, id, title?}` pointers (`kind` is team, goal, session, chat or work), journaled with the reply and served on `LeadMessage.refs` to the desk and the phone alike.

- **A ref is a pointer, never a name to trust.** The model writes it, so a window draws a ref only when the desk itself has what it names: a Team or goal it holds, a chat on a runtime it runs that it or the Lead's own chats know, or an item on the work board. Anything else is dropped rather than drawn as a link that goes nowhere. The label is the desk's own name for the target; the model's title, read as plain text, is used only when the desk has none.
- **A work ref opens what the work is in.** The item's latest chat, else its Team, else its pull request, in the order the Work rail's own menu offers them.
- **Refs ride with the reply, not beside it.** They cross the child's `appendReply` with the text and the ask, are parsed by the same strict validator the window uses, and never come with proactive output. Rejected: finding ids in the prose (a reply that quotes an id would turn quoted text into a link) and a separate notification (a reply and its links would arrive apart).
- **The envelope is the reply's last block.** A model writes the envelope after its prose or in a final code fence as often as alone, often with one closing line after it ("Let me know!"), and any of these is read, never shown as JSON: at most one line of 120 characters, with no fence, may follow it. One anywhere else (a `>` quote, a worker's log in a fence, a list item, the middle of the words) is somebody's output being shown: it is never parsed, so it is never an ask or a link, and the host still takes it out of what is drawn and logs a warning that names the code only. Only an envelope cut short at the reply's very end takes everything from its opening on; one clipped mid-reply takes only its quote block, the lines it fills (it ends at a line break whose next line is not JSON, so the prose line or list item after it stays), or, inline, its own JSON fragment, and an opening counts only when JSON-shaped text from it reaches the marker, so a `{` in the prose ("a template like {name") never cuts anything. The tidying is only where something was removed. Rejected: reading the first envelope found anywhere (a quoted worker envelope would have been taken as the Lead's own ask), and leaving an unparsed envelope in the words (raw protocol JSON on screen was the bug the sitting found).

## The inbox is one read, and its count is the desk's — 2026-11-10

The desktop's bell listed the notices it kept in preferences, and the phone built its Inbox from the Lead's window and the workspace stages. A sitting saw the desk say "1 needs you" and the phone say "0 need you" about the same work. `lead/inbox/read` is now the one inbox: the Lead when its stage waits on the person (its open question when it asked one), the desk summary's needs-you chats and Teams, then the kept notices, with one `needsYou` count.

- **The host counts, the surfaces draw.** The count includes the work past the desk summary's cap (`needsYouMore`), so a surface never recounts the list. Rejected: each surface counting the same rows (that is how the two drifted).
- **Needs-you is read from stages the host already sets.** The Lead's window `stage` and the desk summary's needs-you work, never re-derived from cards or prose; a stopped or failed state reaches the inbox only through the stage the host gives it.
- **A notice is kept to read, not counted.** It never adds to `needsYou`, and a notice about work already listed is not listed twice.
- **The Lead's row counts what it waits on.** Three approvals are three, by the same rule as the Lead's header word (`leadPersonNeeds`), so the header and the bell show one number. When the desk waits on more than the Lead does, a waiting Team say, the header shows the desk's number. Rejected: the bell counting rows (one row for three approvals read "1 needs you" beside a header that said 3).
- **An open question holds the Lead's chats.** While the Lead's last question waits for an answer, `lead/chat/start` and `lead/chat/send` refuse with `leadAskOpen`, whatever woke the Lead: the question closes the moment the person writes anything, so a person-caused start under an open question is the Lead acting on a repeat of what it asked about. Only the person's own messages close it; a schedule, trigger or reminder message does not, and neither does the person saying the request again: punctuation, symbols, spacing, polite words (please, 请, 麻烦, 再, 帮我), an address, one word more or less, one word moved, or the request inside a line at most a fifth longer all read as a repeat (`leadRepeatsRequest`); a longer line says more, and a negation the request did not carry (don't, do not, stop, 别…了, 不要, 停下) is never a repeat, while the same words again, negation and all, are. Typed words answer the question as a tap would only when the whole message folds down to one option's label with nothing left but choosing words ("game", "Game.", "the game", "选 Game", "I pick game"; `leadAskOption`), and never when they repeat the request the question was asked about. A message that only mentions an option answers nothing: short labels (A, Yes, 2, 是, team) turn up in ordinary sentences, and a repeat sent from the phone once recorded an answer nobody gave, which then refused the person's own tap. After an answer or an expiry the option itself still counts as a late tap. A question with no expiry held the chats for a day at most until 2026-11-11; it now holds until it is answered or replaced ([why](#an-ask-holds-until-it-is-answered-or-replaced--2026-11-11)). Rejected: letting person-caused starts through (it is the case the sitting caught), and letting any message close the question.

## The away digest links, and its dismissal is the desk's — 2026-11-10

A sitting found the digest accurate but inert: it named chats and Teams with no way to open them, could not be dismissed on one surface and stay gone on the other, and said a chat the person had stopped was stopped by someone it did not know.

- **An item carries what it opens, chosen by the host.** `LeadDigestItem.ref` is picked from the work item's links when the digest is built: done work opens its evidence (pull request, then Team, then chat), open work where it is happening (Team, then chat, then pull request), a decision with no work item its card. The phone reads the same field. A surface still draws a link only when it holds the target. Rejected: letting each surface pick from the work board (the window and the phone would open different things for one row).
- **Dismissal is the desk's, reading is still the device's.** The decision recorded above rejected a shared seen mark because looking on the phone would blank the desktop's card, and that still holds: looking moves only the device's mark. Dismissing is different, because the person has said they have seen it, so it marks the span that digest covered as seen on every device, ending where the digest was built rather than at the click, so what changed in between is still told. Every device's digest loses what lies in that span, so a phone's week-long digest keeps what a desktop's two-hour one never showed. A dismissed id the desk has since rebuilt counts for the span it names. Rejected: one desk-wide mark at the moment of the click (it lost what happened between building and dismissing, and a short dismissal dropped a long digest elsewhere), a dismissal flag per digest id (each device builds its own id, so the phone's copy would survive the desktop's dismissal), and filtering the next digest by the dismissed one's item ids (an item that changes again would be hidden).
- **The actor of a stop is recorded where the stop is asked for.** The ledger saw a chat go idle with its last turn interrupted and had nothing else, so every stop read as unknown. Each door that sends a stop now records who is asking at the moment it sends, and only then: the window's interrupt and the phone's stop are the person's, the Lead's `lead/chat/stop` the Lead's, which cannot use either of the person's doors. The record is a mark in memory, taken without waiting on the file, so a slow ledger never delays a stop; it is bound to the turn being stopped, goes when that turn finishes or another starts, is taken back by whichever door sent it when the interrupt fails, and is read once within a minute, so a stop that never landed does not name a later one; the host never guesses. Two doors inside the minute: the last to send is recorded, and one whose interrupt then fails gives the record back to the one before it, which is the stop that landed. Rejected: inferring the actor from which client was connected (the person and the Lead share the desk), and attributing every stop with no record to the person (a worker that ended its own turn, or a stop sent by another tool, would be put on them).

## A Lead message reads as the Lead's after a stop, and the Lead names its step — 2026-11-11

A worker chat the Lead had started showed "[Request interrupted by user]" and the raw desk envelope as one bubble from the person after it was reopened, and while the Lead worked the desktop said only "Thinking" and the phone's strip went stale while the reply landed.

- **One copy of a reopened chat's history, and it is the richer one.** The upstream loader replays a conversation's history while it loads, and the bridge then replayed it again from the stored file; together they doubled the history and merged the stop marker into the next message. The upstream replay stays: it carries thoughts, tool kinds, diffs and locations, which the bridge's own replay does not. The bridge re-reads only its user messages through the same classifier it uses for its own replay (a stop marker is an Interrupted notice; plumbing the person never typed is dropped; what Claude Code added, looked up in the stored file, is named), and replays the stored `.jsonl` itself only when the loader sent no part of the history — no message, thought or tool call — as for a transcript without a parent chain; a replay of only assistant and tool parts still counts, so it is not written twice. A stored added entry names one replayed message, once: the person's later message in the same words stays theirs. Rejected: muting the upstream replay while it loads (a first version of this change; it lost thoughts and diffs, and a muted category would also drop an update that is live during the load), de-duplicating the two streams by content (two equal messages in a row are real), and keeping both. The upstream replay leaves out entries Claude Code added (`isMeta`), so a reopened chat no longer shows those notices when it replays.
- **A lone stop marker is not the person's words.** When a message has no desk records, `splitContextContent` drops a part that is only the stop marker, or a marker line directly before the envelope in the same part, before it peels the envelope, so a merged replay from any runtime still reads as the Lead's. A message that is only the marker, or text that mentions it, stays as it came. The window and the phone verify the Lead block whether it came merged or was peeled into the item's `context`. Rejected: stripping the marker from the text (it would hide words a person did type) and a per-runtime fix in each adapter (the protocol owns the envelope, so it owns reading it).
- **The host names the step, in plain words, once.** The step comes from the desk call in flight through one table in `packages/protocol` (`leadStepWords`) and reaches both surfaces as `activity.step` on the Lead status. It stays on the last call's words between calls, so the line does not flick back to "Thinking" between two calls of one turn, and becomes "Writing the reply" when the child hands the reply over. Rejected: each surface mapping `activity.method` to words (the desktop and the phone already said different things), a separate phone-only field (the phone reads the same projection on its `lead` topic), and streaming the reply's text to show progress (the Lead's provider calls are not streamed, and a step is what the person asked to see).
- **The composer's draft lives in the store.** The Lead composer keeps its words in the draft store under a key of its own, and an empty box is saved as no draft, so clearing it and coming back shows it empty. Rejected: keeping the draft in the page's own state (it is lost when the page is not kept) and skipping an empty write (the old words would come back).

## A failed usage refresh keeps the last good reading — 2026-11-10

A refresh that failed after a good reading used to turn the account Unknown everywhere: the desk kept the figures, but the standing threw them away, so the phone showed "Unknown" while its own inbox said "20% left", the Dashboard card drew "—", and a prepaid balance vanished outright. The last good figures are still the best answer anyone has, so every surface now shows them with when they were read and that the refresh failed (#2094).

- **Show, but decide nothing.** The card, the Plans row and the phone row draw the kept figure and standing under a stale mark and "Couldn't refresh". The overview's order, the sidebar strip, "Start on" and pacing still treat a failed read as unread: a figure 25 minutes old is fine to read, but a 90% from before a failure must not put that account ahead of a live 40%.
- **Unknown means never read, or out and since reset.** `usageStandingOf` returns `unknown` when a report with an error has no figure at all; a kept reading gets its own standing, without a Short forecast, since a rate from old figures is a guess. The exception is a kept reading that was Out whose blocking windows have since reset: Out with a Back time already past is wrong, and Ready beside figures that still say 0% left contradicts itself, so it is Unknown until a refresh answers.
- **One account has no "first".** The desktop note, the Lead's `pacing` and the phone's `pacing` all say nothing with fewer than two accounts.
- **Rejected:** a new `stale` standing status (every surface and the phone would need a seventh state for what is a mark beside an existing one); persisting the cache to disk so a restart keeps the last reading (worth doing, but a separate stored file and its own boundary); hiding the figure behind a "show last reading" click (the person asked what is left, and one more click answers the same question later).

## The pacing note names one account across all accounts — 2026-11-10

"Which account resets soon with a lot left, so which do I use first?" had no answer anywhere: the Use it first note sat on one card at a time, the Lead could only read windows and work it out, and the phone showed none. `pacingAdvice` (`@harnessdesk/protocol`) now picks one account across every agent from fresh readings: allowance about to be lost wins, soonest reset first, and otherwise the account with room whose window refills first. The Lead's `usage_summary` returns it as `pacing` with the window, what is left, the reset time and how old the reading is; the Dashboard's What is left line and Settings › Runtimes say "Use … first — its Weekly has 70% left and resets …"; the phone gets the same fields.

- **Only use-first is a note on a screen.** "Refills soonest" with nothing about to be lost is an order, not news, and "Start on" already says where to begin; the Lead still gets the soonest answer so it can reply to the question either way.
- **One rule, three readers.** The desk, the Lead and the phone all read `pacingAdvice`, so they cannot name different accounts; the phone never works it out.
- **Rejected:** a note on every card (it is the comparison across accounts that answers the question, and six notes say nothing); recommending from a failed or stale reading (the advice would follow figures nobody can vouch for).

## Duplicate work is refused as an answer, and reminders are entries — 2026-11-11

Sittings saw the Lead start a second chat for work it already had open (the first try had stopped, or the new title said "retry"), and a refused start parked the Lead in a state that only Resume cleared. They also saw the Lead say "I'll remind you" with nothing set, and a digest report a reminder as arrived before its time.

- **A matching start returns the item.** The guard compares titles in one project: open items, and items whose chat was stopped within a day when a person's message woke the turn, with attempt words (and a bracket of nothing but them) set aside. It refuses with the item's id so the Lead can offer to continue there. A second attempt is the Lead asking first and passing `ledgerItem`, within the same day. Rejected: refusing only on exact open titles (the sittings' duplicates all slipped past it), letting the model decide alone (the host is the one that knows what is open), and counting finished work (a recurring task would be refused every day after its first run).
- **A newer attempt decides how the item ends.** Chats already on an item are marked superseded when another joins, so a stopped first try no longer closes a retry that finished. Rejected: dropping the old chat from the item (its history and its link would go with it).
- **A refusal is an answer, not a stop.** The refused tool call goes back to the model in the same turn. Rejected: parking it as refused for Resume (the person had to press Resume to hear the Lead say it already had the work).
- **A stopped Lead chat is ordinary.** The item reads as stopped and the Lead sees that on its next turn; nothing waits on the person. Who stopped it is recorded where stops are attributed (the digest's `stopping(chat, by)`), not guessed here. Rejected: a refused or waiting state after a stop (it asked the person to confirm what they had just done).
- **A reminder is a host entry with its own id.** It is listed where the person can cancel it, fires once at its time, and is reported as arrived only after it fired. The Lead may say it set one only when `reminder_set` returned the entry. Rejected: keeping a reminder as a time on a work item (it could not be listed, cancelled or held to whom it was for, and closing the item lost it silently) and letting the Lead keep reminders in its notes (nothing would fire).
- **A person's reminder ignores quiet hours; a check-back does not.** The person asked for that time. The Lead's own check-back is proactive work and keeps the autonomy and quiet-hours gates. Whose a reminder is comes from what woke the turn, added by the Lead's dispatcher: a reminder set during a trigger, mention or scheduled run reads text no person wrote, so it is the Lead's own and gated. Rejected: trusting the model to say whose it is, and treating every `reminder_set` as the person's (an unattended turn could then wake the Lead in quiet hours). A reminder on a closed item is refused with the reason rather than set where it would never fire.

## The Lead proposes its own settings, and the person applies them — 2026-11-11

Sittings asked the Lead "from now on, don't tell me about desk changes, just note them" and "report conclusion first". Both became memory notes: the Lead had no way to touch a mode or a rule section, so the desk kept reporting and the words never reached the section the person reads in Settings. The same sittings heard the Lead say it had proposed something before, that the person had declined it, or that it had reminded them, with no record of any of it, and start a third and fourth chat on work the person had stopped before.

- **A proposal, never a write.** The Lead gets `autonomy_propose` and `rules_propose`, which only put a card in front of the person; Apply is `lead/settings/decide`, which is on neither the Lead's door nor its tool list. Rejected: giving the Lead `lead/autonomy/set` or `lead/rules/update` behind an instruction to ask first (a model that skips the instruction would widen its own autonomy, and Act is exactly the direction it would be asked to go), and a proposal the host applies after a timeout (silence is not consent).
- **Apply goes through Settings' own path.** A mode is recorded as the person's change and holds at once; words are a new version and reach the model at the next epoch, which the card says. A rules proposal is made against a version, and words the person changed since make it stale rather than written over. Rejected: storing proposals as a second kind of rule version (history would then hold words nobody chose).
- **One card per slot, and a No is remembered.** The same proposal again moves its card under the newer reply; a different one replaces it. A declined change is refused until the person writes again, so the Lead cannot ask until it gets a yes. Rejected: refusing it forever (the person may change their mind and ask).
- **History is what the desk recorded, read every turn.** Each proposal (settings and memory) carries its events with times, and each reminder whether the Lead told the person; the Lead reads them in its status blocks and is told to say nothing about earlier proposals or reminders those lines do not show. Rejected: asking the Lead to remember (that is how it invented a decline), and putting the history in its notes (a note is the person's to edit).
- **The phone answers what fits on it.** A phone may say No to any card and apply a mode or one added line it showed exactly, but a section's whole new words, and a line the phone's scrub changed (a path, an address or a key-shaped string hidden), are applied at the desk, where they can be read in full against the words in force: Apply writes the original words, so agreeing to a redacted line would be agreeing to words never read. The phone's copy says so with `deskOnly`, from the same check the desk applies, rather than the phone inferring it from a missing `add`; the desk tells a phone's Apply from the window's by the device the phone link adds, never by what the request says. Rejected: the same Apply everywhere (a whole section is too much to judge on a small screen), and hiding those cards from the phone (the person would not know one waits).
- **Cards are bounded and their Noes are not lost.** Applied and stale cards go first, a waiting card never goes, and a No is kept apart from its card so it still stands after the card is dropped; at most three new cards come between two of the person's messages. A proposal made over a never-edited section records which shipped default it was made on, so an update that changes the default makes it stale instead of pinning the old words under the Lead's line.
- **Stopped means ask.** Each attempt's stop is kept with who made it, and a further start on that work is refused by the host until the person has answered, even when the person's own message asked for it, because the person may not know it was already stopped. One stop is enough (#2145): a sitting saw a sixth attempt start under the item after a single counted stop, because two were needed. Only the person's stops count (and a stop the desk could not attribute, which may have been theirs): the Lead stopping its own chat is not the person saying no. The refusal names the last chat so the Lead can offer to continue it, start fresh or drop the item. Rejected: an instruction only (the sittings show the Lead starting attempts the person had asked for without saying they had failed), and a hard cap (the person can always say start fresh).

## A reminder wake is the desk's, and the Lead knows the time — 2026-11-11

A sitting saw a reminder's wake shown as the person's message on both surfaces, the wake turn end in a summary and wait for the person with nothing said, the reminder fire about a minute late, and the Lead later claim it had reminded the person. The same sitting saw the conversation summarise itself four times in an hour, a summary keep "Work ledger: empty" after the ledger was used, and the Lead guess how long ago something happened.

- **A wake is a journaled user turn marked `wake`, projected as a desk line.** The provider needs a user turn to answer, so the journal keeps one, and the mark decides everything else: the child reads it behind a desk-wake prefix, the person's checkpoint section leaves it out, Resume does not count it as unanswered, and the window and phone receive `role: 'system'` with "Reminder: …". Rejected: a new journal role (every reader of the journal would have to learn it, and the provider still needs a user turn) and rendering the wake as a notice only on the desktop (the phone and the Lead's own transcript would still read it as the person's).
- **A person's reminder wake is an ordinary turn.** It was committed as proactive, and a proactive turn's plain text is dropped, so the reminder was never written. Rejected: making the reminder a proactive card (the person asked to be told, not to approve something).
- **A journal is read forward only.** A journal a newer desk wrote (here with `wake` on a message, as before with a record kind like `worker-rule-saved`) is not readable by an older desk, whose strict parser refuses keys it does not know. Rejected: loosening the journal parser to skip unknown keys (it is the allow-list the child relies on to read nothing it did not expect).
- **Delivery is a field on a fired entry, not a new state.** `delivery: said | missed` with its time keeps `fired` meaning "the wake went out", which older phones already understand, and adds whether the words reached the person. A wake that ends without a reply is tried once more under its own key; a second wake the Lead cannot take now (a turn in flight) is tried on later passes, and the reminder reads missed when that wake also ends silent or an hour has passed since it was due. The Lead is told in its `<work-ledger>` block. Only the Lead's turn that answers the wake counts as said, ending at the next user turn of either kind. Rejected: new `said`/`missed` states (an older phone drops a reminder whose state it does not know), retrying until said (a Lead that cannot answer would be woken forever), and marking missed at the first refused retry (a turn in flight would mark a reminder missed that was about to be said).
- **A thread that waits on the person still says the person's reminder (#2119).** The loop takes no wake while the thread waits on the person, after a failed request, a summary to resume from, or a plan not yet decided, which is when "remind me in ten minutes" is most often asked. The reminder is written after its wake entry as the Lead's own message, "You asked me to remind you: …", with no model request, and the thread keeps its waiting reason and way out. Rejected: resuming the thread for the wake (it would act on whatever the person had not yet decided), waking the model anyway (the waiting stage is the loop's own fence), and leaving it to be retried (it would read missed an hour later, never said). The Lead's own check-back still waits with the thread: silence is a fair answer to it. The line carries `reminded` with the reminder's id, so it is not the Lead's reply: the count of chats the Lead started since its last reply survives it, and the context store sends it with its wake entry, so a resumed Lead neither repeats a chat nor says the reminder twice. Rejected: one journal record for the entry and the line (a message event holds one message; the same key offered again finishes the pair instead).
- **One timer for the soonest reminder.** The minute timer ran on the host's start phase, so a reminder could fire up to a minute after its time. The host now arms one timer for the next reminder still ahead and keeps the minute timer for anything overdue. Rejected: a shorter interval (it still misses by its period and wakes the host for nothing), and arming for overdue reminders too (one that cannot be delivered now would re-fire the timer at once, forever).
- **Quiet desk wakes are not kept.** Measured on the rig, forty desk changes the Lead let pass took the stored conversation from 2 to 82 turns and pressure from 0.04 to 0.41, because each left a stub user turn and a quiet reply. A wake that called no tool, asked nothing and stayed quiet now keeps no turns, and still reports what its request measured so the context readings stay true. Rejected: raising the soft line (it would only delay the same growth and leave less room before the hard line).
- **The clock rides the volatile tail.** The current time, date and zone close every request, after the cache mark and stubbed when stored, so the cached prefix stays byte-identical. A turn already at the 64-block limit goes without it. Rejected: the standing instructions (they change only per epoch, so the time would be stale for hours, and putting it there would break the cache every minute), and appending it to the turn's last text block (it could land before the cache mark and be stored inside the person's words).
- **A summary is written against the desk as it stands.** The compaction request carries the current clock and ledger block after the turns, marked newer, so the summary cannot keep a ledger fact the conversation once had. Rejected: telling the model to leave the ledger out of summaries (the Lead then forgets open work exists between summaries).

## An ask holds until it is answered or replaced — 2026-11-11

A sitting saw every question the Lead asked "expire" within a minute: the phone answered "This question expired. Nothing was done.", the desktop's buttons stayed live with no receipt, neither question reached the phone's Inbox, and the header kept saying the Lead waited on the person. Nothing had timed out. Both questions were the closing line of a report from an automatic wake, whose options sit on `proactive`, not `ask`. Both surfaces drew them as answer buttons and sent the tap with the message's id, but the host only knew a reply's `ask`, so a tap named a question it did not hold and was refused as expired at once. The inbox listed the Lead's question only while its stage waited on the person, which a question never sets.

- **One reading of what a question is.** `leadMessageAsk` in the protocol turns a reply's `ask`, or a report's options with a recommended one, into the same question, and the host, the inbox and the hold all read through it. Rejected: making the surfaces stop drawing a report's options as buttons (the person was offered a choice and should be able to make it), and copying a report's options into `ask` when it is journaled (the journal is an allow-list, and two fields saying one thing drift).
- **Time alone never settles a question.** One with no expiry of its own holds until it is answered or the Lead asks a newer one; the day-long cap is gone. Rejected: keeping the cap (a question left overnight was quietly dropped from the hold and the inbox while the thread still offered it).
- **A newer question replaces the older one.** The Lead can only be waiting on its newest question, so an older one still open reads as `expired` with `replacedBy`, and a tap on it is refused with `lead-ask-replaced`, nothing done. Rejected: a new `replaced` status (the phone in the field decodes the status as a closed set and would fail to read the whole view; an optional field it does not know is skipped), and leaving old questions answerable (two open questions let a tap on the first act on a choice the Lead had already moved past).
- **A question is an inbox row of its own.** `lead/inbox/read` lists it from the same `unansweredAsk` the chat hold reads, apart from the Lead's stage, so it arrives when asked and leaves when answered, expired or replaced, and the count follows. Rejected: setting a waiting stage when the Lead asks (the stage says what the Lead's turn is doing, and a report from an automatic wake has no turn waiting).
- **An upgrade settles the reports already there.** Reports' questions were never answerable before this, so on every start each report question the thread holds with no record of its own is recorded as expired then, nothing done; the set is taken before the file is read, so a report that arrives meanwhile is new. Rejected: tracking them all as new (the newest ignored report, days old, would land in both inboxes dated now), a cut-off by age (any age would still reopen a report the person had chosen to leave), and a one-time marker in the record (an older build keeps the marker but records no report, so going back to it and forward again reopened what it saw).
- **One count for the question.** `leadPersonNeeds` counts the open question, and `leadNeedsYou` is the Lead's whole count, which the inbox's Lead rows add up to and the Lead's word says. A question's replaced state outlives its own clock: replaced first, it stays replaced. Rejected: counting the question only in the inbox (the header and the bell agreed only through the desk's total, and the rule that says they never disagree did not know the question).
- **One receipt, drawn the same everywhere.** A settled question keeps its options as disabled buttons, the picked one marked, with one line: who answered, on which device, and when, or that it expired or was replaced and nothing was done. A newly seen question publishes `lead/presence/changed`, so the other surface redraws without waiting for its next read. Rejected: settled options as plain text (they read as part of the message, not as a choice that was made or missed).


## Carry on past a usage limit — 2026-11-11

A conversation that reached its usage limit used to stop where it was. The usage notice offered the next account to new sessions only, and an open conversation stayed on its account because its thread lives in that account's history. Now a running conversation carries on: on another account of the same agent, in a new conversation with another agent, or by waiting for its reset, after asking or by a rule the person set. The desk's rule is the `carryOn` preference (Settings › Permissions › When a usage limit is reached); an agent's own **When an account runs out** overrides it, and **Always do this** on the card writes whichever of the two the card names. The order candidates are tried in is the pacing order ("Account pacing is an order and a note, not a scheduler", above), so this adds no ranking of its own and no new request to any vendor.

- **The switch is an item in the transcript, not a notice.** Notice kinds can be muted, and a muted switch would leave a conversation that changed account or agent with nothing to say so; a notice also has no field for the two sides or the link between two conversations. Only the inbox's kept copy (*Usage limits in a conversation*) can be muted. Rejected: a `NoticeItem` kind (mutable, and shapeless).
- **Choose before waiting.** The candidates are ranked before any timer is set, so a conversation never waits for a reset while an account with room sits idle. Rejected: "retry at reset" alone (it waits even when the next account is free).
- **"Soon" is five hours.** A reset retry comes before another agent only when the reset is within one five-hour window: a handoff to another agent loses its working context (it gets a packet, not its memory), and beyond a window a stopped conversation costs more than that loss. A weekly limit resetting in days always prefers a switch. It is a number to revisit with use.
- **No automatic switch to an API-key slot.** A gateway slot bills a key by the token, which no rule the person set for their plans agreed to. The card may still list it, marked API key, for the person to pick.
- **An unanswered ask spends nothing new.** Only a yes or an always rule may spend another account or agent. At a known reset an unanswered card resolves as Wait until reset, one retry on the same account the person already chose; with no reset known it stays asked and the conversation stays stopped. Rejected: a timeout that takes the recommended switch (it would spend an account, or send the text to another vendor, without anyone saying yes).
- **A seat's switch is a replacement seat.** A seat record is bound to its session and label, and the flow engine stalls a run whose seat changes label under it, so a Team seat that runs out is replaced by a new seat of the same run on the same card, after the same independence check a reviewer's provider takes. Rejected: mutating the seat in place (the evidence would describe a seat that never existed).
- **Other agents are on by default.** The owner's rule asks every limit to carry on, and the same agent is not always there; the row's own line and `docs/data-boundaries.md` say the recent text goes to that agent's provider, and the switch turns it off.

## An MCP client starts work only when you let it — 2026-11-11

`harnessdesk mcp` serves the command table to any MCP client, so an agent can read the desk, wait on a run and read cards. Starting work spends, and the person deciding to let an agent spend is not the agent. A client that says hello with `surface: 'mcp'` may start a flow only when Let MCP clients start work is on in Settings › Permissions › MCP clients, and then up to a number of starts a day (5 unless changed, from 1 to 50).

- **Consent, not security.** The surface is stated by the client, so the switch is a person's consent for well-behaved clients, not a lock: the socket's file permissions stay the authority, as they are for the command line. Rejected: treating the stated surface as an identity (anything that can open the socket can say it is the command line).
- **A count, not money.** Money is known only after the fact, and a subscription seat has no price, so a cap in dollars could not be held at the moment of the start. The count is held there.
- **The person's day.** The count resets at local midnight, the day the person lives in; a clock set back never resets it. Rejected: a rolling 24 hours (it never says when the next start is free).
- **A failed start is refunded.** A start the desk refuses after admitting it gives its slot back, so a typo does not use up the day.
- **Only saved flows, attended.** The start's source must be exactly a flow saved in the project, the person's flows or the app, and the run is attended, so a seat whose ceiling it cannot hold asks the person. An MCP client never raises a ceiling: `--unattended` is not offered, and the desk refuses it anyway. Rejected: flows written by the agent (it would choose its own permissions).
- **The framing is not shared with `packages/mcp-tools`.** That binary reads stdin as soon as it is imported, and the command line may import only the protocol and the client, so the forty lines of JSON-RPC framing are mirrored and a test holds the two to the same rules.
- **Who started a run is stamped by the desk.** `startedBy` comes from the connection, never from the call's parameters, and the app shows an MCP chip on such a run.

## The menu bar figure follows the current agent — 2026-11-11

The menu bar carried the least left across every agent, so one plan spent for 22 days held it at 0% for 22 days, though it was not the agent anyone was using. It now follows the anchor, the agent the next Send goes to, because that plan decides whether the Send starts; the tooltip and a check in the Usage submenu say whose figure it is. An agent that is out shows when it is back (`↻4d`) instead of 0%, since a spent plan leaves one thing to act on, which is when to return. With no current agent, no reading, or a sign-in still to do, the item shows the mark alone.

- **Rejected:** least left skipping spent agents (the figure changes owner without saying so, and a bare 12% could belong to any of them); the mark alone until a plan runs low (it hides the amount left, which is the reason to glance at the menu bar).

## A request from a thread is `@harnessdesk`, and only the Lead takes it — 2026-11-11

Intake's issue source fired on every comment from `from`, so an armed `commented` trigger could not tell "please do this" from discussion, and a plain comment on a pull request was never read at all. A person needed a way to ask the desk from the thread where the work is discussed.

- **`@harnessdesk`, the project's own name.** `harnessdesk` is the project's GitHub organization, and the `harnessdesk` App and its bot belong to it, so nobody else can take the word; an `@` of an organization notifies nobody, so asking pings no one. It works for every user with no account of their own, because each desk reads with its own signed-in token, and a later App can reply under the same word. Rejected: the person's own login (it notifies them, and differs per person), a separate bot account (a credential to mint and hold), and `/desk`, the other word the owner weighed (a slash word carries no name the thread can see as the desk's).
- **First line only, and a parser that says no.** `summonsOf` in `packages/server/src/findings/publication.ts` is one pure function: the first line, after leading spaces, starts with the word followed by nothing, a space, `:` or `,`. It is the literal first line: a blank line before the word makes no request. A quote, a code line (fenced, or indented as markdown would render it), a longer name, a team mention and the word mid-sentence are refused, so quoting someone's request never asks again.
- **An edited comment never asks, on the forge's word.** Anyone with write access can edit someone else's comment, so an edit could put the word in front of words the trigger's `from` would accept as yours. Equal creation and update times do not prove a comment unedited: an edit within the same second leaves them equal. So every comment that asks has its edit history read from GitHub's GraphQL API (`lastEditedAt`, `includesCreatedEdit`, by node id, at most 100 in one query a poll), and only a comment it calls never edited asks. Differing times still refuse without that read, and reactions do not move a comment's update time, so the cheap check costs no request a person made. An edited comment, or one whose history could not be read — any failure, error or missing field — is still offered as a request carrying `unedited: false` or `null`, and admission records it as skipped with the reason, once: refused by name, never dropped unseen, never retried. A review's summary never asks, because the forge says nothing of whether it was edited; its inline comments carry the request instead.
- **Only the Lead.** A flow a trigger starts never receives outside text (`startTriggered` fills only its defaults), so a flow target would run without knowing what was asked. The Lead already reads outside text fenced as untrusted and turns it into a plan the person approves, so the boundary stays where it was. The definition refuses `mentioned` with a flow or an Agent target, naming the fix.
- **The first line is the host's.** "Request on pull request #12 from you" comes from validated facts — the subject, the author's digest against the armed account, `authorWrites` — never a login or a display name, which the asker controls.
- **Comment reads cost one call, not one per pull request.** The GitHub budget is shared by every desk on the machine, so conversation comments come from one repository-wide list by update, routed by `issue_url`; reviews stay per pull request, only for those the existing list read shows as updated, and a newly submitted review's inline comments are read from that review, because they carry the time they were drafted and a read by time would miss a review drafted before the window. Coverage is a window plus the ids handled inside it, never a mark per pull request that could be forgotten and make an old one look new. The comment window moves with the newest comment a complete read covered, on its own, so steady talk while no pull request moves never piles up into a gap. A review is new by its submission, not by the highest id, and a pull request read within five minutes of its update has its reviews read once more five minutes later, because a review submitted within the same second leaves the pull request's update unchanged. That second read is one delayed reconciliation, not a read every poll: it starts at the page that held the last review listed (a pull request with 900 reviews costs two pages, not ten), and at most twenty run a poll, inside the hundred pull requests one read may cover, the rest waiting for the next poll rather than dropped. A hundred moved pull requests of 900 reviews each cost about 1,200 review reads over ten minutes instead of 6,000. Reviews are listed in the order they were created, so a review drafted long before and submitted in that same second lands on an early page, not on the tail. The first read therefore keeps the id of the last review it listed, and the second read checks that the same review still sits where it was; when it does not, it reads the whole list again, once. A list that showed a draft (only the desk's own are visible, and only a draft can be deleted) keeps no such id, and its second read is the whole list. Old pages are read again only when the list has actually moved. A burst becomes a gap rather than a long read. A trigger that asks may be armed on a source watched long before it, so request reads start at the earliest such arm's own baseline, never the source's: an hour of old talk is neither read nor asked, and admission refuses a request from before its arm as well.
- **Nothing is posted back, and approval stays.** The owner chose both for now: one path, which can be loosened later, and replies wait for the App. Approval is the host's, not the prompt's: until the person approves the plan, a goal whose origin is a request starts and sends nothing — not even an ordinary chat a `manage` policy would allow — refused at the Lead's tool admission, at the chat service, at a Team start, at the Lead's door to the host and at every Flow dispatch of a Team already running. Every one of those asks the same question (`leadRequestFenced`), so they cannot drift: it holds while the plan waits, once the approval's time runs out, and while a renewed or revised plan waits, on a reopened journal too. A stop still passes, since it narrows. The request's words never stand as "the person's words" in a worker's brief.

## The desktop surfaces say what the phone says — 2026-11-11

A sitting saw the header say "1 needs you" over a Work list with nothing under Needs you, a desktop reply with no Team link where the phone showed one, the Runtimes page and the Dashboard describe one account two ways, the phone list seven accounts where the desktop listed eight and say Unknown where the desktop said Not reporting, a three-day-old 80% notice still on the phone, and the Lead cite a suggestion no screen showed.

- **The Work list counts against the inbox.** Teams and chats the inbox counts as needing the person that no open item links are listed under Needs you, worked out by one function both surfaces use (`leadWorkWaiting`), so the header and the list agree whoever started the work. Rejected: listing only Lead-started work (a Team the person started is still what the header counts) and adopting such work into the ledger (the Lead would then report and close work it was never asked for, and the person's Done would close someone else's Team). A Team can reach the list by its goal id (the inbox, the desk summary) or by its board id (a reply's reference), so both go through one resolver (`leadTeamKey`) before they are compared or counted; on the host today both sides use goal ids, and the resolver keeps that from being something the count depends on. The badge is the open items plus those rows, from one function (`leadWorkOpenCount`). Rejected: comparing raw ids (a Team linked by its board would be listed and counted twice).
- **A reply's Team link resolves the way the phone resolves it.** The Lead names Teams by their board's id; the desktop now finds the Team by its goal or by its board. Rejected: having the Lead name goals (the tools already name the board, and the phone accepts both).
- **One list of accounts, one word.** Every surface takes its accounts from `trackedUsage`: a reading of each tracked agent, and one Not reporting entry for a tracked agent nothing has read. Rejected: leaving the agents nothing read off the phone and the Lead (the person counted eight on one screen and seven on the other), and "Unknown" for it (the desktop already said Not reporting, and Unknown reads like a reading that failed). A stand-in carries an explicit `notReporting` flag, and only an agent the desk has asked gets one: until the first read after a start finishes, no agent is said to be silent. A reading that came back `unknown` keeps the word Unknown. Rejected: inferring silence from the stand-in's "no source available" label (any report could carry it) and labelling every `unknown` standing Not reporting (a failed read is not a silent agent).
- **One agent's failed read is that agent's, not the desk's.** `UsageService` settles each agent's read on its own: a read that throws becomes that agent's report with an `error` (its kept reading if it had one, Unknown if not), and the agent counts as asked either way. A failure that is not about sign-in says nothing about sign-in, so an error the meter marked `needsSignIn` keeps that mark through every later failure that is not an answer about sign-in (a read that throws, a meter outage beside a kept reading or with none, the runtime's own limits failing) until a reading or a fresh answer from the source replaces it (#2141); a carried-on turn reads it to pass over an account that has to sign in. Rejected: letting an outage with nothing to keep drop the card, as other silence does (the account that has to sign in would vanish from the cards and look like a fair pick). A full refresh in the window marks the desk asked as a first read does. Rejected: leaving `Promise.all` to reject the whole `usage/reports` (one unreadable ledger hid every reading and, with nothing marked asked, every Not reporting card until the next refresh, with nothing saying why), and counting only the agents that answered as asked (the failed one would never get a card at all). The window keeps which agents were asked, not whether any were: an agent the window knew when it asked, or one the answer names, is asked once the answer arrives, and an agent added later is read at once and called nothing until that read is back. Rejected: one flag for the whole window (an agent added after the first read was called Not reporting before anything had asked it) and a new wire field carrying the host's set (the answer already proves it, since the host replies only after every read settled). A notice a reading no longer bears out is retired on every path a reading arrives by, the first `usage/reports` included, not only a refresh or a push. `silentAgentsOf` takes no usage gate: it lists only agents whose account read answered that nobody is signed in, a fact no usage read changes.
- **A silent card says it once.** The chip says Not reporting; the card adds one line, that nothing came back when it was last asked, which is true of an agent that never reports and of one that usually does. Rejected: the dash with its own "not reporting" (the chip again) and "This runtime reports no plan usage here" (false of an agent that reports most of the time).
- **Each copy of a brand mark owns its ids.** A colour mark's gradient is found by id, and the page resolves an id to its first copy; when that copy is in a page kept mounted but hidden, the gradient paints nothing and every later copy of the mark drew nothing. `BrandMark` suffixes the ids with a count kept for the whole document, for the few marks that carry any. Rejected: React's `useId` (unique only within one root, and the preview harness mounts fixtures as second roots beside a hidden main one), hiding the other ink twin with `visibility` rather than `display` (the hidden page is the cause, not the twin), one shared sprite of gradients (every root, the design explorer and the site demos would have to mount it), and dropping the mark from the card heading (it is how the Dashboard tells agents apart). A plan card's lines start their first ink on the card's text edge: the heading's mark, the figure, the note's glyph; the name follows the mark as it does on every Dashboard card.
- **The Lead repeats the desk's sentence.** `pacing.said` is written by the desk; for the account that resets soonest it says that this is only an order to use them in. Rejected: letting the model phrase the reason (it called an ordering a system suggestion no screen shows).
- **A usage notice carries its figures in its key and leaves once they are wrong.** A crossing is kept under the agent, account, window, reset and line it crossed, so a newer reading alone shows whether it still holds; a crossing kept before this, which carries none, leaves only when the agent its title names has been read again and every reading of it is newer; when the title fits no agent, or more than one, it stays. Rejected: expiring notices after a fixed time (a notice that still holds would go, and a wrong one would stay until then), dropping an old notice on any newer reading (a reading of another agent says nothing about it), and parsing the figures out of the sentence for every notice (the key carries them for every notice from now on).
- **The window title follows Settings.** Settings is a page of its own, so the window says Settings rather than the last chat's title. Rejected: titling every page by kind in this change (Dashboard, Agents and Teams still title by the chat; they are listed for a later change).

## Test connection starts a server, once, on a click — 2026-11-11

An MCP server that does not work shows up today as an agent that silently has fewer tools. Some agents report each server's state (`RuntimeExtensions`), and HarnessDesk shows what they report; agents spoken to over ACP report nothing per server, so for them nothing on screen could say whether a server starts at all. Test connection on a copy of a server in the Library answers that: the host starts the server from its declaration, sends `initialize` and `tools/list`, and stops it. This is the one place the host runs an MCP server itself, against rule 3 and against `RuntimeExtensions` running no registry of its own, so it is held to a short list.

- **A probe, not a registry.** Nothing is kept: no state, no list of servers, no connection left open. The answer is a tool count, the server's name and a reason, shown on the row until the sheet closes. Rejected: a status column filled on page open (it would start every declared server, including a repository's, each time someone looks).
- **Only on a click, and one at a time.** The test never runs on open or on a timer, a second click while a test of the same copy runs answers Busy, and a desk runs at most four tests at once across all servers. Rejected: retry until it answers (a broken server would be started in a loop).
- **The window names a copy, the host reads its command.** `library/mcp/test` takes a server's name and the path of one copy the Library listed; the host checks that path is one of the files where an agent keeps MCP servers, resolves it the way the Library does, and reads the declaration itself. A command, an address or a variable in the call is never used. Rejected: (agent, scope, name) (two files can declare one name, and the scope would come from the window rather than the table that decides it).
- **A project's server asks first.** A server a project's own file declares (a `.mcp.json` in the repository, for one) was chosen by whoever wrote the repository, so the host answers `confirm` with the exact command and folder, the variables that decide what starts or what it loads first (`PATH`, `NODE_OPTIONS`, `LD_*`, `PYTHON*` and the like) with their values and every other variable by name, or the address and header names, and runs only when the call returns the digest of what was shown; a file changed in between asks again. The dialog spells a character that draws nothing or reorders text as its code point, and cuts a long value with a count of what it left out. A server in the person's own settings runs on the click, in the project folder when one is open, as the agents run it; the confirmation is the window's gate on a repository's choice, not a boundary against the window itself. Rejected: asking every time (the person wrote those) and trusting a flag from the window (the host would run what it never showed).
- **Values stay out.** A header's value, and the value of any variable but those that decide what starts, is never in the answer, the confirmation or the folded server output; values the declaration carries (variables, headers, arguments, the address with its user name, password and query values) are masked in anything the server says back, and the output is cut to 4 KB and sanitised like a transcript. A proxy passed on from the desk goes without the user name and password in its URL.
- **A test never signs in.** A 401 answers Needs sign-in and points to the agent's own server sign-in where the agent has one. Rejected: running OAuth from the test (the credential would belong to HarnessDesk, not the agent that uses the server).
- **Bounded, and nothing left running.** Fifteen seconds for the whole test. A local server runs in a process group of its own, with the variables it declares on top of a minimal environment (none of HarnessDesk's own), in the project folder for a project's server; at the end the group is sent SIGTERM and, after half a second, SIGKILL, so a child that ignores SIGTERM goes too; when the desk stops, every group still running is killed at once. A remote server is asked with no redirect followed, and a session it opened is ended. It does not share the attachments' MCP transport, which is built for a long-lived connection rather than a probe.
- **Not in this change.** `${VAR}` references in a declaration are passed as written, not expanded; servers kept per project inside a user settings file are not listed by the Library and so cannot be tested; on Windows the server, not its group, is stopped.
## A stop ends the subagents a DeepSeek prompt started — 2026-11-11

When a person presses Stop, every subagent the conversation started stops too. DeepSeek Harness 0.2.2-rc.2 settles `session/cancel` as `cancelled` within a few milliseconds, but a child started with its `subagent` tool runs on (its `sleep 90` was alive 10 s later), and when it finishes the root answers again with no prompt open, which the adapter drops as it drops every update outside a turn. Closing the session is the only verb that ends the child. So an ACP agent can now declare `cancelLeavesSubagents` (set in the `dsh` template, passed through `AcpAgentConfig` the way `perToolMcpApproval` is): after the cancelled prompt settles, the adapter closes the session and reopens it in place on the same handle, and a send made meanwhile waits for the reopen.

Measured against the rc.2 build through a fake loopback endpoint, with fake keys and a home of its own per run:

- **What it advertises.** `sessionCapabilities: { close, list, resume }`, never `loadSession`; `session/load` answers "Method not found".
- **The reopen path is `session/resume`.** It is the only one offered. After close and resume, a follow-up prompt reached the model with the earlier prompt and the subagent call in its history, and a reasoning effort set before the stop was still set. It replays nothing, so nothing is dropped from what the desk holds; an agent that offers `loadSession` would be reopened with `session/load`, its replay dropped for the same reason.
- **Close ends the child every time.** 8 of 8 rounds in one process. With the child in `bash sleep 90` (5 rounds) the close answered in 26–32 ms and the `sleep` was gone 188–199 ms after it was sent (polled every 50 ms); with the child waiting on a model stream that never ends (3 rounds) the cancel left the stream open and the close ended it 1–3 ms after it was sent. No update arrived for the session between the close and the resume.
- **Close plus reopen takes about 40 ms** on a shared process (resume answers in 10–16 ms). Through HarnessDesk's own `AcpRuntime`, Stop returned 42 ms after it was pressed and the child was gone 207 ms after; the follow-up answered in 44 ms. When the session has a process of its own (a desk with git steering gives each one its own), the process is stopped and a new one resumes the session: Stop returned in 1.24 s, mostly the new process starting, and the follow-up answered in 65 ms. Without the declaration the child was still running when the run ended, and the follow-up streamed its answer but its turn did not end until the agent was stopped, because the root was still waiting on its child.

- **A failed reopen detaches the conversation** as a dead agent's is: an error names it, the handle is let go, and the next message opens the conversation again. Rejected: retrying in place (a resume the agent refused once has no reason to succeed on the second ask).
- **Only a stop with a turn running closes the session.** An idle conversation has no child to end. Rejected: a new session in place of the old one (the agent's own context would be lost) and killing the agent's process on every stop (it also ends every other conversation that shares the process).
- **Every wait is bounded.** The stop waits at most 5 s for the cancelled prompt to settle, then ends that turn as stopped itself, so the close never turns it into a failure. The close and reopen then get 15 s before the conversation is detached as above; an open that answers after that is closed again. A permission the closing session asked for is withdrawn, and one it asks during the reopen is refused. Of what the reopen says, only the session's mode, model and options are kept.
## Stop stops the whole tree — 2026-11-11

When a person presses Stop on a conversation, every sub-agent that conversation started stops too. Claude Code's interrupt is reported to end its own sub-agents, foreground and background (not re-measured in this change); Codex's did not. In 0.167.1 `turn/interrupt` becomes `Op::Interrupt`, then `Session::interrupt_task` (handlers.rs and mod.rs under codex-rs core/src/session), then `abort_all_tasks` (core/src/tasks/mod.rs), which aborts the active turn of the one thread named. A spawned agent is a thread with turns of its own, and nothing passes the interrupt down, so a stopped root left its sub-agents working.

- **The adapter asks each one.** `CodexSession.interrupt()` sends the thread's own `turn/interrupt`, then the runtime finds the loaded threads below it by the parent each names, recursively, and interrupts every in-progress turn among them. The lookup is the one closing a seat already used to give back its sub-agents' threads, now shared. Each read and stop is bounded to two seconds and a failure is ignored, as in that sweep; only the root's own answer can fail a Stop. Nothing is unsubscribed: the conversation stays open.
- **An open descendant is still part of the tree.** A sub-agent thread also open here as a conversation of its own is stopped through its own handle, and the threads below it are walked through it. Closing a seat is unchanged: it stops only its own turn and leaves a thread held here alone.
- **A late report does not restart the root, by the source.** An interrupted child reports nothing to its parent (`format_inter_agent_completion_message` returns no message for `Interrupted`, core/src/session_prefix.rs). A child that completes in the moment before its stop lands sends mail with `trigger_turn` false (core/src/agent/control/completion.rs); a Stop marks the root `Interrupted` (`take_active_turn`), and `should_wake_on_agent_messages` refuses a wake while it is, so even the `wake_on_agent_messages` feature (off by default, under development) does not start a turn on it. The adapter itself starts a turn only from `send`. The scripted Codex shows no second root turn after a Stop; whether a real Codex ever starts one there is not recorded yet.
- **Rejected:** stopping the children before the root (the root's turn could spawn another meanwhile, and its own stop is the one the person asked for); unsubscribing the descendants (Stop is not close, and a stopped sub-agent's thread is still read and resumed); a Stop with no root turn running sweeping the tree anyway (Stop is offered only while a turn runs, and an interrupt with no turn is refused as before).
## DeepSeek Harness 0.2.2 over ACP, measured — 2026-11-11

0.2.2-rc.2 (npm `next`) and 0.2.2-rc.1 (npm `latest`) were run the way the
2026-10-14 key measurement ran them: `dsh --profile acp` with its own
`DSH_HOME` and `HOME` per run, `DEEPSEEK_BASE_URL` at a fake Messages endpoint
on loopback that records every request and answers from a script, telemetry
off, and no real key anywhere. A small ACP client spoke the stdio protocol; the
subagent and stop cases were then repeated through `AcpRuntime` itself. Only
loopback sockets were seen open on the agent during a run.

| Measured | rc.2 | rc.1 |
|---|---|---|
| `session/new` with a stdio `mcpServers` entry | mounted; `mcp__desk__desk_echo` offered to the root agent, called, result returned | same |
| Session tool server offered to a subagent | no: a child is offered 24 tools, the root's 28 less the desk tool and the three MCP-resource tools | same |
| Text-only prompt | one `agent_message_chunk`, one `usage_update`, `end_turn` 159 ms after the prompt | same |
| Desk tool prompt | `usage_update`, `tool_call` (title = tool name, `rawInput` = arguments), `tool_call_update` completed, `agent_message_chunk`, `end_turn` | same |
| `subagent` prompt, child answers after 2 s | `tool_call subagent` → completed ("started subagent probe"), first message ("waiting"), 2.1 s of silence, a second message with a **new `messageId`**, then `end_turn`: the prompt lasts as long as the child | same; result names the child by id, not name |
| `session/cancel` while a child runs | prompt settles `cancelled` within 10 ms; the child keeps running (its `sleep 90` alive 10 s later); when it finishes the root answers again, unprompted, 5 s after the cancel; `session/close` ends the child, and nothing outlives the process | same |
| `session/cancel` during the root's own `bash` | `tool_call_update` failed ("tool call aborted"), `cancelled`, the command's process gone | — |
| Key: store and launch environment | store | store |
| Key: launch environment and home `.env` | environment | environment |
| Key: store and home `.env`; each alone; none | store; that one; missing-credential error | same |

Tools the `acp` profile offers the root on rc.2: `bash`, `create_goal`, `edit`,
`get_goal`, `glob`, `grep`, `job_kill`, `job_list`, `job_output`,
`list_agents`, `list_mcp_resource_templates`, `list_mcp_resources`,
`read`, `read_image`, `read_mcp_resource`, `send_message`, `skill`,
`subagent`, `subagent_fork`, `todo_write`, `update_goal`, `wait_agent`,
`web_fetch`, `web_search`, `workflow`, `working_directory`, `write`, plus each
session tool server's tools. No document, shared-session, computer-use,
worktree or Team-task tool. rc.1 offers `interrupt_agent` where rc.2 offers
`wait_agent`.

What changed here: ACP chunks carry `messageId`, and the adapter now starts a
new item when it changes, so the two answers of a delegating prompt read as two
messages, not one spliced "…waiting.Here is…". An agent that names no message
is read as before. Nothing else moved: `DSH_STORE_FIRST_FROM` holds on both
builds, `session/prompt` has no deadline in the adapter, and the host's idle
stop does not count a running turn as idle, so a prompt that lasts as long as
its subagents is not cut short.

**Not changed, and why.** A stop does not stop DeepSeek's subagents — ACP's
cancel reaches the root only, as DSH's own reference says — and the root's
unprompted answer when one finishes arrives with no turn open, which the
adapter drops as it drops any update outside a turn. The child works on until
the next prompt takes in its result, the conversation closes, or the idle stop
ends the agent. Closing the session on stop would end it, but turns a stop into
a reopen; showing unprompted turns is a host decision for every agent. Both are
left for that decision.

**Not measured.** A real DeepSeek endpoint; the `workflow` tool; a subagent that
asks for permission; resume after a close that ended a running child.

**The rule:** an agent's message is the unit it names, not the run of chunks
that happens to arrive together.
## The away window is the desk's record, and the recap says the day — 2026-11-11

A sitting left the desk untouched for half an hour and found no away digest on either surface. Nothing had moved in that half hour, so by the rule none was owed, but the Lead, asked what happened while the person was away, put two chats from before they left inside the window. The window's "What happened?" did nothing visible on the first click, and the second showed a card that shrank to "$0.00 spent".

- **An open window is not someone looking.** The window marked itself seen every minute and on every reply, so the desktop could never be away while it stayed open. It now says it looked only while the person touched it in the last two minutes or just brought it forward, and a refresh in between reads without marking. The input clock and the refresh belong to the app, not the Lead page, which is unmounted while another page shows: an hour in chats is an hour looked at, and opening the Lead is a look. Rejected: no refresh at all while idle (an ask still has to expire on screen and a digest still has to arrive) and the operating system's idle time (the renderer cannot read it, and the window can be in front while the person is elsewhere).
- **The Lead is told the window, not left to guess it.** An active read after 30 minutes with no device seen records the absence desk-wide, and for an hour after, the person's turns carry a host note with its start and end in desk time, what moved on the ledger in it (the same reading the digest uses) and what it spent, or that nothing did and so no digest was shown. The note says anything earlier happened before they left. Rejected: deriving the window from the person's last message (they can read without writing) and adding it to every turn (it is news only after a return).
- **A recap is the last day, every time.** It started from where the last recap ended, so a second click, or one that came while the first was still reading the ledger, covered only the seconds between them, and that empty card replaced the first. Its spend was counted from the moment of the click, so a first recap always said $0.00. It now always covers the last 24 hours, its spend comes from the spend the presence store keeps as it moves, and the button says it is reading until the answer comes. Rejected: keeping the start where the last recap ended and only refusing a click while one is reading (a click just after the first answer still covered only the seconds since) and taking the spend from the budget's own history (a goal's budget restarts with each goal).

## The Lead says a reminder once, asks before trying again, and knows where the person is — 2026-11-11

A sitting saw the Lead repeat one reminder on every turn while both surfaces still said "not said yet", start a chat after the person picked an answer that said it would change nothing, say it did not know who stopped a chat the person had just stopped from the rail, tell a person on the phone to press Apply "on the desk" (read as the desktop) for a card the phone shows, and show raw tool-call tags at the top of a reply.

- **A reply says the reminders its turn called owed (#2144).** Every request carries the person's fired reminders that were not yet said, and the work block tells the Lead to say each one once in that reply. When the reply is written the host marks every reminder that had fired before that turn began as said, so no later turn is told it is owed. A reminder that fired while the turn ran waits for the next reply, and a notice the host writes before the Lead answers marks nothing: only the Lead model's own reply does. Rejected: matching the reminder's words in the reply (a paraphrase or another language would never match, and the reminder would repeat forever).
- **The person clears a fired reminder (#2144).** `lead/reminder/clear` takes a fired or cancelled reminder off the board both surfaces read and out of the Lead's work block, for good; a set one answers that it must be cancelled instead, so its time is never dropped silently. It is the person's: on the window's Work card and at the phone's `run` tier, never on the Lead's door. Rejected: letting a leftover age out after a day (the sitting's leftover was still owed fifteen hours on, and was repeated every turn until then).
- **Old records are shown as what they are, never rewritten (#2144).** A journal is append-only, so a reply stored before the envelope fix keeps its raw `lead-output` JSON and an old reminder wake is stored as the person's message. The projection both surfaces read shows the first as the reply's own words and the second as a desk line in the reminder's words, and strips tool-call markup from old replies; a message that only names the envelope inside code is left as written. Rejected: a journal migration (it would rewrite the person's history to fix how it is drawn).
- **An answer starts only what it says (#2145).** An ask's option that starts or restarts a chat carries `starts: true`, and the host refuses a chat start while the person's newest message answered an ask with an option that does not, telling the Lead to do what the option says without a new chat. The host stamps each ask it reads under this rule (`startsMarked`), and only a stamped ask refuses, so a question asked before the upgrade, whose options never said `starts`, still lets its answer start a chat. Rejected: reading the option's words for "do not change anything" (labels are free text in any language).
- **The Lead reads the board after a stop has landed (#2145).** The Lead's wake for a chat change read the work list before the debounced ledger refresh had recorded the stop, so its card said the chat was still working and it said it did not know who stopped it. The cards on each request refresh the ledger first, and a read of the board refreshes it when the desk changed since the last refresh (a stop, a chat or Team event) or that refresh is a second old, since a refresh lists every Team and a phone polls the board. Rejected: shortening the debounce (a race with a shorter window is still a race), and refreshing on every read (each phone poll would list every Team).
- **The Lead knows where the person wrote from (#2146).** Each person message carries a desk note naming the phone or the desktop window, from the device the send named, and the standing instructions say that Apply, Keep, Edit, No and an ask's options work on both. (It was first a `<person-device>` block on the newest turn; #2166 moved it onto every message.) The standing instructions add that the desk is the program, not a place, so "on the desk" is never where to press something. The desktop's proposal cards name the Lead by the name the person chose, as the phone's do. Rejected: telling the Lead only in the standing instructions (it already said Apply works on every surface, and still sent a phone user to the desktop).
- **Tool-call markup never reaches a reply (#2148).** Tags a model writes as text when it means to call a tool are stripped where a reply's text is built, the one place both surfaces read, keeping code spans as they are.

## A Lead question is open by the desk's record, and the person's press leaves a receipt — 2026-11-12

An evaluation sitting asked the Lead a question, then wrote about something else. The Inbox dropped the question, the phone greyed it, an older card read "Replaced by a newer question", and the Lead told the person to tap an option that no surface offered any more. A floating Work rail lay over the thread and stayed there while the person pressed what it covered, and a Work row opened its Team only from a small icon at its end. Keeping a memory or applying a settings proposal left no trace in the thread, so the Lead's next words were the only record of it.

- **The host's ask states are the one display rule (#2173).** A question is open until it is answered, expires or a newer question of the Lead's replaces it; the person writing about something else leaves it open. The Inbox lists the question the states hold `open` (`openAsk`), the Lead's `<work-ledger>` block names it in one line, and the desktop keeps its options live while it is open and the newest question, as the phone does from the same `asks`. A tap answers it; typed words answer it only as the person's next message, since words written after an aside are plain words. So the Lead's line says no option has been chosen on screen, and tells it to act on an answer the person gave in their own words rather than ask again; a newer question replaces it. Rejected: keeping three rules and documenting their differences (each surface was right by its own rule, and the person saw three answers to one question).
- **The chat-start hold keeps its own rule, under a name for that job.** `askHoldingChatStart` frees the Lead to start work once the person moves on, which is right for a hold and wrong for whether to show the question. Rejected: holding chat starts for as long as a question is open (a question about one task would stop every other task the person asked for).
- **A floating rail goes the way the floating sidebar goes (#2175).** Escape and a press in the shell outside it put it away; a press in it or on its toggle does not, and a rail standing beside the page takes neither. A Work row opens what it stands for from its body: the Team when it has one, else its latest chat; its menu answers for itself. Rejected: a scrim under the rail (the thread under a narrow rail stays readable, and a dim would say it cannot be used).
- **The person's press leaves a receipt (#2176).** Keep writes `Kept · <kind>: <text>` and Apply writes `Applied · <section>, version N` (or the mode's new value) into the thread as a `system` line, which the desktop draws as a host notice and the phone draws as its grey line. No writes nothing, since the card going is the answer. Rejected: the `notice` role (the phone draws only its checkpoint notices, so a receipt there would reach the desktop alone).
- **A receipt is a journal record of its own.** The host writes it as a `receipt` record in the Lead's journal, and the thread is rebuilt from that record on replay. An older build that meets one does not know the type and fails to replay the journal, the same exposure the `memory-epoch` record already has: going back a version after a Keep or an Apply needs the newer build again. Rejected: a `notice` record with receipt text (the phone would not draw it, for the reason above).

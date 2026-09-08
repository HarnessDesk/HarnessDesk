---
name: hd-multi-agent-review
description: Review pull requests with three strong models at once through HarnessDesk — Codex 5.3, Claude Opus 4.6 and Gemini 3.8 Flash each read the diff independently in one room and leave a review signed with their own name, model and effort. Use when asked for a multi-agent review, a second (or third) opinion on a PR, "review this with all three", a review of a pull request link, or "review all the PRs". Takes a PR link or number, several of them, or "all".
---

# HarnessDesk multi-agent review

Three reviewers read the same change at the same time, in one room, in the
repository itself — and each leaves a review signed with its own name, model
and effort, so a month later anyone can tell which of them said what.

This is the strongest review this project has. On the round that produced it,
all three independently found the same first defect: a fix had been
half-applied, so a receipt counted files by path and the header beside it
counted by call, and the two contradicted each other in both directions.
Nothing in 1400 tests caught it.

What each seat is good for, consistent across every round so far: **Codex** is
the strict one — fewest findings, each precise. **Claude/Opus** writes the most
complete risk list and is the one that clears areas explicitly ("I found
nothing real here, and here is why"). **Gemini Flash** — the cheap seat — finds
real bugs in code paths and is the most willing to be wrong: it has produced
the only false positives, and also findings the other two missed. On 2026-09-07
it was the only seat to request changes on a PR the other two approved, and
both of its defects were real.

**The default cast is three models under one harness (Cursor).** That is a
deliberate trade and worth knowing: the round's original strength was three
*vendors*, three separate CLIs reading a diff three ways, and a single-harness
cast gives that up — one vendor's tooling, one vendor's approval behaviour, one
vendor's rate limit. Reach for `--cast` when you want the vendor spread back:

```bash
node review.mjs 56 --cast "claude-code=opus[1m]/max,codex=gpt-5.6-sol/high,cursor=gemini-3.8-flash/high"
```

```bash
node script/review/review.mjs --dry-run all
```

## The cast

| runtime | model | effort |
|---|---|---|
| Cursor | `gpt-5.3-codex` (Codex 5.3) | `xhigh` |
| Cursor | `claude-4.6-opus` (Claude Opus 4.6) | `max` |
| Cursor | `gemini-3.8-flash` (Gemini 3.8 Flash) | `high` — Cursor's free model |

Three seats on one runtime is a shape the driver already supports: each has to
post a comment of its own to be counted, and because no two share both a model
and an effort, every signature is distinct and the record can say which of them
wrote what. They are named `cursor-gpt-5-3-codex-xhigh` and so on.

Measured 2026-09-07 against cursor-agent 2026.09.02-c22c1a3 — the ids belong to
whichever binary is installed, so check with `--models` before trusting this
table. There is no Gemini 4.x on this desk from any agent, and `opus[1m]` in
the vendor-spread cast above is a model id rather than bold text: Opus 5 with
the million-token window, the only Opus Claude Code's list offers.

Change it with `--cast`, add to it with `--add`; both take
`runtime[=model][/effort]`, comma separated:

```bash
node review.mjs 56 --cast "claude-code=opus[1m]/max,codex=gpt-5.6-sol/high"
node review.mjs 56 --cast "cursor=claude-opus-5/max,codex=gpt-5.6-sol/xhigh"
```

`--add` extends the default three rather than replacing them. Since all three
default seats are already Cursor, an `--add` naming Cursor again is a fourth
seat rather than a clash — give it a model or effort the other three do not
have, or its signature is one of theirs. Two seats on one agent works: each has
to post a review of its own to be counted, and each gets its own record. Give them different models or efforts if you want the
closing table to say which is which — seats identical in both sign the same
line, and nothing afterwards can tell them apart.

A runtime with no model named runs on the agent's own default. The desk has
the last word: an unknown agent, model or effort level is refused up front
with the list of what this desk actually offers, and a pick a runtime silently
declines is caught by reading the started conversation back — a review that
believes it ran at maximum effort because it asked for maximum effort is a
review with an unchecked claim at the top of it.

**A missing model is nearly always a stale agent binary, not a typo.** The
models follow the agent: upgrade the CLI, or name one from the list the
refusal prints. `--models` opens the desk and prints every agent's model ids
and effort levels — the only trustworthy source, because the list belongs to
whichever binary is installed today.

## What it does

`node review.mjs [target…] [options]`, from anywhere inside the repository to
review.

| target | |
|---|---|
| *(nothing)* | the pull request open on this branch; failing that, the branch against the default branch |
| `56` `#56` `https://…/pull/56` | that pull request |
| `56 53` | those pull requests, in one brief |
| `all` | every open pull request on this folder's remote, drafts included |

It opens a real HarnessDesk on the repository, starts one conversation per
vendor with the picked model, puts them in a room, and hands each of them the
same brief with its own signature filled in — one hand-out, not one post, so
no reviewer is ever holding another's signature. Then it stays at the desk:
answers the approvals the agents ask for, prints the channel as it fills, and
at the end asks **GitHub** which reviews landed rather than believing the
agents' account of it.

Each reviewer posts one comment per pull request whose first line is exactly:

```
**Review by Claude Code 2.1.258 · Opus (1M context) · Max effort · via HarnessDesk**
```

The name, the version, the model and the effort are read out of the desk and
handed over as a finished line. Nothing about the signature is left to the
model, because a model asked to sign with its version invents one.

Useful options: `--no-post` (the same pull requests, read the same way, but
each review written to `<record>/<seat>.md` instead of commented on GitHub),
`--timeout <min>`, `--room <name>`, `--note <text>` for an extra paragraph in
the brief, `--keep-open` to leave the desk up, `--home` for a desk of its own,
`--out` for where the record goes.

Two of them are worth reaching for before a long run:

- `--rehearse` asks each reviewer for one line instead of a review — it runs
  `gh`, so the approval loop, the hand-out, the signatures and the room are all
  proven, and nothing is published. A minute, and one cheap turn each.
- `--models` opens the desk and prints what every agent really offers. Model
  ids move with the binary, and a cast written from memory is a run that fails
  ninety seconds in.

## How to run it

1. **`--dry-run` first.** It resolves the targets, prints the plan and the
   exact brief, and launches nothing. It costs nothing.
2. **Show the user the plan and get a yes before the real run** — it publishes
   comments to GitHub under their account, and it spends real agent time
   (Cursor's request-billed plan counts one request per member per post).
   `all` on a repository with eight open pull requests is a long afternoon;
   say so and let them narrow it.
3. Run it. It prints progress; it does not need watching, but a question can
   only be answered by a person (see below).
4. **Read the evidence, and report what actually landed** — including the
   reviewer that did not answer, if one did not. The exit code is non-zero
   when a signature is missing or a reviewer never reported back.

The record is written to `~/.harnessdesk/reviews/<stamp>/`: `plan.json` (the
cast, with the version each one signed as, and the brief they were given),
`<seat>.channel.md` (what each said in the room — one file per *seat*, named
`cursor` for a lone seat and `cursor-gpt-5-3-codex-xhigh` where a runtime is
seated more than once), `room.json`, `evidence.json` (which comment on which
pull request is which reviewer's, and the moment they were counted from),
`app.log` — and, where the reviews are written rather than posted (`--no-post`,
or a branch), `<seat>.md`, the review itself.

The room stays in the desk afterwards. Open HarnessDesk and read the reviews
where they were written.

## Traps

These are the ones that have cost time. None of them announces itself.

- **Claude Code asks before every shell command, and a review runs `gh` a
  dozen times.** The driver answers them, and the decision shape is the whole
  trick: `{ type: 'option', optionId }` is the only thing the host accepts.
  `{ type: 'approve' }` is silently rejected and the same request comes back
  forever. It prefers the *approve always* option where a runtime offers one,
  or a single command re-asks a dozen times.
- **A reviewer can run out mid-review.** An agent's usage window or spend cap
  ends its turn where it stands: on 2026-09-06 Codex hit its workspace spend
  cap on the first turn of an eleven-pull-request review and posted nothing at
  all, while the other two signed every one. The room says so now — a row
  chipped *usage limit*, in the runtime's own words — and this skill stops
  waiting on that member rather than burning its deadline in silence. Read the
  closing table: `2/3 reviewers reported back · 1 stopped` is not a failure of
  the run, it is the answer.
- **A question is not an approval.** A `userInput` or `elicitation` request is
  a model asking a person something; the driver prints it and leaves it. If
  the run ends with questions outstanding, they are in the log and the room —
  answer them in the app, or in the next brief.
- **Two hosts on one desk is two writers on one set of rooms.** The driver
  refuses to start when another HarnessDesk is already running on the same
  `HARNESSDESK_HOME`, and tells you how to give the run a desk of its own.
  This is not paranoia: the loser's room disappears.
- **A desk of its own has no agents.** The roster is `agents.json` under
  `HARNESSDESK_HOME`; a fresh `--home` has none, so only the built-in agent is
  registered and the cast is refused. `--models` does not warn you, because it
  reads whatever desk it opens. Copy the roster once —
  `cp ~/.harnessdesk/agents.json <home>/agents.json` — which the refusal now
  says. The agents stay signed in through their own homes; only the list of
  them lives on the desk.
- **A review is a comment, not a string found somewhere.** The evidence check
  matches reviewers to *comments* — one apiece, and no comment answering for
  two — rather than asking whether each signature appears anywhere in them. It
  asked the second question until 2026-09-07, when three Cursor seats on PR
  #77 were all satisfied by the first comment to land: the wait ended four
  minutes after the hand-out with two reviews still being written, the table
  said `3/3 signed` with `missing: none`, and the run exited 0. **N seats now
  need N distinct comments.** The closing table names each seat by its model
  and effort, and a reviewer that reformatted the tail of its own line is
  still found by the rest of it, marked as such.
- **A signature *in* a comment is not a comment being *signed*.** Matching
  reviewers to comments fixed the count and left this behind: where one
  reviewer posts twice and quotes another's line, the reviewer being quoted —
  which posted nothing — was handed the quoting comment, and the run went
  green a reviewer short. Found by Cursor/Codex 5.3 reviewing the fix for the
  trap above, with a reproduction. **A comment belongs to whoever signed its
  first line**, which is what the brief asks each reviewer for and what a
  quotation is never on. A comment whose opening names nobody — a model that
  wrote a sentence before signing — is still read whole, but only for the
  **whole signature**: a round's own write-up names every seat in prose, and
  against the looser mark that write-up counted as all of them posting. Such a
  match is recorded `how: "body"` so the record never overstates what answered.
- **A message is not a report.** The same mistake one layer down, and it cost
  a real round on 2026-09-07: the wait released a reviewer the moment that
  seat said *anything*. Four minutes into PR #90 the Cursor/Codex 5.3 seat
  said "I'm now checking downstream callers and reason-string sources …" — a
  progress note — and the driver printed `3 answered — nobody left to wait
  for`, polled GitHub through its three-minute grace, reported `2/3 signed`
  and exited 1 with that reviewer still reading and nothing of its posted.
  The brief is the worst possible source of a done signal here, because it
  tells every reviewer to write its signature: the signature is the one
  string that says nothing at all about being finished. **A report is the
  closing ask, back** — a verdict, or a link to a *comment* it left (never
  merely to the pull request, which the brief hands over), one line of that
  per pull request; for a branch review, a verdict or the path it wrote; for
  `--rehearse`, the word `ready`. A seat whose comment GitHub is already
  carrying is finished too, whatever it said in the room. Being strict is
  cheap and being loose is not: a seat this misses is released by the next
  GitHub poll a minute later, and a seat it lets through early is abandoned
  mid-review. Watch for it live — the channel prints `✓` for a message read
  as the report and `→` for one that was not — and in the closing table,
  which now names a seat that "spoke in the room but never reported".
- **`--no-post` is a different brief, not a suppressed one.** The same
  question — what is this run's evidence? — was answered three ways until
  2026-09-07, and none of them by the flag: the brief handed out was the
  *posting* one, so all three reviewers were told to comment on GitHub under
  your account, while the banner above them printed `publishing nothing`; and
  the closing table then graded them against `<record>/<seat>.md`, a path only
  a branch review had ever asked anybody for. `node review.mjs 93 --no-post`
  published its comments and exited 1 reporting that nobody had written
  anything. There is one answer now — comments, files, or a rehearsal's line
  in the room — and the brief, the wait and the closing table all ask it.
  Under `--no-post` the diff still comes from `gh pr diff`; the review goes to
  `<record>/<seat>.md`; and GitHub is out of bounds **by instruction**, like
  the read-only rule below, not by sandbox.
- **Seats identical in model *and* effort sign the same line.** They are still
  counted apart — each has to post — but which of them wrote which comment is
  a guess, and the record cannot say. The run prints that before it spends
  anything; give them different models or efforts if it matters.
- **"Has a comment with this signature" is a check that cannot fail on the
  second round** — the first round's comments answer it. Only comments created
  since the hand-out are counted, which is why the run records the moment.
- **The reviews are read-only by instruction, not by sandbox.** The brief
  forbids editing, building, committing and merging, and the agents have
  honoured it — but they are real agents in the real checkout. Do not run a
  review in a worktree where something else is mid-edit.
- **Never build the app while a video take is recording.** `pnpm build`
  rewrites `packages/ui/dist`, which the running shell serves off disk. The
  driver builds only when the app is not built; `--build` forces it.

## Elsewhere than this repository

The skill ships in this repo, so it is found when the checkout is open. To use
it on another repository (`dsh-acp`, say), link it once:

```bash
ln -s "$(pwd)/script/review" ~/.claude/skills/hd-multi-agent-review   # from a HarnessDesk checkout
```

Then run it from that repository's folder — the targets come from the folder's
own remote, and `--app` still points at a HarnessDesk checkout to run.

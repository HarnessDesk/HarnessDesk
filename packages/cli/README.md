# harnessdesk

Read and start work on a running local desk through its outside-client door.
These observation commands use the read tier:

```sh
harnessdesk desks
harnessdesk status --team demo-team --json
harnessdesk teams --project .
harnessdesk runs --team demo-team --all --json
harnessdesk watch --run demo-run --until settled --json
```

Build from the repository with `pnpm build:node`. The package's `harnessdesk`
bin is `dist/src/bin.js`; it can also be run with `node packages/cli/dist/src/bin.js`.
`--home DIR` selects the desk, followed by `HARNESSDESK_HOME` and the default
home. An absent selected desk never falls back to another desk. Project filters
resolve relative to the CLI's working directory and follow symlinks, matching
the host's canonical project identity.

Human output removes C0/C1 controls and terminal escape sequences from relayed
text. `--json` emits one object for each command: `{desks}`, `{hello, teams,
runs, overviews}`, `{teams}`, or `{runs}`. A watch emits the client's stable
version-1 events, one object per line, beginning with `hello` and ending with `end`.
Watch subscribes to `runs`, `cards`, `teams`, `seats`, `reviews`, `waiting`
and `notices`. Its events include `run.changed`, `card.changed`,
`team.changed`, `seat.changed`, `review.changed`, `waiting`,
`waiting.cleared`, `notice` and `gap`, within the `hello`/`end` boundaries.
Both seat and review changes appear in human output and pass through unchanged
in `--json`. Seat activity comes from the host; reviews read each round from
`finding/run` after the baseline and on `finding/changed`, including new and
finished runs in scope. Failed background reads emit `notice` with the
desk's message. Observation has no periodic reads. For a
run scope, the client also reads that execution when subscribing or reconnecting
so already settled, stopped, or stalled runs are visible.

`watch --raw` relays the **unstable wire notifications** as JSON lines without
changing their envelopes, between the same `hello`/`end` lifecycle boundaries.
`--trace-wire` on any command writes every sent and received envelope to stderr
as `{direction, message}` JSON lines. JSON serialization escapes relayed controls;
no relayed text is interpreted as a command. The CLI has no credential of its own.

`runs` defaults to active runs; `--all` includes finished ones. Runs accept
either `--team` or `--project`. Watch accepts one of `--team`, `--run`, or
`--project`; `--until settled` requires `--run` and ends on settled, stopped,
or stalled. Scope flags are mutually exclusive.

Exit codes are 0 for completion, 1 for an error, 2 for usage, 3 for no desk,
4 for a refusal, 5 for a person wait, 6 for incompatible protocol or missing
advertised methods, 7 for a stopped or stalled run, and 8 for a run wait timeout.
SIGINT exits 130 and SIGTERM exits 143, after the watch's final `end` line.
If interrupted before hello succeeds, only that interrupted `end` appears;
the CLI does not invent a handshake.
Fatal reconnect refusals preserve their code and end with `reason: "error"`;
an actual host shutdown ends with `reason: "desk-closed"`.

`status [--team ID] [--json]` subscribes once to runs, cards, Teams, seats and
waiting, then waits for the full baseline with `synced()`. It reads
`insight/goal` once for each displayed Team. By default it shows Teams with
running or stalled runs; `--team` includes that Team even without an active
run, and its run strip is the Team's newest run whether or not it has ended.
No polling is involved.

Human status keeps the desk home, version and runtime health header. Each Team
uses the shared overview: its run, state, round, role, review rounds used of
total and cost; needs-you items; and seats with name, role, card, state, doing
and a relative since time. Missing times and costs are shown as unknown.

Status JSON retains `hello`, `teams` (`GoalView[]`) and `runs` (active run
summaries), and adds `overviews: { team, overview }[]`. Each `overview` is the
unchanged output of `teamOverviewOf` from `@harnessdesk/client/views`, with
`run`, `needsYou` and `seats`. The Teams and runs follow the subscription scope;
only displayed Teams receive an overview and usage read.

## Starting a Flow

```sh
harnessdesk open . --json
harnessdesk flows --project . --json
harnessdesk flow preview write-review-fix --project . \
  --title "Finish the change" --brief-file brief.md --seat writer=fake/high
harnessdesk flow start ./flow.yaml --project . --brief-file - \
  --seat writer=fake/high,fake-b/high --unattended --yes --json
harnessdesk run show demo-run --json
harnessdesk run wait demo-run --timeout 300 --json
```

`open <path>` uses the run tier to open the canonical project path. It prints
that project; JSON is the unchanged `WorkspaceEntry` (`path`, `name`,
`lastOpenedAt`, and optional repository facts). `flows [--project P]` reads
the catalogue and prints each id, origin layer and problem; JSON is
`{flows: FlowEntry[]}`. The project defaults to the repository containing the
working directory. Outside a repository, give `--project`.

`flow preview <flow>` and `flow start <flow>` share these flags:

| Flag | Meaning |
| --- | --- |
| `--project P` | Canonical project; defaults to the repository containing cwd |
| `--title TEXT` | Team sentence; also fills `title` if the Flow declares it |
| `--brief-file PATH` or `--brief-file -` | Read `brief` locally from a file or stdin |
| `--input name=value` or `--input name=@path` | Repeat for declared inputs; keep long text in files |
| `--seat role=runtime[=model][/effort][+thinking]` | Repeat for different roles; comma-separated seats for a role with several cards |
| `--unattended` | Apply the desk's unattended ceiling policy and question deadline |

A Flow is a catalogue id or a `.yaml`/`.yml` file path. Paths containing `/`
are also files. The CLI reads file paths itself and sends text; `flow/source`
only resolves catalogue ids. Open the project before previewing. Undeclared
inputs, including a `--brief-file` on a Flow without `brief`, exit 2 and list
the declared inputs. Give each input and each overridden role once.

Preview opens no session and spends nothing. Human output shows attendance,
seats with overrides beside the file's seats, held or asked ceilings, check
commands and every problem. JSON is the unchanged `FlowPreview`, including
its single-use token and optional attendance/overrides. A preview with errors
or no start token exits 4. Warnings remain visible and allow a start.

Start previews first, then confirms on a terminal. A non-terminal needs
`--yes`; without it, exit 2. If a stdin brief has consumed terminal input to
EOF, start also needs `--yes`, since confirmation can no longer read an answer. `--yes` acknowledges the preview and authorizes
spending. The unattended ceiling policy is the same as a trigger’s: by default,
asked ceilings are refused; the existing Permissions setting still applies. Start JSON writes exactly `{run: string, team: string}` to stdout;
the preview and any confirmation prompt go to stderr. Human output prints the
preview and the new run and Team ids. The token freezes the source, inputs,
seat overrides and attendance; changed or reused tokens are refused.

The local door grants `read` and `run` by default. File permissions authorize
this user's local processes; tiers restrict verbs, not processes owned by the
same user. `answer` is off by default and can be granted as described below. The supported Node client refuses run
calls when it carries `HARNESSDESK_GOAL_ID` or `HARNESSDESK_LANE_ID`: a desk
Seat uses its board tools. Those removable markers prevent accidental spending
and are not an authentication boundary.

## Reading and waiting for a Run

`run show <run>` reads one execution. Human output shows state, attendance,
rounds with roles and card ids, stop reason and overrides; JSON is the unchanged
`FlowExecution`.

`run wait <run> [--timeout S]` makes one subscription scoped to that run,
waits for its counted baseline, then uses events without polling. It drains
both event queues. Already ended runs return immediately. The timeout counts
from invocation, including discovery and handshake; finite non-negative
seconds up to 2147483.647 are accepted. Omit it to wait without a deadline.

Wait writes one result: human run id, state and reason, or JSON
`{run: string, state: string | null, reason: string | null}`. A timeout or a
signal before a baseline has state `null`. Outcomes are 0 for settled, 5 for
an open person card or question from a Seat recorded in that Run, 7 for stopped/stalled, and 8 when the timeout
passes first. SIGINT and SIGTERM return 130 and 143. An unattended question
stall keeps the question available for a late answer through the window;
a later `run wait` sees that stall and returns 7.

## Stopping, answering and waiting

```sh
harnessdesk run stop demo-run --reason "Work is no longer needed" --yes --json
harnessdesk card show demo-team 1 --json
harnessdesk card handoff demo-team 1
harnessdesk card answer demo-team 2 approved --context-file findings.md --json
harnessdesk card answer demo-team 2 approved --context-file -
harnessdesk card abandon demo-team 1 --reason "Replan this step" --yes --json
harnessdesk waiting --json
harnessdesk waiting --watch --json
```

`run stop <run> --reason TEXT` uses the run tier and requires a nonempty
reason supplied by the flag. It confirms on a terminal or accepts `--yes`;
without terminal input or `--yes`, it exits 2. It prints the stopped run;
JSON is the unchanged `FlowExecution`. Stopping ends the run and prevents its
next round from opening.

`card show <team> <card>` uses the read tier and prints role, state, outcome,
note and handoff. JSON is the unchanged board `Intent`. Card ids are numeric.
`card handoff <team> <card>` prints only the sanitized handoff for a pipe,
preserving line breaks. Its JSON shape is `{handoff: string}`. A missing or
empty handoff exits 1 with one line on stderr.

`card answer <team> <card> <outcome> [--context-file PATH|-]` uses the answer
tier. Context is read locally from the named file or stdin and sent as text;
there is no positional context argument and no confirmation. The card must
belong to a person role and the outcome must be one that role declares. The
desk must grant answer through the Permissions setting “Let command-line clients answer for me”
or `HARNESSDESK_CLIENTS_MAY_ANSWER=1` in the host environment. It is off by
default. A denied tier, an agent card, an undeclared outcome or a repeated
answer exits 4 with the desk's refusal code on stderr (`tierNotGranted`,
`refused` or `alreadyAnswered`). The channel attributes an accepted answer
to the command line. JSON is `{team: string, card: number, outcome: string}`.

`card abandon <team> <card> --reason TEXT [--yes]` uses the run tier. Before
confirmation, including with `--yes`, stderr warns that the rule after the
role still fires and points to `run stop` to end the work. It names declared
next roles, qualifying guarded rules by their conditions. The desk reports
which next role actually opened. It requires terminal confirmation or
`--yes` (otherwise exit 2). JSON is `{role: string | null, nextRole: string |
null}`; human output prints the same roles. A declined confirmation exits 4.

`waiting` uses the read tier, subscribes to waiting and waits for its full
baseline before printing person cards, questions and approvals with stable
ids. JSON is exactly one `{waiting: ClientWaitingItem[]}` object. `--watch`
streams stable version-1 `waiting` and `waiting.cleared` events between
`hello` and `end` lifecycle events, with reconnect gaps and notices when
needed; `--json` writes one event per line. A cleared item retains the id
previously listed. These commands also accept the global `--home`, `--json`
and `--trace-wire` flags and share the exit codes above (0 for success, 1 for
an error, 2 for usage, 3 for no desk, 4 for refusal, 6 for incompatibility,
130/143 for SIGINT/SIGTERM).

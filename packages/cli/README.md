# harnessdesk

Read a running local desk through its outside-client door. These five commands
use only the read tier:

```sh
harnessdesk desks
harnessdesk status --json
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
runs}`, `{teams}`, or `{runs}`. A watch emits the client's stable version-1
events, one object per line, beginning with `hello` and ending with `end`.
Observation uses subscription notifications, with no periodic reads. For a
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
4 for a refusal, and 6 for incompatible protocol or missing advertised methods.
SIGINT exits 130 and SIGTERM exits 143, after the watch's final `end` line.
If interrupted before hello succeeds, only that interrupted `end` appears;
the CLI does not invent a handshake.
Fatal reconnect refusals preserve their code and end with `reason: "error"`;
an actual host shutdown ends with `reason: "desk-closed"`.

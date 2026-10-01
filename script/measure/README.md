# Library measurement harness

This is a manual measurement tool. It is never part of CI. Run it only on
macOS after the sandbox preflight succeeds:

```sh
pnpm build:node && node script/measure/library.mjs --all
```

The harness creates a fresh fixture under `/tmp/hd-library-measure-*` for each
agent. It contains synthetic user and project skills, duplicate names, malformed
and oversized skills, rule sentinels, MCP configuration, and a fixture MCP peer.
The fixture is removed after its result is written.

Every child process uses `sandbox-exec`, a new fixture home, a restricted
environment, and a fixture repository as its working directory. The profile
denies the real home agent/configuration and credential paths, system keychain
paths, and the security services. Before any agent process can run, preflight
checks that reads and writes to blocked paths fail and that a temporary
`harnessdesk-measure-canary-<pid>` keychain item is refused within the sandbox.
The canary is deleted in a `finally` block. If isolation cannot be proved, the
build receives a `could-not-ask` result and its probe is not started.

Result files contain exact build metadata, the interface and question, parsed
facts, and only allowlisted fixture sentinels in `rawAnswer`. Unavailable,
interactive-only, signed-out, or unsafe-to-isolate builds are recorded as
`could-not-ask` with a sanitized reason. No agent probes are registered yet;
the later measurement tasks add those interfaces and parsers.

Results are written under `docs/verification/library-measurements/` as
`<agent>-<version>.json`.

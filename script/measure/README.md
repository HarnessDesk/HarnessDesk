# Library measurement harness

This is a manual measurement tool. It is never part of CI. Do not run
`node script/measure/library.mjs --all` until Task 9 adds the probe registry at
`script/measure/probes/index.mjs` and all eight questions and parsers are ready.
When that task is complete, run it only on macOS after the sandbox preflight
succeeds.

The harness creates a fresh fixture under `/tmp/hd-measure-*` for each
agent. It contains synthetic user and project skills, duplicate names, malformed
and oversized skills, rule sentinels, MCP configuration, and a fixture MCP peer.
The fixture is removed after its result is written.

Every child process uses the exact profile that passed preflight, a new fixture
home, a restricted environment, and a fixture repository as its working
directory. The profile derives agent-home denials from
`packages/server/src/installs/known-agents.ts`, adds credential roots, and
denies the system keychains and security services. Preflight verifies file
denials against that same profile, then creates a throwaway keychain inside the
fixture root and confirms its canary is readable outside and refused inside
because of the sandbox denial. Spawn errors, signals, timeouts, an item-not-found
response without a matching `securityd` mach-lookup denial, or failure to delete
the throwaway keychain make preflight fail. The login keychain is never used. If
isolation cannot be proved, no probe process starts.

Result files use a strict schema. Persisted strings are limited to safe
measurement vocabulary, fixture-derived sentinels, and validated build
metadata; `rawAnswer` is normalized only against sentinels found in the fixture.
Probe-supplied allowlists are ignored. Unavailable,
interactive-only, signed-out, or unsafe-to-isolate builds are recorded as
`could-not-ask` with a sanitized reason. The later measurement tasks add the
agent interfaces and parsers.

Results are written under `docs/verification/library-measurements/` as
`<agent>-<version>.json`.

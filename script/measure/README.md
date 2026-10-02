# Library measurement harness

This is a manual, macOS-only measurement tool and never runs in CI. Phase 0 measures installed-build help and version output, plus sign-in-free catalogue observations: Codex `app-server` `skills/list` and signed-out ACP `initialize`/`session/new`. ACP command updates are recorded only as commands; they never count as skills. A failed ACP `session/new` records the asked observation “no session while signed out,” while skill catalogue availability stays `unknown`. No model prompts, sign-in attempts, account data, or credentials are measured.

Run the exact entry point after building the generated install metadata:

```sh
pnpm build:node && node script/measure/library.mjs --all
```

The harness makes a fresh fixture per agent under `/tmp/hd-measure-*`: isolated synthetic home and repository, user/project/duplicate/invalid/oversized skills, rule sentinels, MCP configs, and a local fixture MCP peer. Child processes receive only the sanitized environment, fixture cwd and homes, fixture `TMPDIR`, and the selected CLI arguments. The fixture and captures are removed after its result is written.

Before launching a probe, `sandbox-exec` preflight checks the exact profile. The strict profile starts with `(allow default)`, denies file reads and writes under `/Users` and `/Volumes`, then denies all writes before allowing writes only in the fixture roots, `/dev/null`, and `/dev/tty*`. Reads are allowed for fixture roots and the resolved Node and agent install directories; final denials cover each credential root and known-agent home so those cannot inherit an install-directory allowance. Strict mode also denies the real home Keychains directory and the `securityd` and `SecurityServer` lookups. Canary checks prove an unrelated read under a synthetic home, a credential read inside an allowed install directory, and an outside-fixture write fail; fixture reads and writes, an allowed install read, and spawning `/usr/bin/true` succeed. A disposable fixture keychain succeeds only in the keychain-read-only control.

Claude Code, Cursor, and Grok Build use the named `keychain-read-only` profile for version/help discovery. It allows reads under the real home’s `Library/Keychains` and leaves the two security service lookups available; keychain writes remain denied. No ACP initialization or model prompt is sent for these agents, and their measurements remain `could-not-ask`. Preflight repeats the file canaries and checks the keychain read differential. Their results identify `isolation: keychain-read-only` and `auth: owner subscription sign-in`; persisted fields use strict allowlists and redact every field.

Install discovery keeps absent candidates, unreadable versions, and unsafe-to-isolate install roots separate. It resolves symlinks before selecting a narrowly scoped install directory; a package or `versions/<version>` directory inside an agent home can be allowed, but the whole config home cannot. Node-based agents also get the resolved Node install prefix. Unsafe or inseparable roots remain `could-not-ask` with a path class in the reason; no real path is persisted.

Interface selection and scope:

- Codex: `codex app-server`; query `skills/list`, config and MCP status without sending a model prompt.
- Gemini CLI, OpenClaw, OpenCode, Cline, Hermes, CodeBuddy Code, Kimi, Pi ACP, GitHub Copilot CLI, Antigravity, DeepSeek, and Devin: the configured ACP bridge or agent command; send only `initialize` and `session/new`, never a prompt. Claude Code, Cursor, and Grok Build receive version/help discovery only; no ACP session or model prompt is sent.
- All builds: capture `--help` and the declared version arguments in the fixture, compare the parsed version with install discovery, and persist only the normalized version. Absent, unreadable, unsafe, and version-changed candidates remain distinct.

Raw answers are reduced to fixture-derived sentinel tokens. Structured facts accept only fixed enums, booleans, bounded counts, fixture tokens, and concrete relative skill-root paths. Vendor output, account identifiers, emails, tokens, secrets and absolute machine paths are never persisted or printed. A failed privacy validation becomes `could-not-ask`.

`docs/verification/library-measurements/README.md` maps each result JSON cell to its fact: `facts.rulesFiles` → rules read/load order; `facts.catalogue` plus `facts.reportsCatalogue` → fixture reach/catalogue reporting; `facts.precedence` → duplicate-name precedence; `facts.rejections` plus `facts.reportsRejections` → acceptance/reason and rejection reporting; `facts.skillRoots` → concrete tier C root paths; `facts.refresh.catalogueRefresh`, `facts.refresh.skillToggle`, and `facts.refresh.openSessionSeesChange` → refresh behavior; `facts.mcp` → config recognition and connection status; `facts.signedOutCatalogue` → available/empty/unknown while signed out. Each cell links its exact `<agent>-<version>.json` result or gives its `could-not-ask` reason.

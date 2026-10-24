# Security

## Reporting

Report vulnerabilities privately through GitHub's [private vulnerability
reporting][advisory]: **Security → Report a vulnerability** on this repository.
Do not open a public issue for anything you believe is exploitable. If the
private route fails you, open an issue that asks for a private channel and
contains no details.

[advisory]: https://github.com/HarnessDesk/HarnessDesk/security/advisories/new

Please include:
- A description of the issue and its potential impact.
- The affected component (desktop shell, host, extension host, renderer, or
  an ACP bridge).
- Clear reproduction steps or a minimal proof of concept.
- The environment tested (macOS version, agent, and packaged app vs source).

You will get an acknowledgement within a week. When a report is confirmed, we
coordinate a fix and credit the reporter in the advisory and release notes.
There is no bounty programme.

## What the design already commits to

Knowing the security model saves reporting things that are load-bearing
decisions — and sharpens reports about things that break it. The model, in
brief:

- **Credentials.** Sign-in belongs to each agent; its credential never passes
  through HarnessDesk. Keys you hand it directly (model routes, gateway
  accounts, provider API keys) go to a credential broker. In the desktop app,
  they are encrypted at rest with the OS keystore (macOS Keychain); in
  standalone development, file permissions (mode 0600) are the protection.
  The broker returns only references — never a plaintext value in a config
  file, never readable by plugins, and never reachable from the renderer.
- **The host binds loopback only** (127.0.0.1) and refuses connections without
  its per-launch token, verified in constant time. The out-of-process tool
  gateway communicates over a local Unix domain socket protected by file
  permissions (mode 0600).
- **Execution belongs to the agent.** HarnessDesk never runs an agent's
  commands, and deliberately declines ACP's `fs` and `terminal` client
  capabilities — a client that offers to execute is a client that must be
  trusted with it ([docs/architecture.md](docs/architecture.md)). The terminal
  beside a conversation runs through the agent, under the agent's permissions.
- **Plugins are isolated.** Installed plugin code runs in a supervised child
  process behind a versioned protocol, with capability-scoped grants
  (`ctx.fs`, `ctx.http`, `ctx.shell`, `ctx.browser`) shown before install. A
  plugin's filesystem handle cannot leave the open workspace root. Hooks in a
  dead or unresponsive plugin host fail closed (verdict: deny).
- **Agent output is untrusted.** Transcripts and tool outputs can contain
  arbitrary markup. Everything rendered passes through an allowlist HTML
  sanitizer that strips scripts and dangerous elements with their contents,
  validates URL schemes, and opens links externally with `noopener noreferrer`.
  The renderer runs sandboxed with no Node integration. Plugin UI arrives
  purely as declarative data; plugin code never executes in the renderer.
- **Nothing phones home.** No telemetry, no remote crash reporting. Crashes
  are written locally (`~/.harnessdesk/logs/crashes/`) and ship only in the
  diagnostics bundle you choose to save (**Settings → General → Save
  bundle**) — with credential shapes, open workspace roots, and your home
  directory scrubbed before writing.

A report that shows any of those sentences to be false is exactly the report
we want.

## Worker configuration and git publication

Gateway writes do not execute in the worker checkout. The host imports an
exact reviewed commit and tree into its private bare mirror, validates the
objects and pushes an explicit branch refspec to the host's pinned HTTPS
repository, with a lease. Worker `remote.*`, `insteadOf`, `pushInsteadOf`,
credential helpers, askpass programs, hooks and transfer configuration cannot
redirect that push or run with the gateway credential. The host's one-shot
helper consults the person's credentials from outside every checkout; forge
mutations run in host state with an explicit repository. The first approved
push pins the destination, and later origin mismatches refuse publication.

The local steering socket has separate steering-only caller tokens. These
are not general tool or MCP invocation tokens, and the stand-in strips desk
tool tokens from real-binary children. An unresolved alias or unsupported
mutation refuses in Ask/Always modes. Forge body-file reads occur only after
admission, are restricted to regular files inside the checkout, use
nonblocking opens and are capped at 64 KiB. Closing a waiting caller withdraws
its question and prevents the later write.

Steering is not a second agent sandbox. An agent can use an absolute binary
or another shell environment; concrete successful bypasses produce a warning
and an outside observation rather than a guessed attribution. Forge reads
still run through the built-in plugin's shell grant and can access the
person's write-capable gh login. The gateway's isolated credential path does
not remove that ambient access. Hash chains detect damaged record files;
they do not defend against a malicious process already able to rewrite all
of the same user's host state. See [the gateway architecture](docs/architecture.md#the-git-gateway).

## Out of scope

- **Upstream agent vulnerabilities.** Flaws inside Codex, Claude Code,
  Cursor, DeepSeek Harness, or other ACP backends belong upstream to their
  respective vendors.
- **Third-party plugin logic.** Defects inside a plugin belong to its author.
  A failure in the *isolation around* a plugin — an ungranted capability,
  reading files outside the workspace, or surviving host termination — is
  ours.
- **Local user compromise.** Vulnerabilities that require prior code execution
  as the logged-in user, or physical access to an unlocked machine. If an
  attacker can already read your files or run commands as your user,
  HarnessDesk's loopback token and file permissions are not the barrier.

## Supported versions

The latest release only. While HarnessDesk is in 0.x developer preview,
security fixes ship in the next release; there are no backports to older
versions.

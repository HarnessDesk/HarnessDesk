# ACP permission controls and dependency refresh

## Problem

Cline exposes its ACP permission setting as a boolean `auto_approve` session
config option. HarnessDesk currently accepts the option as an arbitrary ACP
config value, but it does not identify it as a permission control in the
composer. The issue is that a user can select an auto-approval mode yet still
reach the ordinary approval surface for covered tool calls.

The repository also has multiple ACP implementations: the shared generic
adapter used by Cline and other installed ACP agents, the official Claude ACP
bridge, and the local Cursor bridge. Their shared behavior needs regression
coverage even though only the Claude bridge directly depends on the official
TypeScript ACP SDK.

The behavior to preserve is the runtime contract: when Cline reports
`auto_approve: true`, HarnessDesk must send the boolean through
`session/set_config_option` and reflect the value returned by Cline; when it is
false, permission requests must remain human-gated. Other ACP runtimes and
other unknown options must keep their current behavior.

## Design

The generic ACP adapter will classify Cline's standard `auto_approve` option as
HarnessDesk's `_permissions` category while leaving the ACP option id and
boolean value unchanged. This puts the existing option in the composer's
permission control without adding a Cline-specific renderer or a new protocol
wire method. The existing generic `AcpSession.setOption` path will continue to
validate the boolean and call ACP `session/set_config_option`.

The adapter test fixture will expose an `auto_approve` boolean option and record
the setting used when a permission request is generated. Tests will cover the
red/green path for the option category and round-trip behavior, including that
turns still request approval when the option is false and do not request it
when it is true. Existing Claude and Cursor fixtures will assert that their
agent-specific options and permission behavior continue to use the same shared
adapter contract. A focused UI test will assert that a permission-category
boolean is rendered in the permissions control and invokes the normal option
setter.

The Claude bridge will refresh its compatible transitive dependencies to the
current registry versions: `@anthropic-ai/claude-agent-sdk` 0.3.272 and
`@modelcontextprotocol/sdk` 1.30.0. The official
`@agentclientprotocol/sdk` 1.4.0 and
`@agentclientprotocol/claude-agent-acp` 0.77.0 remain direct dependencies and
are not vendored because no upstream SDK patch is required.

No Claude bridge modes will be invented in this change: the current repository
does not expose those modes for Cline, and doing so would couple the fix to a
different runtime contract. No host policy, protocol wire method, or external
agent code will be changed. The local SDK copy requested as a contingency is
not added because the official stable SDK is already current and no SDK patch
is needed.

## Error handling and safety

The runtime remains authoritative. If Cline refuses a value, the existing ACP
error is surfaced and the current option state is retained. `auto_approve`
will not be silently enabled, rewritten as a string, or applied to an agent
that did not declare it. Human approval remains the fallback for false or
unknown permission states.

## Verification

1. Run the focused adapter and UI tests, observing the new regression test fail
   before implementation and pass afterward.
2. Run the relevant package typechecks/builds and the repository verification
   gate.
3. Launch the desktop app with an isolated fake-agent/Cline-compatible ACP
   profile, show the permission control, toggle auto-approval, and exercise a
   tool request so the transcript proves the prompt is suppressed when enabled
   and present when disabled.
4. Push the branch and open a PR whose description links issue #606, states the
   contract mismatch resolved, lists automated checks, and records the app
   verification result without including real account data or local paths.

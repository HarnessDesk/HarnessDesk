# Claude Agent ACP follow-ups

`packages/claude-acp` layers HarnessDesk's session controls over the official
Claude Agent ACP bridge, pinned at an exact version in
`packages/claude-acp/package.json` — `@agentclientprotocol/claude-agent-acp`
0.101.0 as of 2026-11-06, beside exact pins of the Claude Agent SDK
0.3.318, the ACP SDK 2.4.0 and the MCP SDK. There is no version range in that
list, so nothing
moves until someone bumps it. The migration to the official bridge is verified
against the scripted ACP peer. The following items are deliberately left as
follow-ups rather than hidden behind the compatibility layer:

- Prefer the standard native-subagent and async-task update types in the host protocol once their SDK types are stable; the current bridge also emits the existing HarnessDesk task/delegation extensions for older consumers.
- Add a versioned upstream migration contract for public replay hooks, raw-message provenance, and extension registration. The bridge currently opts into the official raw SDK-message callback (`emitRawSDKMessages`, read back as `_claude/sdkMessage` in `packages/claude-acp/src/bridge.ts`) only to preserve the existing task/delegation projections.
- Add live-provider acceptance coverage for compaction, auth transitions, and interruption ordering. The repository tests cover the wire and state transitions with the credential-free fake peer; they do not claim vendor-account parity.

## Version and capability check — 2026-11-06

The wrapper now matches the official 0.101.0 package's exact ACP and Claude
Agent SDK pins. Its Zod pin also matches upstream's 4.6.7: peer dependency
contexts otherwise create duplicate SDK instances even when their versions
match. The lockfile has one instance of each SDK for the bridge. Keep these
pins matched on future bumps. The repository's existing Zod override rewrites
SDK peer ranges to 4.6.6, so pnpm reports peer warnings for upstream's 4.6.7;
the scripted suites exercise that shared instance.

SDK 2.x keeps the v1 protocol but splits stable and unstable entrypoints.
The wrapper uses `@agentclientprotocol/sdk/unstable` for fork and provider
handlers; it already used the app API, so no legacy connection class remains.
`packages/adapter-acp/src/executable.ts` only mentions the package in its documentation;
the adapter has no ACP SDK import or dependency to migrate.

The adapter exposes `session/fork` when the agent advertises
`agentCapabilities.sessionCapabilities.fork`. Forks retain the source's
completed displayed history and read ceiling and receive their own tool caller,
attachment preparation and connection ownership. A running source must finish
before it can be forked.

Steering uses `_session/steering`, negotiated through initialize's
`_meta.steering.supported`. It opts into `promptRequired` so a turn that ended
just before injection gets a new host-tracked prompt. Goals use `_session/goal`
and the versioned `_meta.jetbrains.air.goal` declaration (set and clear), with
state updates mapped to the host goal model. These two extensions advertise in
initialize's `_meta`, rather than `agentCapabilities`; no agent identity gate is
used. Idle goal commands own tracked turns too.

The installed source has `/mcp` status/reconnect/enable/disable chat commands,
but advertises no structured MCP-status listing. MCP management stays off, and the generic ACP loadout fallback continues to
report MCP as unavailable. The bridge-specific context loadout is unchanged. `/compact` can be sent as a command, but has no
advertised on-demand compaction control; automatic compaction updates are a
different contract. Undo, per-conversation memory switching, detached review,
hook inventory and account quota/balance reporting also lack advertised control
contracts, so those capability flags stay off. Prompt token/cost usage is
already reported and does not establish an account balance.

`packages/adapter-acp/test/session-capabilities.test.ts` tests the negotiated
controls and refusals against the scripted ACP peer. The bundled bridge tests
exercise steering, goal set/clear and a guarded fork through the real SDK and
fake Claude CLI. These are credential-free wire and lifecycle proofs; no new
live-provider or native UI parity is claimed.

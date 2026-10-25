# Claude Agent ACP follow-ups

`packages/claude-acp` layers HarnessDesk's session controls over the official
Claude Agent ACP bridge, pinned at an exact version in
`packages/claude-acp/package.json` — `@agentclientprotocol/claude-agent-acp`
0.85.1 as of 2026-10-25, beside exact pins of the Claude Agent SDK, the ACP SDK
and the MCP SDK. There is no version range anywhere in that list, so nothing
moves until someone bumps it. The migration to the official bridge is verified
against the scripted ACP peer. The following items are deliberately left as
follow-ups rather than hidden behind the compatibility layer:

- Prefer the standard native-subagent and async-task update types in the host protocol once their SDK types are stable; the current bridge also emits the existing HarnessDesk task/delegation extensions for older consumers.
- Add a versioned upstream migration contract for public replay hooks, raw-message provenance, and extension registration. The bridge currently opts into the official raw SDK-message callback (`emitRawSDKMessages`, read back as `_claude/sdkMessage` in `packages/claude-acp/src/bridge.ts`) only to preserve the existing task/delegation projections.
- Add live-provider acceptance coverage for compaction, auth transitions, and interruption ordering. The repository tests cover the wire and state transitions with the credential-free fake peer; they do not claim vendor-account parity.
- Recheck the pins against the official package's own on every bump. The official package pins its SDKs exactly too, and they need not match ours: at 0.85.1 it pins the Claude Agent SDK at 0.3.286 and the ACP SDK at 1.6.0 while `packages/claude-acp` pins 0.3.288 and 1.7.0, so the lockfile carries two copies of each and the bridge's own code and the official package run on different ones.

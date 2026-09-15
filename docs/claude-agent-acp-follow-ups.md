# Claude Agent ACP follow-ups

The 0.77.0 migration is complete and verified against the scripted ACP peer. The following items are deliberately left as follow-ups rather than hidden behind the compatibility layer:

- Prefer the standard native-subagent and async-task update types in the host protocol once their SDK types are stable; the current bridge also emits the existing HarnessDesk task/delegation extensions for older consumers.
- Add a versioned upstream migration contract for public replay hooks, raw-message provenance, and extension registration. The bridge currently opts into the official raw SDK-message callback only to preserve the existing task/delegation projections.
- Add live-provider acceptance coverage for compaction, auth transitions, and interruption ordering. The repository tests cover the wire and state transitions with the credential-free fake peer; they do not claim vendor-account parity.
- Recheck the peer dependency floor when the official Claude Agent ACP package changes its Claude Agent SDK or MCP SDK range.

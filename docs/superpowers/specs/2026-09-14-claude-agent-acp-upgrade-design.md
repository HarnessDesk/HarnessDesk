# Claude Agent ACP 0.77.0 Migration Design

## Goal

Move HarnessDesk from the deprecated `@zed-industries/claude-code-acp@0.16.2` bridge to the official `@agentclientprotocol/claude-agent-acp@0.77.0`, while preserving HarnessDesk-specific controls and exposing the official ACP capabilities that the existing protocol already models.

## Decisions

- Pin the production dependency to `@agentclientprotocol/claude-agent-acp@0.77.0`; do not use a preview tag or a floating range.
- Keep the local HarnessDesk bridge during the first migration. This preserves effort, autocompact, output-style, replay, task, delegation, and state-directory behavior while the upstream API changes are absorbed.
- Replace old/deep imports with public upstream exports wherever possible. If a required extension has no public seam, isolate it behind one HarnessDesk adapter module and add an upstream follow-up rather than spreading private imports.
- Extend generic ACP transport and adapter behavior only for negotiated standard features: elicitation, auth status, compaction, forks, goals, native subagents, and async tasks.
- Keep filesystem and terminal client capabilities disabled until HarnessDesk has an explicit permission and sandbox design for them.
- Advertise a runtime capability only after a fake-agent test and a live packaged-surface smoke test demonstrate the complete lifecycle.

## Data flow

The Claude package owns the official bridge process and Claude SDK session. The HarnessDesk ACP transport remains the only renderer-facing boundary. Standard ACP notifications are decoded by `packages/transport-acp`, normalized by `packages/adapter-acp`, and mapped to the existing protocol items and runtime capabilities. HarnessDesk-specific task and delegation extensions remain fallback paths for peers that do not negotiate the standard feature.

AskUserQuestion and MCP form elicitation use the existing approval surface through an ACP client request. Replay sanitization stays upstream-owned; HarnessDesk must verify it end to end without double-stripping normal user text.

## Error handling

- Unsupported optional ACP requests return a structured unsupported response and do not claim the capability.
- Permission and elicitation cancellation must preserve cancellation semantics and never silently approve.
- Malformed or unknown session updates are logged and ignored where the ACP contract permits, while typed session failures become visible notices.
- Session fork, compaction, subagent, and background-task state must reconcile on resume/load instead of creating duplicate items.

## Testing

Use the existing scripted fake Claude peer. Add red-green tests for the new public bridge wiring, replay behavior, elicitation, tool identity, auth status, compaction/usage, forks/goals, and subagent/task lifecycle. Finish with the full unpiped `pnpm verify` gate plus a packaged HarnessDesk smoke check when launchable.

## Upstream follow-ups

Propose upstream support for a public session/event extension API, provenance-aware replay sanitization, typed handling of `[Request interrupted by user]`, and migration/contract tests for the 0.16-to-0.77 API transition.

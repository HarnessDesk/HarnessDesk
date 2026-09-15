# Claude Agent ACP 0.77.0 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade HarnessDesk to the official Claude Agent ACP 0.77.0 bridge and expose verified standard ACP capabilities without losing current HarnessDesk controls.

**Architecture:** Keep `packages/claude-acp` as a thin compatibility layer during the migration, but replace deprecated/deep upstream imports with public 0.77.0 APIs. Extend `packages/transport-acp` and `packages/adapter-acp` only for negotiated standard ACP features, preserving HarnessDesk-specific task/delegation extensions as fallbacks.

**Tech Stack:** TypeScript, pnpm workspaces, Node 22, ACP SDK 1.4.0, Claude Agent SDK 0.3.270, `node:test`, Vitest, scripted fake ACP peers.

## Global Constraints

- Pin `@agentclientprotocol/claude-agent-acp` to `0.77.0`; do not use preview or floating versions.
- Do not retain `@zed-industries/claude-code-acp` or imports from its private `dist/*` modules.
- Do not advertise a runtime capability without a passing lifecycle test.
- Keep filesystem and terminal ACP client capabilities disabled.
- Preserve unrelated dirty work and make local commits only; do not push or publish.
- Run `pnpm verify` unpiped before claiming completion.

---

### Task 1: Record the migration baseline and dependency contract

**Files:**
- Modify: `packages/claude-acp/package.json`
- Modify: `pnpm-lock.yaml`
- Test: `packages/claude-acp/test/claude-acp.test.ts`

**Interfaces:**
- Produces the exact package contract used by the bridge migration tasks.

- [ ] **Step 1: Write the failing dependency-contract test**

Add a test that reads the package manifest and asserts the official package, ACP SDK, and Claude SDK versions are exactly `0.77.0`, `1.4.0`, and `0.3.270`, and that the deprecated package is absent.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm --filter @harnessdesk/claude-acp test -- claude-acp.test.ts`

Expected: FAIL because the manifest still names `@zed-industries/claude-code-acp@0.16.2` and the old SDK versions.

- [ ] **Step 3: Update the dependency manifest and lockfile**

Replace the three old dependencies with the official package and its 0.77.0 dependency versions. Refresh the lockfile with `pnpm install --lockfile-only` and confirm the deprecated package no longer resolves.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm --filter @harnessdesk/claude-acp test -- claude-acp.test.ts`

Expected: the dependency-contract assertion passes; API compilation failures are handled in the next task.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-acp/package.json pnpm-lock.yaml packages/claude-acp/test/claude-acp.test.ts
git commit -m "build: migrate Claude ACP dependency"
```

### Task 2: Port the bridge entry point to the official public API

**Files:**
- Modify: `packages/claude-acp/src/main.ts`
- Modify: `packages/claude-acp/src/bridge.ts`
- Modify: `packages/claude-acp/src/index.ts`
- Test: `packages/claude-acp/test/claude-acp.test.ts`

**Interfaces:**
- Consumes the official `ClaudeAcpAgent`, `runAcp`, settings utilities, stream helpers, and public tool/session exports.
- Produces a HarnessDesk ACP process that initializes over ACP 1.4.0 and retains the existing custom HarnessDesk client extensions.

- [ ] **Step 1: Add a failing initialization test against the new public bridge contract**

Extend the fake-peer test to start the bridge with the official ACP client connection and assert that initialization succeeds, the agent info is present, and HarnessDesk’s custom capabilities remain in `_meta`.

- [ ] **Step 2: Run the test to verify the old wiring fails**

Run: `pnpm --filter @harnessdesk/claude-acp test -- claude-acp.test.ts`

Expected: TypeScript or runtime failure from the removed `AgentSideConnection`/old `serve` shape.

- [ ] **Step 3: Replace old wiring with public exports**

Port `main.ts` to the 0.77.0 settings functions. Replace the old `AgentSideConnection` construction and deep imports in `bridge.ts` with the public ACP client/connection and official stream helpers. Keep HarnessDesk’s process-level stderr routing and state-directory behavior.

- [ ] **Step 4: Run the bridge tests and fix only compatibility failures**

Run: `pnpm --filter @harnessdesk/claude-acp test -- claude-acp.test.ts`

Expected: initialization, prompt, cancellation, and existing replay tests pass; remaining failures identify behavior that must be ported in Task 3.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-acp/src packages/claude-acp/test/claude-acp.test.ts
git commit -m "refactor: use official Claude ACP public API"
```

### Task 3: Preserve session options and replay behavior

**Files:**
- Modify: `packages/claude-acp/src/bridge.ts`
- Modify: `packages/claude-acp/src/main.ts`
- Test: `packages/claude-acp/test/claude-acp.test.ts`
- Test: `packages/claude-acp/test/instructions.test.ts`

**Interfaces:**
- Produces stable HarnessDesk session configuration for effort, autocompact, output style, instructions, and state persistence.

- [ ] **Step 1: Add failing regression tests**

Cover: effort is forwarded through the new config API, output style and autocompact remain effective, managed settings still load, replayed string and content-array system reminders are omitted, and reminder-only replay does not create an empty user item.

- [ ] **Step 2: Run the regression tests to verify the missing behavior**

Run: `pnpm --filter @harnessdesk/claude-acp test -- claude-acp.test.ts instructions.test.ts`

Expected: failures identify old session option names, replay event shapes, or duplicate sanitization.

- [ ] **Step 3: Implement the minimal compatibility mapping**

Use the official session configuration and replay flow. Keep only a narrowly scoped HarnessDesk notification filter where upstream does not already sanitize. Do not forward the removed `claudeCode.options.agent` option.

- [ ] **Step 4: Run all Claude bridge tests**

Run: `pnpm --filter @harnessdesk/claude-acp test`

Expected: all existing and new session/replay tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-acp/src packages/claude-acp/test
git commit -m "fix: preserve Claude session options and replay semantics"
```

### Task 4: Add negotiated elicitation and permission handling

**Files:**
- Modify: `packages/transport-acp/src/index.ts`
- Modify: `packages/adapter-acp/src/runtime.ts`
- Modify: `packages/adapter-acp/src/runtime.ts`
- Test: `packages/adapter-acp/test/acp.test.ts`
- Test: `packages/claude-acp/test/ask-user.test.ts`
- Modify: `packages/claude-acp/test/fixtures/fake-claude.mjs`

**Interfaces:**
- Produces typed handling for ACP form elicitation and preserves cancellation/denial semantics through the existing approval UX.

- [ ] **Step 1: Add failing tests for form elicitation**

Have the fake Claude peer issue an elicitation request and assert that HarnessDesk emits the approval request, returns the submitted form values, and returns a denial/cancellation when the user rejects it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @harnessdesk/adapter-acp test -- runtime.test.ts && pnpm --filter @harnessdesk/claude-acp test -- ask-user.test.ts`

Expected: unknown request or unsupported capability failure.

- [ ] **Step 3: Implement typed transport and runtime routing**

Advertise only the form elicitation capability that HarnessDesk can render. Route `elicitation/create` through the existing permission/approval request path, preserve request IDs, and return explicit reject/cancel results. Leave filesystem and terminal capabilities false.

- [ ] **Step 4: Run focused tests**

Run: `pnpm --filter @harnessdesk/adapter-acp test -- runtime.test.ts && pnpm --filter @harnessdesk/claude-acp test -- ask-user.test.ts`

Expected: approve, reject, cancel, and unsupported-form cases pass.

- [ ] **Step 5: Commit**

```bash
git add packages/transport-acp packages/adapter-acp packages/claude-acp/test
git commit -m "feat: support ACP elicitation requests"
```

### Task 5: Map standard Claude ACP lifecycle features

**Files:**
- Modify: `packages/transport-acp/src/index.ts`
- Modify: `packages/adapter-acp/src/runtime.ts`
- Modify: `packages/protocol/src/runtime.ts`
- Modify: `packages/protocol/src/items.ts`
- Test: `packages/adapter-acp/test/acp.test.ts`
- Test: `packages/claude-acp/test/claude-acp.test.ts`
- Modify: `packages/claude-acp/test/fixtures/fake-claude.mjs`

**Interfaces:**
- Produces normalized updates for auth status, tool identity, usage/compaction, session forks/goals, native subagents, async tasks, and typed session failures.

- [ ] **Step 1: Add one failing contract test per lifecycle family**

Add fixture events and assertions for: named tool calls, auth status update, compaction begin/end plus usage, fork/goal capability negotiation, nested subagent transcript, async task completion, and typed session failure.

- [ ] **Step 2: Run the tests to verify missing mappings**

Run: `pnpm --filter @harnessdesk/adapter-acp test -- runtime.test.ts && pnpm --filter @harnessdesk/claude-acp test -- claude-acp.test.ts`

Expected: events are currently ignored or capabilities remain false.

- [ ] **Step 3: Implement normalized update mapping**

Decode only known standard ACP shapes, map them to existing `SubagentItem`, `CompactionItem`, usage, notice, and runtime capability structures, and reconcile resume/load without duplicate items. Keep custom HarnessDesk task/delegation updates as fallback paths.

- [ ] **Step 4: Run focused and package tests**

Run: `pnpm --filter @harnessdesk/adapter-acp test -- runtime.test.ts && pnpm --filter @harnessdesk/claude-acp test`

Expected: all lifecycle tests pass and unsupported peers remain compatible.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol packages/transport-acp packages/adapter-acp packages/claude-acp/test
git commit -m "feat: map standard Claude ACP lifecycle updates"
```

### Task 6: Remove obsolete compatibility code and document upstream follow-ups

**Files:**
- Modify: `packages/claude-acp/src/bridge.ts`
- Modify: `packages/claude-acp/src/index.ts`
- Modify: `packages/claude-acp/package.json`
- Modify: `docs/architecture.md`
- Modify: `docs/agent-capabilities.md`
- Create: `docs/claude-agent-acp-follow-ups.md`
- Test: `packages/claude-acp/test/*.test.ts`

**Interfaces:**
- Produces a bridge with no deprecated package/deep import references and documentation that distinguishes verified capabilities from planned upstream work.

- [ ] **Step 1: Add a failing source-contract test**

Assert that package source contains no `@zed-industries/claude-code-acp` reference, no private upstream `dist/*` import, and no stale `claudeCode.options.agent` forwarding.

- [ ] **Step 2: Run the contract test to verify it fails**

Run: `pnpm --filter @harnessdesk/claude-acp test -- claude-acp.test.ts`

Expected: the old references are found before cleanup.

- [ ] **Step 3: Remove obsolete code and write the follow-up note**

Delete dead compatibility paths, update architecture/capability matrices with only tested claims, and document the upstream requests for public extension hooks, provenance-aware replay, interruption markers, and migration contracts.

- [ ] **Step 4: Run package tests and static checks**

Run: `pnpm --filter @harnessdesk/claude-acp test && pnpm typecheck && pnpm layering`

Expected: exit 0 with no stale package/deep-import contract failures.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-acp docs/architecture.md docs/agent-capabilities.md docs/claude-agent-acp-follow-ups.md
git commit -m "docs: record Claude ACP capability parity and follow-ups"
```

### Task 7: Full verification and computer smoke test

**Files:**
- No planned source changes; update tests only if a concrete verification defect is found.

**Interfaces:**
- Verifies the complete migration at repository and app boundaries.

- [ ] **Step 1: Run the complete repository gate**

Run: `pnpm verify`

Expected: exit 0; run it unpiped and record the complete output.

- [ ] **Step 2: Run the packaged/local HarnessDesk smoke path**

Launch the local HarnessDesk build with the scripted fake-agent rig, then verify new session, prompt, tool call, approval, replay, cancellation, task completion, and account display using the computer surface. Do not use a real account or publish screenshots.

- [ ] **Step 3: Reconcile capability claims with evidence**

Compare the acceptance transcript with `docs/agent-capabilities.md`; remove any capability claim without a passing test and live smoke observation.

- [ ] **Step 4: Inspect final state**

Run: `git status --short --branch && git diff HEAD~7..HEAD --stat`

Expected: only the migration, tests, docs, and local commits are present; no unrelated changes or credentials appear.

- [ ] **Step 5: Commit final evidence if needed**

```bash
git add docs/agent-capabilities.md
git commit -m "test: record Claude ACP verification evidence"
```

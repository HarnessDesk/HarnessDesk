# Reveal Searched Sessions in the Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Make a session opened from search appear, expand, highlight, and scroll into view in the sidebar.

**Architecture:** Complete the renderer’s canonical \`history\` projection in \`AppStore.openSession\` after the authoritative \`session/read\`. Keep grouping and persisted folding in \`SessionTree\`; an effect reveals only the active session’s project and preview row, while the existing row marker and scroll behavior provide final focus.

**Tech Stack:** TypeScript, React 18, Vitest/jsdom, pnpm, Electron/dev desktop, CDP.

## Global Constraints

- Codex types never leave \`packages/adapter-codex\`; this change is renderer-only.
- The renderer talks to the host through the existing transport and must not add runtime-specific behavior.
- Use runtime-plus-session identity via \`sessionKey(runtime, id)\` for deduplication.
- Use existing \`listPrefs\`, \`setProjectsCollapsed\`, \`setOthersOpen\`, and design conventions; add no new preference shape.
- Tests and screenshots use placeholder identities and the repository’s fake-agent/screenshot rig only.

---

### Task 1: Add a failing store regression for searched-session history insertion

**Files:**
- Modify: \`packages/ui/src/state/store.sessions.test.ts\`
- Modify: \`packages/ui/src/state/store.ts\`

**Interfaces:**
- Consumes: \`AppStore.openSession(id, { runtime })\`, \`Session\`, \`SessionSummary\`, \`sessionKey\`.
- Produces: \`snapshot.history\` contains the opened session’s summary exactly once after \`session/read\` succeeds.

- [ ] **Step 1: Write the failing test**

Add a \`searched session history\` describe block in \`store.sessions.test.ts\`. Use a session id not present in the initial history, answer \`session/read\` and \`session/resume\` with that session, call \`openSession\`, and assert the history row contains the runtime, id, title, cwd, status, timestamps, and git metadata. Call \`openSession\` a second time and assert the matching runtime/id occurs once.

\`\`\`ts
it('adds a searched session to history once it is opened', async () => {
  const searched = session({
    id: sessionId('searched'),
    title: 'Found from search',
    cwd: '/searched-project',
    updatedAt: 20,
  })
  answers['session/read'] = searched
  answers['session/resume'] = searched

  await store.openSession(searched.id, { runtime: RUNTIME })
  await store.openSession(searched.id, { runtime: RUNTIME })

  const rows = store.getSnapshot().history.filter(
    (row) => row.runtime === RUNTIME && row.id === searched.id,
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    id: searched.id,
    runtime: RUNTIME,
    title: 'Found from search',
    cwd: '/searched-project',
    updatedAt: 20,
  })
})
\`\`\`

- [ ] **Step 2: Run the focused test and verify RED**

Run: \`pnpm --filter @harnessdesk/ui exec vitest run src/state/store.sessions.test.ts -t "adds a searched session"\`

Expected: FAIL because \`openSession\` currently updates \`sessions\` and layout but leaves \`history\` empty.

- [ ] **Step 3: Implement the minimal history projection**

Add a private store helper near the history/session methods that converts a loaded \`Session\` to a \`SessionSummary\` using its list-visible fields, checks \`(runtime, id)\` with \`sessionKey\`, and patches \`history\` only when absent. Keep existing summaries unchanged and sort the resulting list by descending \`updatedAt\`. Invoke it immediately after the successful \`session/read\` and before \`session/resume\`.

\`\`\`ts
const summaryOf = (session: Session): SessionSummary => ({
  id: session.id,
  runtime: session.runtime,
  title: session.title ?? null,
  preview: session.preview ?? null,
  cwd: session.cwd,
  status: session.status,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  git: session.git ?? null,
  repo: null,
  archived: session.archived ?? false,
})
\`\`\`

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same Vitest command. Expected: PASS with one history row.

- [ ] **Step 5: Commit the store change**

\`\`\`bash
git add packages/ui/src/state/store.ts packages/ui/src/state/store.sessions.test.ts
git commit -m "fix(ui): retain sessions opened from search"
\`\`\`

### Task 2: Reveal the active session’s project and row in the tree

**Files:**
- Modify: \`packages/ui/src/components/SessionTree.tsx\`
- Modify: \`packages/ui/src/components/SessionTree.test.tsx\`

**Interfaces:**
- Consumes: \`snapshot.activeSessionKey\`, \`useProjectGroups()\`, \`snapshot.listPrefs\`, \`store.toggleCollapsed\`, \`store.setOthersOpen\`.
- Produces: An active session’s project is open, its \`Other projects\` section is visible when necessary, and its five-row preview is expanded when necessary.

- [ ] **Step 1: Write the failing tree tests**

Extend the existing \`treeWith\` test helper to accept \`activeSessionKey\` and add tests for a collapsed project, a far project with \`othersOpen: false\`, and a sixth session in the target project. Assert that the target row is rendered and active after a rerender; assert the store methods receive the reveal requests where the test harness uses mocked store methods.

\`\`\`tsx
it('reveals the active session in a collapsed project and beyond the five-row preview', () => {
  const active = summary({ id: 'session-6', updatedAt: 6 })
  const sessions = [
    ...Array.from({ length: 5 }, (_, index) =>
      summary({ id: \`session-\${index + 1}\`, updatedAt: index + 1 }),
    ),
    active,
  ]
  const { container: tree, store } = treeWith([], sessions, [], {
    collapsed: ['/repo'],
    othersOpen: false,
  }, {
    path: '/other', name: 'other', lastOpenedAt: 1,
  })
  const snapshot = store.getSnapshot()
  ;(snapshot as AppSnapshot).activeSessionKey = sessionKey('codex', sessionId('session-6'))
  act(() => root.render(
    <StoreProvider store={store}>
      <SessionTree now={3} />
    </StoreProvider>,
  ))

  expect(tree.textContent).toContain('session-6')
  expect(store.toggleCollapsed).toHaveBeenCalledWith('/repo')
  expect(store.setOthersOpen).toHaveBeenCalledWith(true)
})
\`\`\`

The test fixture must keep the active project as the far group so it exercises the \`Other projects\` path separately; add a focused test for a far project if the combined fixture cannot express both transitions without obscuring the assertion.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: \`pnpm --filter @harnessdesk/ui exec vitest run src/components/SessionTree.test.tsx -t "reveals the active session"\`

Expected: FAIL because the existing tree only renders collapsed groups and the first five loose sessions.

- [ ] **Step 3: Implement reveal derivation and effect**

In \`SessionTree\`, derive the active session’s group and whether it is hidden by the local preview. On active-key/group changes, call \`toggleCollapsed\` for a collapsed project, \`setOthersOpen(true)\` for a far project, and add the group root to the local \`expanded\` set when the active session is not among the first \`COLLAPSED_LIMIT\` loose sessions. Guard each action so the effect is idempotent and does not rewrite already-open preferences.

Keep the implementation aligned with the existing \`renderGroup\` room membership calculation; extract a small local helper if needed rather than duplicating a subtly different membership rule. Do not alter \`SessionRow\`’s \`data-active\` or scroll effect.

- [ ] **Step 4: Run the focused tree tests and verify GREEN**

Run: \`pnpm --filter @harnessdesk/ui exec vitest run src/components/SessionTree.test.tsx -t "reveals the active session"\`

Expected: PASS, with the target project and session row rendered.

- [ ] **Step 5: Run the related UI suite**

Run: \`pnpm --filter @harnessdesk/ui exec vitest run src/components/SessionTree.test.tsx src/components/SessionTree.arrange.test.tsx src/components/SessionTree.projects.test.tsx src/state/store.sessions.test.ts\`

Expected: all tests pass with no console errors.

- [ ] **Step 6: Commit the tree change**

\`\`\`bash
git add packages/ui/src/components/SessionTree.tsx packages/ui/src/components/SessionTree.test.tsx
git commit -m "fix(ui): reveal active searched session"
\`\`\`

### Task 3: Full verification, desktop/CDP acceptance, and screenshot artifact

**Files:**
- Modify: \`CHANGELOG.md\` only if the repository’s release convention requires a user-facing entry for this bug fix.
- Create: screenshot artifact on the repository’s \`screenshots\` branch, using the existing \`script/shots\` workflow.

**Interfaces:**
- Consumes: completed store/tree behavior and the fake-agent/screenshot rig.
- Produces: fresh test evidence, a real app interaction recording, an anonymized screenshot, and a published PR linked to issue #668.

- [ ] **Step 1: Run the full repository gate**

Run unpiped: \`pnpm verify\`

Expected: exit code 0 and every listed gate passes.

- [ ] **Step 2: Run the app-level flow through computer-use or CDP**

Use the project’s fake-agent rig and dev/packaged app. Start the app with a history result outside the first loaded page, search for it via Command Palette, open the result, then inspect the fresh accessibility/DOM state and screenshot. Confirm:

\`\`\`text
the session row exists in the sidebar
the project group is open
Other projects is open when the project is far
the sixth-or-later row is rendered
the session row has data-active
the row scroll position contains the active row
\`\`\`

Do not use a real account or publish any real identity/path. Record the exact command or CDP script and its exit status in the final report.

- [ ] **Step 3: Capture and audit the screenshot**

Use the existing \`script/shots/seed.mjs\` and \`script/shots/shoot.mjs\` workflow on the \`screenshots\` branch. Read the resulting image manually and verify the sidebar, menu, names, emails, and paths contain only placeholders or the public demo persona. Do not add raw real-desk frames.

- [ ] **Step 4: Inspect the final diff and branch state**

Run:

\`\`\`bash
git status --short --branch
git diff origin/main...HEAD --check
git diff --stat origin/main...HEAD
git log --oneline --decorate -6
\`\`\`

Expected: only the design/plan docs, focused UI implementation/tests, and the approved screenshot artifact are present; no unrelated worktree changes are staged.

- [ ] **Step 5: Publish the PR**

Push the feature branch, create a PR for \`HarnessDesk/HarnessDesk\` resolving #668, and use a concise description with:

\`\`\`markdown
## Summary
- keep sessions opened from search in the sidebar history
- reveal collapsed/overflowing project groups and keep the active row visible

## Verification
- \`pnpm verify\`
- [exact app/CDP command and result]
- screenshot attached: [path or GitHub screenshot-branch link]

Fixes #668
\`\`\`

After publishing, read the PR metadata and body back from GitHub and report the URL, head SHA, verification evidence, and screenshot path.

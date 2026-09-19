# Phase 5 progress

Branch: `codex/agents-phase-5`
Base: `732bd8c0`

## Plan corrections

- Task 1 references phase-4 renderer modules `packages/ui/src/lib/board-facts.ts` and `packages/ui/src/lib/evidence.ts`. They are not present in the landed base. Current main is authoritative, so Task 1 shares the host/protocol rules now and leaves renderer integration to the later Goal board UI work rather than creating an unused duplicate surface.
- Coordinator confirmed Phase 4B is actively implementing those renderer prerequisites. Deliberate reordering: complete Task 1 protocol/host proof and other independent host work now; integrate Task 1 renderer re-exports and Task 2 `SeatRecordBlock` unknown-state copy only after Phase 4B lands, before dependent UI work or landing.
- Commit trailers use the brief's required `Co-authored-by: HarnessDesk Agent <agent@harnessdesk.app>` instead of the plan writer's stale trailer.

## Evidence

### Task 1 — Goal contract

- Red: `pnpm run build:node` exited 2 after dependencies were installed. TypeScript reported missing `Goal`, `GoalBoard`, `GoalReceipt`, `GoalSeatRequest`, `WrapPreview`, `activityOf`, `checkedDependencies`, `factsOfGoal`, and `membersOf` exports. The earlier setup-only failure (`tsc: command not found`) was not counted.
- Green: `pnpm run build:node && node --test --test-reporter=spec packages/server/dist/test/goal-model.test.js packages/protocol/dist/test/goal.test.js` exited 0; 11/11 tests passed.
- Mutation, restored-history membership guard: removed `&& !seat.restored`; the same production build plus `goal-model.test.js` exited 1 with 1 failed / 8 passed. `membership includes only open kept Seats on this Goal` received `['s1', 'restored']` instead of `['s1']`. Restored the guard and reran both suites: 11/11 passed, exit 0.
- Full `mkdir -p /tmp/hdv && TMPDIR=/tmp/hdv pnpm verify`: exit 0, `All checks passed.` Lockfile install, build, Node/gate/UI/desktop tests, layering, half-applied fixes, tracked secrets, reachable methods, notices, design tokens/drift/UI system/docs, interface drift, recorded claims, doc paths, CI parity, Codex protocol drift and documented-step checks all passed.
